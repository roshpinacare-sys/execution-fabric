import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'

// עורק-הזדמנות-שנייה (Task 97): משימות-FAILED שנכשלו-כשל-עומס-ספק (rate-limit/provider/
// timeout/network/empty-output) הן כוונת-עבודה-תקפה שאבדה-למזל — לא לפסול-עבודה.
// עד-עכשיו: "משימות-FAILED לא נתפסות-שוב אוטומטית — ניסיון-חוזר הוא החלטה-אנושית".
// הדוקטרינה-הריבונית (הארכיטקטורה-היא-הבעלים): ההחלטה-הזו אינה-דורשת-אדם — היא חוק-מכני-כן:
//   · רק-מחלקות-חולפות (אין invalid/duplicate — אלו-פסילות-קבועות ונשארות-מתות)
//   · רק-משימות-שורש (אין-עובדי-צי/עדשות — הסינתזה-שלהן מנוהלת-במסילה-שלה)
//   · attempts ≤ 5 (גבול-מאמץ-כולל-כן), גיל-כשל ≥ 30 דק' (צינון), תקרה 8 לסוואפ
//   · claim אטומי (updateMany על FAILED בלבד) — אפס-דריסה-כפולה
// כל-סוואפ-שפעל-נחתם REPAIR בשרשרת; סוואפ-ריק לא מזייף-חתימה — דיווח-כן בלבד.

export const dynamic = 'force-dynamic'

const RECOVERY_CLASSES = ['rate-limit', 'provider', 'timeout', 'network', 'empty-output', 'unknown']
const MAX_ATTEMPTS = 5
const COOLDOWN_MS = 30 * 60_000
const SWEEP_CAP = 8

export async function POST() {
  const t0 = Date.now()
  const staleBefore = new Date(Date.now() - COOLDOWN_MS)

  const candidates = await db.task.findMany({
    where: {
      status: 'FAILED',
      errorClass: { in: RECOVERY_CLASSES },
      attempts: { lte: MAX_ATTEMPTS },
      updatedAt: { lt: staleBefore },
      role: null,
      parentId: null,
    },
    orderBy: { updatedAt: 'asc' },
    take: SWEEP_CAP,
    select: { id: true, kind: true, title: true, errorClass: true, attempts: true },
  })

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      requeued: 0,
      reason: 'nothing-to-recover: אין-משימות-FAILED-חולפות-בכשל-מעל-30דק\' — כנות, לא המצאת-עבודה',
    })
  }

  const requeued: { id: string; kind: string; errorClass: string | null; attempts: number }[] = []
  for (const c of candidates) {
    // claim אטומי: רק-עדיין-FAILED עובר (מריץ-מקביל/סוואף-כפול לא ידרוס)
    const claim = await db.task.updateMany({
      where: { id: c.id, status: 'FAILED' },
      data: { status: 'QUEUED', error: null, errorClass: null },
    })
    if (claim.count === 1) {
      requeued.push({ id: c.id, kind: c.kind, errorClass: c.errorClass, attempts: c.attempts })
    }
  }

  if (requeued.length === 0) {
    return NextResponse.json({
      ok: true,
      requeued: 0,
      reason: 'race: כל-המועמדות נתבעו-כבר-על-ידי-סוואף-מקביל — אפס-הרצה-כפולה',
    })
  }

  const canonical = JSON.stringify({ recovered: requeued.map((r) => r.id).sort() })
  await appendLedger({
    taskId: null,
    kind: 'REPAIR',
    status: 'DONE',
    worker: 'recovery-second-chance',
    attempts: 1,
    durationMs: Date.now() - t0,
    errorClass: null,
    outputHash: sha256Short(canonical),
  })

  return NextResponse.json({
    ok: true,
    requeued: requeued.length,
    recovered: requeued,
    ledgerSigned: true,
    note: 'המשימות-הוחזרו-לתור-עם-ה-attempts-שלהן-נשמר — ה-executor והסולם-ישפטו-מחדש',
  })
}

export async function GET() {
  const [failedTransient, failedPermanent] = await Promise.all([
    db.task.count({
      where: { status: 'FAILED', errorClass: { in: RECOVERY_CLASSES }, attempts: { lte: MAX_ATTEMPTS }, role: null, parentId: null },
    }),
    db.task.count({ where: { status: 'FAILED', errorClass: { notIn: RECOVERY_CLASSES } } }),
  ])
  return NextResponse.json({
    ok: true,
    failedTransientRecoverable: failedTransient,
    failedPermanent: failedPermanent,
    policy: { classes: RECOVERY_CLASSES, maxAttempts: MAX_ATTEMPTS, cooldownMin: COOLDOWN_MS / 60_000, sweepCap: SWEEP_CAP },
  })
}
