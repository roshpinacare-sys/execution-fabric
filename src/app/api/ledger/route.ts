import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyChain } from '@/lib/ledger'

// הפלט תמיד כולל אימות-מחדש של השרשרת על כל-קריאה — לא סטטוס שמור, חישוב חי.
export async function GET() {
  const entries = await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })
  const verify = verifyChain(entries)
  return NextResponse.json({
    ok: true,
    total: entries.length,
    verify,
    recent: entries.slice(-8).reverse(),
  })
}
