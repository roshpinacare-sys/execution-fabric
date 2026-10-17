import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'

// משיכת-הצעה ע"י הבעלים (worklog Task 20): PROPOSED → WITHDRAWN.
// משיכה לא נוגעת בגיט — היא הכיוון-הבטוח של שליטת-הבעלים, ולכן מותרת גם בלי-ירי.
// כל מצב-סופ של השער נחתם בשרשרת — גם משיכה.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const existing = await db.handoff.findUnique({ where: { id } })
  if (!existing) {
    return NextResponse.json({ ok: false, error: 'העברה לא נמצאה' }, { status: 404 })
  }
  if (existing.status !== 'PROPOSED') {
    return NextResponse.json(
      { ok: false, error: `מצב ההעברה ${existing.status} — רק PROPOSED ניתן למשיכה` },
      { status: 409 }
    )
  }

  const handoff = await db.handoff.update({
    where: { id },
    data: { status: 'WITHDRAWN' },
  })
  await appendLedger({
    taskId: handoff.taskId,
    kind: 'HANDOFF',
    status: 'WITHDRAWN',
    worker: 'github-handoff',
    attempts: handoff.attempts,
    durationMs: 0,
    errorClass: null,
    outputHash: handoff.artifactHash ?? sha256Short(''),
  })
  return NextResponse.json({ ok: true, handoff })
}
