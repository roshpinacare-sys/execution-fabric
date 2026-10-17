import { NextResponse } from 'next/server'
import { railsReport } from '@/lib/providers'

// דוח-מסילות: נוכחות ותצורה בלבד. אף מפתח, אף ערך-סודי — לא חוזר מכאן.
export async function GET() {
  return NextResponse.json({ ok: true, rails: railsReport() })
}
