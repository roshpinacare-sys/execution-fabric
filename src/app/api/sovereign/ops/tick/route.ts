import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { extractArtifact } from '@/lib/handoff'
import { reviewArtifact } from '@/lib/review-policy'
import { evolutionBudgetUsed, EVOLUTION_BUDGET_PER_HOUR } from '@/lib/evolution'

// טיק-ריבונות (Task 43 + Task 45): POST /api/sovereign/ops/tick
// סריקה → פסק-דין (חוק review-policy) → פעולה אמיתית דרך השער הקיים
// (approve+execute עם כל-השערים שלהם: סריקת-סודות, אכיפת-hash, נתיבים-חדשים-בלבד,
// read-back) → חתימת-שרשרת AUDIT. הסף-לא-יורד-גם-כשהבעלים-ישן.
//
// לקח-Task 45: מסירה היא פעולת-גיט טהורה (approve→execute→PUT→read-back) —
// היא צורכת אפס תקציב-LLM. מגן-התקציב-הישן (שנגרר אחרי evolutionBudgetUsed)
// חסם-בפועל ניקוז-מלאי בשעות-שהתקציב-השעתי-מוצה — תיקון: מכסת-מסירות-לטיק
// עצמאית (קצב, לא תלות-בתקציב-אחר). תקציב-ה-LLM נשאר-מדווח-למעלה כמידע בלבד.

// קצב-מסירות-לטיק: 6 לטיק × 6 טיקים/שעה (עורק-ו כל 10 דק') = עד 36 מסירות-שעה
// — מנקז מלאי-אמת בקצב-מרוסן, בלי להציף את שער-הגיט.
export const MAX_DELIVERIES_PER_TICK = 6

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
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const origin = req.nextUrl.origin

  const [proposed, budgetUsed] = await Promise.all([
    db.handoff.findMany({ where: { status: 'PROPOSED' }, orderBy: { createdAt: 'asc' } }),
    evolutionBudgetUsed(),
  ])
  // מידע-בלבד (המסירות לא צורכות תקציב-זה) — נדווח בשקיפות מלאה
  const llmBudgetRemaining = Math.max(0, EVOLUTION_BUDGET_PER_HOUR - budgetUsed)

  const outcomes: TickOutcome[] = []
  let deliverableSeen = 0

  for (const h of proposed) {
    const task = await db.task.findUnique({ where: { id: h.taskId } })
    const code = extractArtifact(task?.output ?? '', h.field)
    const v = reviewArtifact(code, h.artifactHash)

    if (!v.deliverable) {
      outcomes.push({
        id: h.id,
        verdict: 'SUSPENDED',
        reasons: v.reasons,
        approved: false,
        executed: false,
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

  const report = {
    at: new Date().toISOString(),
    scanned: proposed.length,
    delivered,
    suspended,
    skipped,
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
