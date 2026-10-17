import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { executeTaskOnce } from '@/lib/executor'

// הביצוע-הידני — עטיפה דקה מעל המבצע-המשותף (src/lib/executor.ts, Task 23).
// אותו-מנוע משמש גם עובד-הרקע: claim אטומי אחיד (עם החזרת-תביעה לריצה-תקועה >10 דק'),
// כשל-כן, חתימת-שרשרת.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const result = await executeTaskOnce(id)
  if (!result.claimed) {
    return NextResponse.json(
      { ok: false, error: 'המשימה כבר רצה כרגע (או לא נמצאה)' },
      { status: 409 }
    )
  }
  const task = await db.task.findUnique({ where: { id } })
  return NextResponse.json({ ok: true, task, executed: result.executed, note: result.note })
}
