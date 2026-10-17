import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// סקר-משימה בודדת (Task 24) — לצרכן-התכנותי ששולח משימה-אחת דרך POST /api/tasks
// ורוצה לדעת מתי היא טרמינלית (DONE/FAILED) בלי למשוך את כל הלוח.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const task = await db.task.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      worker: true,
      output: true,
      error: true,
      errorClass: true,
      attempts: true,
      durationMs: true,
      batchId: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (!task) {
    return NextResponse.json({ ok: false, error: 'משימה לא נמצאה' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, task })
}
