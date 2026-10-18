import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'

// יישום-הצעה מקיר-הצמיחה (Task 40): PROPOSED → APPLIED — הכיוון-היחיד, אטומי.
// אישור-כן: רק PROPOSED מתקבל; כל-מצב-אחר → 409 (אפס-דריסה, אפס-הפיכה).
// כל-הפיכה מוחתמת בשרשרת-האמת (kind=SITEBUILD, worker=proposal-implementation)
// עם outputHash = sha256 של התיאור-הקנוני (id+title) — מטא-דאטה בלבד, אף-תוכן.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const numId = Number(id)
  if (!Number.isInteger(numId)) {
    return NextResponse.json({ ok: false, error: 'מזהה לא תקין' }, { status: 400 })
  }

  // אטומי: רק PROPOSED → APPLIED
  const claim = await db.improvement.updateMany({
    where: { id: numId, status: 'PROPOSED' },
    data: { status: 'APPLIED' },
  })
  if (claim.count === 0) {
    const existing = await db.improvement.findUnique({ where: { id: numId } })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'השיפור לא נמצא' }, { status: 404 })
    }
    return NextResponse.json(
      { ok: false, error: `מצב השיפור ${existing.status} — רק PROPOSED מיושם` },
      { status: 409 }
    )
  }

  const applied = await db.improvement.findUnique({ where: { id: numId } })

  const t0 = Date.now()
  try {
    await appendLedger({
      taskId: null,
      kind: 'SITEBUILD',
      status: 'DONE',
      worker: 'proposal-implementation',
      attempts: 1,
      durationMs: Date.now() - t0,
      errorClass: null,
      outputHash: sha256Short(
        `proposal-applied:${applied?.id}:${applied?.title ?? ''}`
      ),
    })
  } catch {
    // ההפיכה עצמה כבר בוצעה; כשל-חתימה לא מהפך-את-המצב — כנות בתגובה
    return NextResponse.json({
      ok: true,
      improvement: applied,
      ledgerSigned: false,
      warning: 'השיפור הוחל אך חתימת-השרשרת נכשלה',
    })
  }

  return NextResponse.json({ ok: true, improvement: applied, ledgerSigned: true })
}
