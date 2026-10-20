import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { extractArtifact } from '@/lib/handoff'
import { reviewArtifact } from '@/lib/review-policy'
import { evolutionBudgetUsed, EVOLUTION_BUDGET_PER_HOUR } from '@/lib/evolution'
import { memoizedVerdict } from '@/lib/innovation'

// טיק-ריבונות (Task 43 + Task 45): POST /api/sovereign/ops/tick
// סריקה → פסק-דין (חוק review-policy) → פעולה אמיתית דרך השער הקיים
// (approve+execute עם כל-השערים שלהם: סריקת-סודות, אכיפת-hash, נתיבים-חדשים-בלבד,
// read-back) → חתימת-שרשרת AUDIT. הסף-לא-יורד-גם-כשהבעלים-ישן.
//
// לקח-Task 45: מסירה היא פעולת-גיט טהורה (approve→execute→PUT→read-back) —
// היא צורכת אפס תקציב-LLM. מגן-התקציב-הישן (שנגרר אחרי evolutionBudgetUsed)
// חסם-בפועל ניקוז-מלאי בשעות-שהתקציב-השעתי-מוצה — תיקון: מכסת-מסירות-לטיק
// עצמאית (קצב, לא תלות-בתקציב-אחר). תקציב-ה-LLM נשאר-מדווח-למעלה כמידע בלבד.
//
// Task 100-c — היגיינת-המלאי (רפואת-עורק-הריבונות): עד-עכשיו הטיק סרק רק PROPOSED,
// והשהיה לא שינתה-מצב — 14 העברות-חסומות-ביטחון (eval/child_process/wget) נסרקו-והושהו
// מחדש-כל-10 דק' לנצח, והעברה-אחת-מאושרת-נטושה-2-ימים (APPROVED-שלא-הגיעה-לביצוע)
// ו-FAILED-חולפים-נזרקו-מהמלאי. מעתה:
//   1. המלאי = PROPOSED + APPROVED-תקוע + RUNNING-מיושן(>10דק') + FAILED-חולף(ניסיונות<3).
//   2. השהיה = מונה-כן (suspendedCount) — 3 השהיות = REJECTED סופי (סיבות-נשמרות בשקיפות).
//   3. חילוץ = APPROVED/RUNNING-מיושן/FAILED-חולף מבוצעים-ישירות דרך-שער-execute
//      (claim-אטומי — אין-ביצוע-כפול; הסריקה-והסף-כבר-נאכפו-במסילות-הקיימות).

// קצב-מסירות-לטיק: 6 לטיק × 6 טיקים/שעה (עורק-ו כל 10 דק') = עד 36 מסירות-שעה
// — מנקז מלאי-אמת בקצב-מרוסן, בלי להציף את שער-הגיט.
export const MAX_DELIVERIES_PER_TICK = 6

// Task 100-c: חוק-ההשהיות — 3 פסקי-דין-השהיה-זהים = REJECTED סופי
export const MAX_SUSPENSIONS = 3
// Task 100-c: מחלקות-חולפות שזכאיות-לניסיון-ביצוע-חוזר (רק-הן; artifact-changed/secret-scan = קבועות)
export const RESCUEABLE_HANDOFF_CLASSES = ['provider', 'network', 'rate-limit', 'timeout'] as const
const MAX_HANDOFF_EXEC_ATTEMPTS = 3
const STALE_RUNNING_MS = 10 * 60 * 1000

export const dynamic = 'force-dynamic'

interface TickOutcome {
  id: string
  verdict: 'DELIVERABLE' | 'SUSPENDED' | 'SKIP'
  reasons: string[]
  approved: boolean
  executed: boolean
  status?: string
  commitSha?: string | null
  verified?: boolean | null
  cached?: boolean // Task 60: פסק-דין מוניז (זהה לטיק הקודם) — הבעלים רואה מה חדש מול ידוע
  rescued?: boolean // Task 100-c: נכלל מחילוץ-מלאי (APPROVED/RUNNING-מיושן/FAILED-חולף)
  rejected?: boolean // Task 100-c: הוכרז REJECTED בטיק-זה (3 השהיות)
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const origin = req.nextUrl.origin

