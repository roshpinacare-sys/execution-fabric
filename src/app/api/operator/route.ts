// מצב-מנעול-הבעלים — קריאה-גלויה-בלבד: לא-חותם, לא-משנה-מצב, לא-חושף-מפתח (רק-בוליאנים)
import { NextResponse } from 'next/server'
import { ensureOperatorKey, resolveOperator } from '@/lib/operator'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const configured = ensureOperatorKey()
  const verdict = resolveOperator(req.headers)
  return NextResponse.json({
    ok: true,
    configured,
    unlocked: verdict.allowed,
    via: verdict.via,
    at: new Date().toISOString(),
  })
}
