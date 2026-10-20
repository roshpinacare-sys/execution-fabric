import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { executeTaskOnce } from '@/lib/executor'

// עובד-רקע (Task 23): tick אחד = משימה אחת מבוצעת-עד-סוף.
// הלב (עורק-א) מניע את-הלולאה; ה-claim האטומי הוא קו-ההגנה גם-לריבוי-לקוחות.
// משימות-FAILED לא נתפסות-שוב אוטומטית — זהו תפקיד עורק-הזדמנות-שנייה (Task 97:
// /api/sovereign/recovery — מחלקות-חולפות-בלבד, גבולות-כן), לא תהליך-שקט-כאן.
//
// Task 28 (ריפוי-עצמי): tick קולט גם RUNNING-תקועה (updatedAt ישן מעל 10 דק' — למשל
// כתיבה-שנכשלה-בחלון-readonly-חולף של פעימת-הגיט). בלי-זה, משימה-תקועה הייתה נשארת
// תקועה-לנצח — התביעה-מחדש הייתה רק-ידנית. ההגנה-מול-הרצה-כפולה נשארת ב-claim האטומי
// של executeTaskOnce (אותו-תנאי-תוקף — מי-שמגיע-ראשון זוכה, והמוות-נקבע-לפי-updatedAt).
//
// Task 97 (נתיבי-ביצוע-מקביליים): ?lanes=N (ברירת-מחדל 1, תקרה 3) — תור-נגוס
// (סוואף-התאוששות) מתרוקן-במקביל במקום-בטור. ה-claim-האטומי של executeTaskOnce
// מוכח-כבר-מול-ריבוי-לקוחות; Promise.allSettled = כשל-נתיב-אחד לא מפיל-את-חבריו.

const STALE_RUNNING_MS = 10 * 60_000
const MAX_LANES = 3

export async function POST(req: NextRequest) {
  const lanesRaw = Number(req.nextUrl.searchParams.get('lanes') ?? '1')
  const lanes = Number.isFinite(lanesRaw) && lanesRaw >= 1 ? Math.min(Math.floor(lanesRaw), MAX_LANES) : 1

  const next = await db.task.findMany({
    where: {
      OR: [
        { status: 'QUEUED' },
        { status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: lanes,
    select: { id: true },
  })
  if (next.length === 0) {
    return NextResponse.json({ ok: true, picked: 0 })
  }

  const results = await Promise.allSettled(next.map((t) => executeTaskOnce(t.id)))

  let executed = 0
  let raced = 0
  let lost = 0
  const statuses: (string | null)[] = []
  for (const r of results) {
    if (r.status === 'rejected') {
      lost++
      statuses.push(null)
      continue
    }
    if (!r.value.claimed) {
      raced++
      statuses.push(null)
      continue
    }
    if (r.value.executed) executed++
    statuses.push(r.value.status ?? null)
  }

  return NextResponse.json({
    ok: true,
    picked: next.length,
    lanes,
    executed,
    raced,
    lost,
    status: statuses[0],
  })
}
