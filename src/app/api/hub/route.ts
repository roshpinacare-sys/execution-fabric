import { NextResponse } from 'next/server'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { collectAnchors, summarize } from '@/lib/hub'

// רכזת-הרשת — שער-הבריאות של רישום-העוגנים (Task 88).
//
// GET: דגימה-חיה בלבד — { ok, networkStatus, counts, anchors, generatedAt }.
//      מיועד לדגימת-UI כל-20ש' — אין-חתימה-בשרשרת כאן (אסור-לנפח-את-האבן).
// POST ?subject=hub-check: אותו-דוח + חתימת-רשומת-AUDIT בשרשרת
//      (kind=AUDIT, worker='network-hub', סיכום-קצר-כולל-ספירת-עוגנים-לפי-מצב).
//
// fail-honest: try/catch פר-עוגן (ב-hub.ts עצמו — safeProbe), וכאן רשת-בטחון-אחרונה —
// עוגן-שנפל מדווח-מצבו (degraded) ולא-מפיל-את-השער; רק-כישלון-קטלני-של-הריכוז-עצמו
// מחזיר ok:false עם-השגיאה-בשמה.
export const dynamic = 'force-dynamic'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function GET() {
  const generatedAt = new Date().toISOString()
  try {
    const anchors = await collectAnchors()
    const summary = summarize(anchors)
    return NextResponse.json({
      ok: true,
      networkStatus: summary.networkStatus,
      counts: summary.counts,
      anchors,
      generatedAt,
    })
  } catch (e) {
    // לא-אמור-לקרות (הכל-מגון-פר-עוגן) — אך-גם-המגן-מדווח-כן
    return NextResponse.json(
      { ok: false, error: errMsg(e), networkStatus: 'critical', anchors: [], generatedAt },
      { status: 500 }
    )
  }
}

export async function POST(req: Request) {
  const generatedAt = new Date().toISOString()
  try {
    const t0 = Date.now()
    const anchors = await collectAnchors()
    const summary = summarize(anchors)
    const subject = new URL(req.url).searchParams.get('subject')

    // POST בלי-subject = דגימה בלבד (בלי-חתימה) — כמו-GET
    if (subject !== 'hub-check') {
      return NextResponse.json({
        ok: true,
        networkStatus: summary.networkStatus,
        counts: summary.counts,
        anchors,
        generatedAt,
      })
    }

    // חתימת-AUDIT בשרשרת — רשומת-ראייה אחת לבדיקה-ידנית:
    // ספירת-עוגנים-לפי-מצב נחתמת ב-outputHash; errorClass כן כשהרשת-אינה-פעילה.
    const entry = await appendLedger({
      taskId: null,
      kind: 'AUDIT',
      status: 'DONE',
      worker: 'network-hub',
      attempts: 1,
      durationMs: Date.now() - t0,
      errorClass: summary.networkStatus === 'active' ? null : `network-${summary.networkStatus}`,
      outputHash: sha256Short(
        JSON.stringify({ networkStatus: summary.networkStatus, counts: summary.counts })
      ),
    })

    return NextResponse.json({
      ok: true,
      networkStatus: summary.networkStatus,
      counts: summary.counts,
      anchors,
      generatedAt,
      signed: { id: entry.id, hash: entry.hash, kind: entry.kind, worker: entry.worker },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: errMsg(e), networkStatus: 'critical', anchors: [], generatedAt },
      { status: 500 }
    )
  }
}
