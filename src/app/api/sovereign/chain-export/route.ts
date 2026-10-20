import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  syncChainExport,
  exportFileBrief,
  rebuildChainExport,
  chainExportRebuildConfirm,
} from '@/lib/chain-export'
import { appendLedger, sha256Short } from '@/lib/ledger'

// מחזור-חדשנות #13 (Task 80): שער-הייצוא — המקור-השלישי-מגוון-הפורמט.
// POST — סנכרון-append-only של sovereign/chain-export/ledger.jsonl מול-הייצור:
// כל-הקידומת-הקיימת-מאומתת-מול-הייצור (כל-סתירה = כשל-כן, אף-שכתוב-אף-פעם),
// הזנב-החסר-מצורף. הלב קורא לכאן בפעימה-קבועה; פעימת-הדופק-שלו מכניסה-את-
// הקובץ-לגיט — וכך-הייצוא-חי-לנצח-בהיסטוריית-הגיט.
//
// מחזור-הרפואה-החיה (2026-10-20): POST ?mode=rebuild&confirm=export-rebuild-<head12>
// — שחזור-קנוני-גלוי אחרי-סתירה (הלקח-החי: export-diverges-at-1357 נולד-מסריאליזציה-
// עצמאית של-תרגיל-ההתאוששות). שער-רפואה-אחד בלבד: רק-כשהייצור-מאומת, רק-כשהייצוא
// באמת-סותר, כתיבה-קנונית-אטומית, אימות-עצמי-מלא, ורשומת-REPAIR-חתומה-בשרשרת
// (דפוס-תיקון-המזלג-1045). אסימון-האישור-נגזר-מראש-הייצור-החי — רק-מי-שקורא-את-
// האמת-עכשיו יכול-לבקש-רפואה.
// GET — תקציר-זול (stat-בלבד) לתצוגה, בלי-קריאת-תוכן.
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode')
  if (mode === 'rebuild') {
    const confirm = req.nextUrl.searchParams.get('confirm')
    if (!(await chainExportRebuildConfirm(confirm))) {
      return NextResponse.json(
        {
          ok: false,
          errorClass: 'confirm-mismatch',
          error: 'אסימון-האישור-אינו-תואם-את-ראש-הייצור-החי: export-rebuild-<head12>',
        },
        { status: 403 }
      )
    }
    const res = await rebuildChainExport()
    if (res.ok) {
      await appendLedger({
        taskId: null,
        kind: 'REPAIR',
        status: 'DONE',
        worker: 'chain-export-rebuild',
        attempts: 1,
        durationMs: res.durationMs,
        errorClass: res.divergedAt ? `export-diverges-at-${res.divergedAt}` : 'export-corrupt',
        outputHash: sha256Short(`${res.rebuilt}:${res.head}:${res.bytes}`),
      })
    }
    return NextResponse.json(res, { status: res.ok ? 200 : 500 })
  }
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
