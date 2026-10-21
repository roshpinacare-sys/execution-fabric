import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// שער-הדשבורד למועצת-השולחן הריבונית :3072 (Task 107) — fail-closed, כנות-מלאה.
// אוסף-גם-את-ה-backtest-המדיד מהגריד :3070 (דפוס-AutoHedge) — כשירד, יורד-בשם-המצב.
export async function GET() {
  try {
    const [stateRes, cardsRes, btRes] = await Promise.all([
      fetch('http://127.0.0.1:3072/state', { signal: AbortSignal.timeout(8_000), cache: 'no-store' }),
      fetch('http://127.0.0.1:3072/cards', { signal: AbortSignal.timeout(8_000), cache: 'no-store' }).catch(() => null),
      fetch('http://127.0.0.1:3070/backtest?stepPct=0.75', { signal: AbortSignal.timeout(14_000), cache: 'no-store' }).catch(() => null),
    ])
    if (!stateRes.ok) {
      return NextResponse.json({ ok: false, error: `council HTTP ${stateRes.status}` }, { status: 502 })
    }
    const state = await stateRes.json()
    const cards = cardsRes && cardsRes.ok ? await cardsRes.json().catch(() => null) : null
    const backtest = btRes && btRes.ok ? await btRes.json().catch(() => null) : null
    return NextResponse.json({
      ok: true,
      state,
      cards: cards?.ok ? cards.cards : [],
      backtest: backtest && backtest.ok ? backtest : null,
      backtestError: backtest && !backtest.ok ? backtest.error : null,
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'מועצת-השולחן-לא-מגיבה' },
      { status: 502 },
    )
  }
}
