import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'

// עורק-ההשלמה (Task 97) — גשר סגירת-הלולאה של קיר-הצמיחה:
// 36+ הצעות-PROPOSED ישבו-בלי-גורל — העורק-הזה הופך-כל-הצעה לעבודה-אמיתית-חתומה:
//   זריעה: PROPOSED → משימת-CODE-אמיתית בתור ("יישום-הצעה #N: ...") — ה-executor,
//          הסולם, הוולידציה וה-handoff-האוטומטי הקיימים עושים-את-השאר (אפס-קיצורי-דרך).
//   קציר: משימת-יישום ש-DONE וההצעה עדיין-PROPOSED → PROPOSED→APPLIED (אטומי)
//          + חתימת SITEBUILD worker=proposal-completion (הדפוס של apply).
// כנות-וגבולות:
//   · זריעה: הצעה-אחת לסוואף · צינון-24שע' מהניסיון-הקודם לאותה-הצעה · אין-זריעה-על-משימה-בעלת-חיים
//   · אין-הצעות = 404 כן (nothing-to-complete) — לא מומצאת-עבודה

export const dynamic = 'force-dynamic'

const DISPATCH_PREFIX = 'יישום-הצעה #'
const COOLDOWN_MS = 24 * 60 * 60_000

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

  // ===== זריעה: ההצעה-הוותיקה-ביותר-שממתינה → משימת-יישום-אמיתית =====
  const oldest = await db.improvement.findFirst({
    where: { status: 'PROPOSED' },
    orderBy: { id: 'asc' },
  })
  if (!oldest) {
    return NextResponse.json({
      ok: true,
      harvested,
      dispatched: null,
      reason: 'nothing-to-complete: אין-הצעות-PROPOSED-ממתינות — כנות, לא המצאת-עבודה',
    })
  }

  const prefixForOldest = `${DISPATCH_PREFIX}${oldest.id}:`
  const prior = await db.task.findFirst({
    where: { title: { startsWith: prefixForOldest } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true },
  })
  if (prior && (prior.status === 'QUEUED' || prior.status === 'RUNNING')) {
    return NextResponse.json({
      ok: true,
      harvested,
      dispatched: null,
      reason: `in-flight: להצעה #${oldest.id} יש-משימת-יישום-חיה (${prior.status}) — אפס-כפילות`,
    })
  }
  if (prior && Date.now() - prior.createdAt.getTime() < COOLDOWN_MS) {
    return NextResponse.json({
      ok: true,
      harvested,
      dispatched: null,
      reason: `cooldown: להצעה #${oldest.id} היה-ניסיון-יישום-ב-24שע' האחרונות (${prior.status}) — ממתין-בכנות`,
    })
  }

  const task = await db.task.create({
    data: {
      title: taskTitleFor(oldest.id, oldest.title),
      kind: 'CODE',
      prompt: buildPrompt(oldest.title, oldest.summary, oldest.body),
    },
  })

  return NextResponse.json({
    ok: true,
    harvested,
    dispatched: { taskId: task.id, proposalId: oldest.id, title: task.title },
    note: 'ההצעה-הפכה-לעבודה-אמיתית-בתור — ה-executor והסולם-הקיימים יבצעו-ויחתמו',
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
    policy: { cooldownHours: COOLDOWN_MS / 3_600_000, sowPerSweep: 1, harvestPerSweep: 20 },
  })
}
