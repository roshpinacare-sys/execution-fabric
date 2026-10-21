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
//
// מצב-סערה (Task 104): הצינון-הקבוע-מעולה-ברגיעה אך-בסערת-ספק הוא-מסעדה-של-זרימה:
// כשל-ספק-חוזר-על יוצר-מחסן-עבודה-תקפה-שממתין-30דק' בתור-המתים-גם-כשהרשת-כבר-התאוששה.
// החוק-החדש: מחסן-חוזרים-על ≥ 5 והכישלון-הטרי-בן-פחות-מ-15דק' → צינון-מתכווץ-ל-2דק'
// (הגבולות-האמיתיים נשארים: attempts≤5, תקרה-8, claim-אטומי). המצב-מדווח-בגוף-התשובה.

export const dynamic = 'force-dynamic'

const RECOVERY_CLASSES = ['rate-limit', 'provider', 'timeout', 'network', 'empty-output', 'unknown']
const MAX_ATTEMPTS = 5
const COOLDOWN_MS = 30 * 60_000
const SWEEP_CAP = 8
const STORM_THRESHOLD = 5
const STORM_FRESH_MS = 15 * 60_000
const STORM_COOLDOWN_MS = 2 * 60_000

export async function POST() {
  const t0 = Date.now()

  // חישוב-מצב-סערה: מחסן-החוזרים-על + גיל-הכישלון-הטרי-ביותר
  const stormPool = await db.task.findMany({
    where: {
      status: 'FAILED',
      errorClass: { in: RECOVERY_CLASSES },
      attempts: { lte: MAX_ATTEMPTS },
      role: null,
      parentId: null,
    },
    orderBy: { updatedAt: 'desc' },
    take: STORM_THRESHOLD,
    select: { updatedAt: true },
  })
  const stormActive =
    stormPool.length >= STORM_THRESHOLD &&
    stormPool[0].updatedAt.getTime() > Date.now() - STORM_FRESH_MS
  const cooldownMs = stormActive ? STORM_COOLDOWN_MS : COOLDOWN_MS
  const staleBefore = new Date(Date.now() - cooldownMs)

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
      storm: stormActive,
      reason: `nothing-to-recover: אין-משימות-FAILED-חולפות-בכשל-מעל-${Math.round(cooldownMs / 60_000)}דק' (${stormActive ? 'צינון-סערה' : 'צינון-רגיל'}) — כנות, לא המצאת-עבודה`,
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
    storm: stormActive,
    ledgerSigned: true,
    note: stormActive
      ? 'מצב-סערה: המחסן-חרג-מהסף — צינון-מתכווץ-ל-2דק\' והעבודה-התקפה-חוזרת-לזרימה-מיידית'
      : 'המשימות-הוחזרו-לתור-עם-ה-attempts-שלהן-נשמר — ה-executor והסולם-ישפטו-מחדש',
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
    policy: {
      classes: RECOVERY_CLASSES,
      maxAttempts: MAX_ATTEMPTS,
      cooldownMin: COOLDOWN_MS / 60_000,
      sweepCap: SWEEP_CAP,
      storm: { threshold: STORM_THRESHOLD, freshMin: STORM_FRESH_MS / 60_000, cooldownMin: STORM_COOLDOWN_MS / 60_000 },
    },
  })
}
