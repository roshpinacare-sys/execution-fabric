import { NextResponse } from 'next/server'

// דופק-התנועה (Task 102) — החזית-של-איבר-המדידה (saos-metrics :3060).
// התשובה-המדידה לשאלה "האם-הרשת זורמת?": מהירות-תנועה אמת (דלתות-מונים כנות),
// סדרת-זמן לגרף-צמיחה, ומצב-איברים אחרון. איבר-מדידה-שנפל = fail-closed כן
// (ok:false + הכיוון-בשמו) — אף-המצאה-תנועה. כל-הקריאות-שרת-בלבד (127.0.0.1).
export const dynamic = 'force-dynamic'

const METRICS = 'http://127.0.0.1:3060'

interface SampleRow {
  at: string
  ledgerTotal: number
  ledgerDone: number
  ledgerFailed: number
  queueQueued: number
  queueRunning: number
  hbTicks: number
  hbExecuted: number
  hbGitPushes: number
  witnessTotal: number
  organsUp: number
}

interface Velocity {
  windowMinutes: number
  ledgerEntries: number
  completions: number
  heartExecutions: number
  gitPushes: number
  secondsSinceLastLedger: number | null
  counterResets: number
}

export async function GET() {
  try {
    const [nowRes, seriesRes, organsRes] = await Promise.all([
      fetch(`${METRICS}/now`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
      fetch(`${METRICS}/series?minutes=180`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
      fetch(`${METRICS}/organs`, { signal: AbortSignal.timeout(5000), cache: 'no-store' }),
    ])

    if (!nowRes.ok || !seriesRes.ok || !organsRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `איבר-המדידה לא-עונה (now:${nowRes.status} series:${seriesRes.status} organs:${organsRes.status})`,
        },
        { status: 502 },
      )
    }

    const now = (await nowRes.json()) as { last: SampleRow | null; velocity1h: Velocity; velocity24h: Velocity }
    const series = (await seriesRes.json()) as { series: SampleRow[] }
    const organs = (await organsRes.json()) as { organs: { name: string; up: boolean; error: string | null }[] }

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      last: now.last,
      velocity1h: now.velocity1h,
      velocity24h: now.velocity24h,
      series: series.series.slice(-120),
      organs: organs.organs,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    )
  }
}
