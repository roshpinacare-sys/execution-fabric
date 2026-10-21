import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'

// עורק-ההשלמה (Task 97) — גשר סגירת-הלולאה של קיר-הצמיחה:
// 36+ הצעות-PROPOSED ישבו-בלי-גורל — העורק-הזה הופך-כל-הצעה לעבודה-אמיתית-חתומה:
//   זריעה: PROPOSED → משימת-CODE-אמיתית בתור ("יישום-הצעה #N: ...") — ה-executor,
//          הסולם, הוולידציה וה-handoff-האוטומטי הקיימים עושים-את-השאר (אפס-קיצורי-דרך).
//   קציר: משימת-יישום ש-DONE וההצעה עדיין-PROPOSED → PROPOSED→APPLIED (אטומי)
//          + חתימת SITEBUILD worker=proposal-completion (הדפוס של apply).
// כנות-וגבולות (Task 98 — תיקון-רעב): הסוואף מאיטרט-על-מועמדות-במקום-להיבלם-על-הצעה-אחת —
//   צינון/in-flight-על-הצעה-מסוימת מדלג-עליה-וממשיך-לבאה (עד-10-מועמדות) — עד-2-זריעות-לסוואף.
//   · צינון-24שע' מהניסיון-הקודם לאותה-הצעה · אין-זריעה-על-משימה-בעלת-חיים · אפס-כפילות
//   · אין-הצעות = 404 כן (nothing-to-complete) — לא מומצאת-עבודה

export const dynamic = 'force-dynamic'

const DISPATCH_PREFIX = 'יישום-הצעה #'
const COOLDOWN_MS = 24 * 60 * 60_000
const SOW_PER_SWEEP = 2
const CANDIDATE_SCAN = 10

function taskTitleFor(proposalId: number, title: string): string {
  return `${DISPATCH_PREFIX}${proposalId}: ${title}`.slice(0, 180)
}

function proposalIdFromTaskTitle(t: string): number | null {
  const m = t.match(/^יישום-הצעה #(\d+):/)
  return m ? Number(m[1]) : null
}

function buildPrompt(title: string, summary: string, body: string): string {
  return [
    `הצעת-שיפור-מוצר-אמיתית מקיר-הצמיחה — יש ליישמה בקוד מלא ועובד.`,
    `כותרת: ${title}`,
    `תמצית: ${summary}`,
    `גוף-ההצעה:`,
    body.slice(0, 4000),
    ``,
    `יישם-את-ההצעה: החזר-קוד-מלא-ועובד (TypeScript/TSX/SQL לפי-הצורך) המממש-את-השיפור-כמיושם-במוצר, עם-הסבר-הנדסי-קצר.`,
    `אין-המצאות-ממשקים: אם-ההצעה-מתייחסת-למשטח-קיים — כתוב-את-הרכיב/הפונקציה-המלאה-כפי-שהייתה-נכתבת-בקוד-האמיתי.`,
  ].join('\n')
}

export async function POST() {
  const t0 = Date.now()

  // ===== קציר: משימות-יישום-שהושלמו וההצעה-עדיין-ממתינה =====
  const doneDispatches = await db.task.findMany({
    where: { title: { startsWith: DISPATCH_PREFIX }, status: 'DONE' },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { id: true, title: true, updatedAt: true },
  })
  let harvested = 0
  for (const t of doneDispatches) {
    const pid = proposalIdFromTaskTitle(t.title)
    if (pid === null) continue
    const imp = await db.improvement.findUnique({ where: { id: pid } })
    if (!imp || imp.status !== 'PROPOSED') continue
    // claim אטומי: רק-עדיין-PROPOSED עובר
    const claim = await db.improvement.updateMany({
      where: { id: pid, status: 'PROPOSED' },
      data: { status: 'APPLIED' },
    })
    if (claim.count === 1) {
      await appendLedger({
        taskId: null,
        kind: 'SITEBUILD',
        status: 'DONE',
        worker: 'proposal-completion',
        attempts: 1,
        durationMs: Date.now() - t0,
        errorClass: null,
        outputHash: sha256Short(`proposal-completed:${pid}:${imp.title}`),
      })
      harvested++
    }
  }

  // ===== זריעה: איטרציית-מועמדים — עד-2-הצעות-הופכות-לעבודה-אמיתית-בכל-סוואף =====
  const candidates = await db.improvement.findMany({
    where: { status: 'PROPOSED' },
    orderBy: { id: 'asc' },
    take: CANDIDATE_SCAN,
    select: { id: true, title: true, summary: true, body: true },
  })
  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      harvested,
      dispatched: [],
      reason: 'nothing-to-complete: אין-הצעות-PROPOSED-ממתינות — כנות, לא המצאת-עבודה',
    })
  }

  const dispatched: Array<{ taskId: string; proposalId: number; title: string }> = []
  const skipped: string[] = []
  for (const cand of candidates) {
    if (dispatched.length >= SOW_PER_SWEEP) break
    const prefix = `${DISPATCH_PREFIX}${cand.id}:`
    const prior = await db.task.findFirst({
      where: { title: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true },
    })
    if (prior && (prior.status === 'QUEUED' || prior.status === 'RUNNING')) {
      skipped.push(`#${cand.id}:in-flight(${prior.status})`)
      continue
    }
    if (prior && Date.now() - prior.createdAt.getTime() < COOLDOWN_MS) {
      skipped.push(`#${cand.id}:cooldown(${prior.status})`)
      continue
    }
    const task = await db.task.create({
      data: {
        title: taskTitleFor(cand.id, cand.title),
        kind: 'CODE',
        prompt: buildPrompt(cand.title, cand.summary, cand.body),
      },
    })
    dispatched.push({ taskId: task.id, proposalId: cand.id, title: task.title })
  }

  if (dispatched.length === 0) {
    return NextResponse.json({
      ok: true,
      harvested,
      dispatched: [],
      reason: `all-blocked: כל-${candidates.length}-המועמדות-חסומות-בכנות (${skipped.slice(0, 4).join(' · ')})`,
    })
  }

  return NextResponse.json({
    ok: true,
    harvested,
    dispatched,
    skipped: skipped.slice(0, 6),
    note: 'ההצעות-הפכו-לעבודה-אמיתית-בתור — ה-executor והסולם-הקיימים יבצעו-ויחתמו',
  })
}

export async function GET() {
  const [proposed, inFlight, doneDispatches] = await Promise.all([
    db.improvement.count({ where: { status: 'PROPOSED' } }),
    db.task.count({ where: { title: { startsWith: DISPATCH_PREFIX }, status: { in: ['QUEUED', 'RUNNING'] } } }),
    db.task.count({ where: { title: { startsWith: DISPATCH_PREFIX }, status: 'DONE' } }),
  ])
  return NextResponse.json({
    ok: true,
    proposedPending: proposed,
    dispatchTasksInFlight: inFlight,
    dispatchTasksDone: doneDispatches,
    policy: { cooldownHours: COOLDOWN_MS / 3_600_000, sowPerSweep: SOW_PER_SWEEP, candidateScan: CANDIDATE_SCAN, harvestPerSweep: 20 },
  })
}
