import { NextRequest, NextResponse } from 'next/server'
import { verifyChainStreamed } from '@/lib/ledger'
import { chainRepairConfirmMatches, runChainRepair } from '@/lib/chain-repair'

// שער-תיקון-השרשרת (Task 86) — כלי-תחזוקה-חד-פעמי ומשמרת.
// GET: מצב-האימות בלבד (אין-כתיבה).
// POST: רק-עם ?confirm=repair-fork-1045 — כוונת-תיקון-מפורשת; אף-אבר-אוטונומי אינו-קורא-לו.
// התיקון-עצמו Idempotent: שרשרת-תקינה = no-op-כן.
export const dynamic = 'force-dynamic'

export async function GET() {
  const verify = await verifyChainStreamed()
  return NextResponse.json({ ok: true, verify, needsRepair: !verify.ok })
}

export async function POST(req: NextRequest) {
  const confirm = req.nextUrl.searchParams.get('confirm')
  if (!chainRepairConfirmMatches(confirm)) {
    return NextResponse.json(
      { ok: false, error: 'confirm-mismatch', hint: 'POST ?confirm=repair-fork-1045' },
      { status: 403 }
    )
  }
  const result = await runChainRepair()
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
