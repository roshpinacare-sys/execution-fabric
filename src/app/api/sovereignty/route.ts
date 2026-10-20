import { NextResponse } from 'next/server'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { collectSovereignty } from '@/lib/sovereignty'

// מד-הריבונות-העצמית — שער-המדידה של "הארכיטקטורה היא הבעלים".
//
// GET: מדידה-חיה בלבד — { ok, level, overall, dimensions, gates, … } לדגימת-UI. אין-חתימה.
// POST ?subject=sovereignty-audit: אותה-מדידה + חתימת-AUDIT כנה בשרשרת.
//
// אנטי-ירוק-שקר (החוק): הכותרת-החתומה כנה לפי-הרמה-הנמדדת —
//   overall=sovereign → status='DONE';
//   אחרת → status='FAILED' + errorClass=sovereignty-<overall> —
// השרשרת לעולם לא תחתום "ריבונות-שלמה" על-מצב-שאיננו. זו-הוכחת-הכנות שהבעלים דרש.
export const dynamic = 'force-dynamic'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function GET() {
  const generatedAt = new Date().toISOString()
  try {
    const report = await collectSovereignty()
    return NextResponse.json({ ok: true, ...report, generatedAt })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), level: 0, overall: 'owner-dependent', dimensions: [], gates: [], generatedAt },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  const generatedAt = new Date().toISOString()
  try {
    const t0 = Date.now()
    const report = await collectSovereignty()
    const subject = new URL(req.url).searchParams.get('subject')

    // POST בלי-subject = דגימה בלבד (בלי-חתימה)
    if (subject !== 'sovereignty-audit') {
      return NextResponse.json({ ok: true, ...report, generatedAt })
    }

    // כותרת-כנה: ריבונות-מלאה-בפועל היא-ה-DONE היחיד — השאר FAILED-חתום בשמו
    const honest = report.overall === 'sovereign'
    const entry = await appendLedger({
      taskId: null,
      kind: 'AUDIT',
      status: honest ? 'DONE' : 'FAILED',
      worker: 'sovereignty-meter',
      attempts: 1,
      durationMs: Date.now() - t0,
      errorClass: honest ? null : `sovereignty-${report.overall}`,
      outputHash: sha256Short(JSON.stringify({ level: report.level, overall: report.overall })),
    })

    return NextResponse.json({
      ok: true,
      ...report,
      generatedAt,
      signed: { id: entry.id, hash: entry.hash, kind: entry.kind, worker: entry.worker, status: entry.status },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), level: 0, overall: 'owner-dependent', dimensions: [], gates: [], generatedAt },
      { status: 500 },
    )
  }
}
