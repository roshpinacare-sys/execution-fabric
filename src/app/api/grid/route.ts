import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// שער-הדשבורד לאיבר-הגריד :3070 — fail-closed, כנות-מלאה
export async function GET() {
  try {
    const [gridRes, ffRes] = await Promise.all([
      fetch('http://127.0.0.1:3070/grid', { signal: AbortSignal.timeout(8_000) }),
      fetch('http://127.0.0.1:3070/ff', { signal: AbortSignal.timeout(15_000) }).catch(() => null),
    ])
    if (!gridRes.ok) {
      return NextResponse.json({ ok: false, error: `grid HTTP ${gridRes.status}` }, { status: 502 })
    }
    const grid = await gridRes.json()
    const ff = ffRes && ffRes.ok ? await ffRes.json().catch(() => null) : null
    return NextResponse.json({ ok: true, grid, ff: ff?.ff ?? null })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'איבר-הגריד-לא-מגיב' },
      { status: 502 },
    )
  }
}
