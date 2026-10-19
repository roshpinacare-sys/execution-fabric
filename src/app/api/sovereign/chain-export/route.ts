import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncChainExport, exportFileBrief } from '@/lib/chain-export'

// מחזור-חדשנות #13 (Task 80): שער-הייצוא — המקור-השלישי-מגוון-הפורמט.
// POST — סנכרון-append-only של sovereign/chain-export/ledger.jsonl מול-הייצור:
// כל-הקידומת-הקיימת-מאומתת-מול-הייצור (כל-סתירה = כשל-כן, אף-שכתוב-אף-פעם),
// הזנב-החסר-מצורף. הלב קורא לכאן בפעימה-קבועה; פעימת-הדופק-שלו מכניסה-את-
// הקובץ-לגיט — וכך-הייצוא-חי-לנצח-בהיסטוריית-הגיט.
// GET — תקציר-זול (stat-בלבד) לתצוגה, בלי-קריאת-תוכן.
export const dynamic = 'force-dynamic'

export async function POST() {
  const res = await syncChainExport()
  return NextResponse.json(res, { status: res.ok ? 200 : 500 })
}

export async function GET() {
  const brief = exportFileBrief()
  const prod = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' }, select: { id: true, hash: true } })
  return NextResponse.json({
    ok: true,
    file: brief,
    production: { total: prod?.id ?? 0, head: prod?.hash ?? null },
  })
}
