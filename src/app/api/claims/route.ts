import { NextResponse } from 'next/server'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { collectClaims } from '@/lib/claims'

// בודק-הטענות (Claims-vs-Reality) — שער-האמת בין-ההצהרות למציאות.
//
// GET: בדיקה-חיה בלבד — { ok, overall, counts, claims, generatedAt, durationMs }.
//      מיועד לדגימת-UI — אין-חתימה-בשרשרת כאן (אסור-לנפח-את-האבן).
// POST ?subject=claims-audit: אותו-דוח + חתימת-AUDIT בשרשרת.
//
// אנטי-ירוק-שקר (הלקח-החתום): הכותרת-החתומה כנה-לפי-התוצאה —
//   overall=active → status='DONE' (errorClass=null);
//   overall=degraded/critical → status='FAILED' (errorClass=claims-*) —
// צרכן-שקורא-רק-status לא-יירמא-לעולם. הראיות-המלאות בגוף-הדוח.
export const dynamic = 'force-dynamic'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function GET() {
  const generatedAt = new Date().toISOString()
  try {
    const report = await collectClaims()
    return NextResponse.json({ ok: true, ...report, generatedAt })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), overall: 'critical', claims: [], generatedAt },
      { status: 500 },
    )
  }
}

export async function POST(req: Request) {
  const generatedAt = new Date().toISOString()
  try {
    const t0 = Date.now()
    const report = await collectClaims()
    const subject = new URL(req.url).searchParams.get('subject')

    // POST בלי-subject = דגימה בלבד (בלי-חתימה) — כמו-GET
    if (subject !== 'claims-audit') {
      return NextResponse.json({ ok: true, ...report, generatedAt })
    }

    // כותרת-כנה: FAILED כשהמצב אינו פעיל — השרשרת לעולם לא תחתום ירוק-על-אדום
    const honest = report.overall === 'active'
    const entry = await appendLedger({
      taskId: null,
      kind: 'AUDIT',
      status: honest ? 'DONE' : 'FAILED',
      worker: 'claims-auditor',
      attempts: 1,
      durationMs: Date.now() - t0,
      errorClass: honest ? null : `claims-${report.overall}`,
      outputHash: sha256Short(
        JSON.stringify({ overall: report.overall, counts: report.counts })
      ),
    })

    return NextResponse.json({
      ok: true,
      ...report,
      generatedAt,
      signed: { id: entry.id, hash: entry.hash, kind: entry.kind, worker: entry.worker, status: entry.status },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), overall: 'critical', claims: [], generatedAt },
      { status: 500 },
    )
  }
}