  // Task 100-c: המלאי-האמיתי — לא רק PROPOSED. כל-יחידת-עבודה-תקפה-שנתקעה-במסילה זוכה-לניקוז.
  const stale = new Date(Date.now() - STALE_RUNNING_MS)
  const [pool, budgetUsed] = await Promise.all([
    db.handoff.findMany({
      where: {
        OR: [
          { status: 'PROPOSED' },
          { status: 'APPROVED' },
          { status: 'RUNNING', updatedAt: { lt: stale } },
          {
            status: 'FAILED',
            attempts: { lt: MAX_HANDOFF_EXEC_ATTEMPTS },
            errorClass: { in: [...RESCUEABLE_HANDOFF_CLASSES] },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
    }),
    evolutionBudgetUsed(),
  ])
  // מידע-בלבד (המסירות לא צורכות תקציב-זה) — נדווח בשקיפות מלאה
  const llmBudgetRemaining = Math.max(0, EVOLUTION_BUDGET_PER_HOUR - budgetUsed)

  const outcomes: TickOutcome[] = []
  let deliverableSeen = 0
  let rejectedCount = 0
  let rescueTried = 0
  let rescueDelivered = 0

  // Task 61: חיסול N+1 — שליפת-כל-המשימות של ההצעות בשאילתה אחת (במקום findUnique לכל-הצעה)
  const taskIds = [...new Set(pool.filter((h) => h.status === 'PROPOSED').map((h) => h.taskId))]
  const tasksForProposals = await db.task.findMany({
    where: { id: { in: taskIds } },
    select: { id: true, output: true },
  })
  const taskOutputById = new Map(tasksForProposals.map((t) => [t.id, t.output]))

  for (const h of pool) {
    // ===== מסילת-חילוץ (Task 100-c): APPROVED-תקוע / RUNNING-מיושן / FAILED-חולף =====
    // בלי-סריקה-חוזרת (הסף נאכף ב-execute: hash+סודות+read-back) — ישירות-לשער-הביצוע.
    if (h.status !== 'PROPOSED') {
      if (deliverableSeen >= MAX_DELIVERIES_PER_TICK) {
        outcomes.push({
          id: h.id,
          verdict: 'SKIP',
          reasons: [`delivery-cap:${MAX_DELIVERIES_PER_TICK}-per-tick`],
          approved: h.status === 'APPROVED',
          executed: false,
          rescued: true,
        })
        continue
      }
      deliverableSeen += 1
      rescueTried += 1
      const executeRes = await fetch(`${origin}/api/handoffs/${h.id}/execute`, { method: 'POST' })
      const ej = (await executeRes.json().catch(() => ({}))) as {
        handoff?: { status: string; commitSha: string | null; verified: boolean | null }
        error?: string
      }
      const ok = executeRes.ok && ej.handoff?.status === 'DONE'
      if (ok) rescueDelivered += 1
      outcomes.push({
        id: h.id,
        verdict: 'DELIVERABLE',
        reasons: [`rescue:${h.status}${ok ? '' : `→${ej.handoff?.status ?? executeRes.status}`}`],
        approved: h.status === 'APPROVED',
        executed: ok,
        status: ej.handoff?.status,
        commitSha: ej.handoff?.commitSha ?? null,
        verified: ej.handoff?.verified ?? null,
        rescued: true,
      })
      continue
    }

    // ===== מסילת-הביקורת הרגילה (PROPOSED) =====
    const code = extractArtifact(taskOutputById.get(h.taskId) ?? '', h.field)
    // Task 60 (מסילת-החדשות): reviewArtifact דטרמיניסטי — מוניז.
    // Task 61 תיקון-תקינות: המפתח כולל את hash-הקוד עצמו — שינוי-תוצר מבטל-מוניז.
    const v = memoizedVerdict(
      `${h.id}:${h.artifactHash ?? 'no-hash'}:${sha256Short(code ?? '')}`,
      () => reviewArtifact(code, h.artifactHash)
    )

    if (!v.deliverable) {
      // Task 100-c: השהיה = מונה-כן; 3 השהיות = REJECTED סופי (סיבות-נשמרות, אין-סריקה-אינסופית)
      const suspensions = h.suspendedCount + 1
      const reject = suspensions >= MAX_SUSPENSIONS
      await db.handoff.update({
        where: { id: h.id },
        data: {
          suspendedCount: suspensions,
          lastSuspendedAt: new Date(),
          ...(reject ? { status: 'REJECTED', error: v.reasons.join('; ').slice(0, 500), errorClass: 'review-policy' } : {}),
        },
      })
      if (reject) rejectedCount += 1
      outcomes.push({
        id: h.id,
        verdict: 'SUSPENDED',
        reasons: reject ? [...v.reasons, `rejected:suspensions-${suspensions}/${MAX_SUSPENSIONS}`] : v.reasons,
        approved: false,
        executed: false,
        cached: v.cached,
        rejected: reject,
      })
      continue
    }

    // מכסת-מסירות-לטיק (Task 45): קצב-עצמי, לא תלות בתקציב-LLM שלא נצרך.
    // העודף לא נעלם — הוא מקבל SKIP עם סיבה-כנה וימסר בטיק-הבא (עורק-ו כל 10 דק').
    if (deliverableSeen >= MAX_DELIVERIES_PER_TICK) {
      outcomes.push({
        id: h.id,
        verdict: 'SKIP',
        reasons: [`delivery-cap:${MAX_DELIVERIES_PER_TICK}-per-tick`],
        approved: false,
        executed: false,
      })
      continue
    }
    deliverableSeen += 1

    // הפעולה דרך השער הקיים — הטיק לא מקצר-דרך ולא מקל על הסף
    const approveRes = await fetch(`${origin}/api/handoffs/${h.id}/approve`, {
      method: 'POST',
    })
    if (!approveRes.ok) {
      outcomes.push({
        id: h.id,
        verdict: 'SKIP',
        reasons: [`approve-failed:${approveRes.status}`],
        approved: false,
        executed: false,
      })
      continue
    }
    const executeRes = await fetch(`${origin}/api/handoffs/${h.id}/execute`, {
      method: 'POST',
    })
    const ej = (await executeRes.json().catch(() => ({}))) as {
      handoff?: { status: string; commitSha: string | null; verified: boolean | null }
    }
    outcomes.push({
      id: h.id,
      verdict: 'DELIVERABLE',
      reasons: [],
      approved: true,
      executed: executeRes.ok && ej.handoff?.status === 'DONE',
      status: ej.handoff?.status,
      commitSha: ej.handoff?.commitSha ?? null,
      verified: ej.handoff?.verified ?? null,
    })
  }

  const delivered = outcomes.filter((o) => o.executed).length
  const suspended = outcomes.filter((o) => o.verdict === 'SUSPENDED').length
  const skipped = outcomes.filter((o) => o.verdict === 'SKIP').length
  const novelty = {
    newVerdicts: outcomes.filter((o) => o.cached === false).length,
    cachedVerdicts: outcomes.filter((o) => o.cached === true).length,
  }

  const report = {
    at: new Date().toISOString(),
    scanned: pool.length,
    delivered,
    suspended,
    skipped,
    rejected: rejectedCount, // Task 100-c: כמה הוכרזו REJECTED סופי בטיק-זה
    rescued: { tried: rescueTried, delivered: rescueDelivered }, // Task 100-c: חילוץ-מלאי-תקוע
    novelty, // Task 60: פסקי-דין חדשים מול מוניזים — הבזבזות-מדודה ונראה-לעין
    durationMs: Date.now() - t0,
    deliveryCap: MAX_DELIVERIES_PER_TICK,
    llmBudgetRemaining, // מידע-בלבד — לא מגביל מסירות (Task 45)
  }

  // חתימת-שרשרת על הטיק עצמו — ההחלטות נשמרות לנצח (אפס-מחיקה)
  await appendLedger({
    taskId: null,
    kind: 'AUDIT',
    status: 'DONE',
    worker: 'sovereignty-ops-tick',
    attempts: 1,
    durationMs: report.durationMs,
    errorClass: null,
    outputHash: sha256Short(JSON.stringify({ report, outcomes })),
  })

  return NextResponse.json({ ok: true, tick: report, outcomes })
}
