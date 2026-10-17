import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { executeTaskOnce } from '@/lib/executor'

// עובד-רקע (Task 23): tick אחד = משימת-QUEUED ותיקה אחת מבוצעת-עד-סוף.
// הלקוח (הלוח) מניע את-הלולאה בזמן-שהריצה-האוטומטית דלוקה; ה-claim האטומי הוא
// קו-ההגנה גם-לריבוי-לקוחות. משימות-FAILED לא נתפסות-שוב אוטומטית —
// ניסיון-חוזר הוא החלטה-אנושית (כפתור-הרץ), לא תהליך-שקט.

export async function POST() {
  const next = await db.task.findFirst({
    where: { status: 'QUEUED' },
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
