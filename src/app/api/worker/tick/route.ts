import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { executeTaskOnce } from '@/lib/executor'

// עובד-רקע (Task 23): tick אחד = משימה אחת מבוצעת-עד-סוף.
// הלב (עורק-א) מניע את-הלולאה; ה-claim האטומי הוא קו-ההגנה גם-לריבוי-לקוחות.
// משימות-FAILED לא נתפסות-שוב אוטומטית — ניסיון-חוזר הוא החלטה-אנושית (כפתור-הרץ), לא תהליך-שקט.
//
// Task 28 (ריפוי-עצמי): tick קולט גם RUNNING-תקועה (updatedAt ישן מעל 10 דק' — למשל
// כתיבה-שנכשלה-בחלון-readonly-חולף של פעימת-הגיט). בלי-זה, משימה-תקועה הייתה נשארת
// תקועה-לנצח — התביעה-מחדש הייתה רק-ידנית. ההגנה-מול-הרצה-כפולה נשארת ב-claim האטומי
// של executeTaskOnce (אותו-תנאי-תוקף — מי-שמגיע-ראשון זוכה, והמוות-נקבע-לפי-updatedAt).

const STALE_RUNNING_MS = 10 * 60_000

export async function POST() {
  const next = await db.task.findFirst({
    where: {
      OR: [
        { status: 'QUEUED' },
        { status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (!next) {
    return NextResponse.json({ ok: true, picked: 0 })
  }
  const r = await executeTaskOnce(next.id)
  if (!r.claimed) {
    // נתפס על-ידי tick מקביל בין-המציאה-לתביעה — אין-אבדן, אין-הרצה-כפולה
    return NextResponse.json({ ok: true, picked: 0, raced: true })
  }
  return NextResponse.json({
    ok: true,
    picked: 1,
    taskId: next.id,
    executed: r.executed,
    status: r.status ?? null,
    errorClass: r.errorClass ?? null,
  })
}
