import { NextResponse } from 'next/server'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { collectMagnitude } from '@/lib/magnitude'

// מד-העוצמה — שער-המדידה של "פי-1000-מהבעלים" ככנות-ולא-כהצהרה.
//
// GET: מדידה-חיה בלבד — { ok, target, measuredCore, dimensions, unbounded, deficits, gaps, … }.
// POST ?subject=magnitude-audit: אותה-מדידה + חתימת-AUDIT כנה בשרשרת.
//
// חוק-החתימה-הכנה (שונה-משאר-השערים — מתועד-במפורש):
//   DONE = "המדידה הושלמה בכנות" — כל-ארבעת-מקורות-הראיות חיים ואפס-ממדים-בלתי-נמדדים.
//   FAILED + errorClass=magnitude-incomplete = מקור-ראיות-מת או-ממד-שלא-נמדד —
//   אי-אפשר-לחתום-מדידת-עוצמה-על-ראיות-חלקיות.
//   המספר-עצמו (measuredCore) אינו-תנאי-החתימה: 40x-או-2000x — המספר-הוא-האמת,
//   ה-DONE-הוא-על-כנות-המדידה. אין-ירוק-שקר-ואין-אדום-שקר.
export const dynamic = 'force-dynamic'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function GET() {
  const generatedAt = new Date().toISOString()
  try {
    const report = await collectMagnitude()
    return NextResponse.json({ ok: true, ...report, generatedAt })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), target: 1000, measuredCore: null, dimensions: [], unbounded: [], deficits: [], gaps: [], generatedAt },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  const generatedAt = new Date().toISOString()
  try {
    const t0 = Date.now()
    const report = await collectMagnitude()
    const subject = new URL(req.url).searchParams.get('subject')

    // POST בלי-subject = דגימה בלבד (בלי-חתימה)
    if (subject !== 'magnitude-audit') {
      return NextResponse.json({ ok: true, ...report, generatedAt })
    }

    const complete = report.sourcesUp === report.sourcesTotal && report.measuredCore !== null
    const entry = await appendLedger({
      taskId: null,
      kind: 'AUDIT',
      status: complete ? 'DONE' : 'FAILED',
      worker: 'magnitude-meter',
      attempts: 1,
      durationMs: Date.now() - t0,
      errorClass: complete ? null : 'magnitude-incomplete',
      outputHash: sha256Short(JSON.stringify({
        core: report.measuredCore,
        beyond: report.dimensionsBeyondTarget,
        sources: `${report.sourcesUp}/${report.sourcesTotal}`,
      })),
    })

    return NextResponse.json({
      ok: true,
      ...report,
      generatedAt,
      signed: { id: entry.id, hash: entry.hash, kind: entry.kind, worker: entry.worker, status: entry.status },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), target: 1000, measuredCore: null, dimensions: [], unbounded: [], deficits: [], gaps: [], generatedAt },
      { status: 500 },
    )
  }
}
