import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// סקר-העברה בודדת (Task 29 — חוזה-האינטגרציה: fabric-client.handoffStatus).
// מטא-דאטה בלבד — אף ארטיפקט/סוד לא נחשף כאן.

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const handoff = await db.handoff.findUnique({
    where: { id },
    include: { task: { select: { title: true, kind: true, repo: true } } },
  })
  if (!handoff) {
    return NextResponse.json({ ok: false, error: 'העברה לא נמצאה' }, { status: 404 })
  }
  return NextResponse.json({ ok: true, handoff })
}
