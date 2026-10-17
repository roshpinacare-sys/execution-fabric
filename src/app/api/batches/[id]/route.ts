import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// סקר-מצב אצווה (Task 24) — נקודת-הסקר לצרכן-התכנותי:
// משימות האצווה, ספירות, וקבלת-המסכמת מהשרשרת כשהיא קיימת.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const tasks = await db.task.findMany({
    where: { batchId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      worker: true,
      errorClass: true,
      attempts: true,
      durationMs: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  if (tasks.length === 0) {
    return NextResponse.json({ ok: false, error: 'אצווה לא נמצאה' }, { status: 404 })
  }
  const done = tasks.filter((t) => t.status === 'DONE').length
  const failed = tasks.filter((t) => t.status === 'FAILED').length
  const pending = tasks.length - done - failed
  const summary = await db.ledgerEntry.findFirst({
    where: { batchId: id },
    orderBy: { id: 'desc' },
    select: {
      id: true,
      status: true,
      worker: true,
      errorClass: true,
      outputHash: true,
      hash: true,
      durationMs: true,
      createdAt: true,
    },
  })
  return NextResponse.json({
    ok: true,
    batchId: id,
    counts: { total: tasks.length, done, failed, pending },
    terminal: pending === 0,
    summary: summary ?? null,
    tasks,
  })
}
