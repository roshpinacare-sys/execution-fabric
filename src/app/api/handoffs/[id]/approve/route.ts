import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// אישור-בעלים מפורש פר-העברה (worklog Task 20): PROPOSED → APPROVED.
// זהו השער המוסדי — execute מסרב לכל מצב שאינו APPROVED (או FAILED לניסיון-חוזר).

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const claim = await db.handoff.updateMany({
    where: { id, status: 'PROPOSED' },
    data: { status: 'APPROVED' },
  })
  if (claim.count === 0) {
    const existing = await db.handoff.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'העברה לא נמצאה' },
        { status: 404 }
      )
    }
    return NextResponse.json(
      { ok: false, error: `מצב ההעברה ${existing.status} — רק PROPOSED ניתן לאישור` },
      { status: 409 }
    )
  }
  const handoff = await db.handoff.findUnique({ where: { id } })
  return NextResponse.json({ ok: true, handoff })
}
