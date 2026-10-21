import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// שער-הדשבורד לשוק-החריף (Task 106): הדקס-הריבוני :3010 + איבר-הארב :3071 + עורק-FF.
// fail-closed פר-מקור: כל-חלק-נכשל-מדווח-בשמו, אף-מספר-לא-מומצא.
export async function GET() {
  const [arbRes, dexRes, ffRes] = await Promise.all([
    fetch('http://127.0.0.1:3071/state', { signal: AbortSignal.timeout(8_000) }).catch(() => null),
    fetch('http://127.0.0.1:3010/saos-dex/api/dex/state', { signal: AbortSignal.timeout(8_000) }).catch(() => null),
    fetch('http://127.0.0.1:3070/ff', { signal: AbortSignal.timeout(15_000) }).catch(() => null),
  ])

  let arb: unknown = null
  let arbError: string | null = null
  if (arbRes && arbRes.ok) arb = await arbRes.json().catch(() => null)
  else arbError = arbRes ? `HTTP ${arbRes.status}` : 'לא-מגיב'

  let dex: unknown = null
  let dexError: string | null = null
  if (dexRes && dexRes.ok) {
    const j = (await dexRes.json().catch(() => null)) as {
      state?: { height?: number; fills?: number; liveOrders?: number; halted?: boolean; tps?: number }
      markets?: Array<{ base: string; quote: string; fair: number; bestBid: number | null; bestAsk: number | null; spreadBps: number }>
      wallets?: Array<{ name: string; balances: Record<string, number>; locked: Record<string, number> }>
    } | null
    if (j) {
      dex = {
        height: j.state?.height ?? null,
        fills: j.state?.fills ?? null,
        liveOrders: j.state?.liveOrders ?? null,
        halted: j.state?.halted ?? null,
        tps: j.state?.tps ?? null,
        markets: (j.markets ?? [])
          .slice(0, 8)
          .map((m) => ({ key: `${m.base}/${m.quote}`, fair: m.fair, bestBid: m.bestBid, bestAsk: m.bestAsk, spreadBps: m.spreadBps })),
        hands: (j.wallets ?? [])
          .filter((w) => ['arb-peg', 'grid-mm', 'treasury', 'operator'].includes(w.name))
          .map((w) => ({ name: w.name, balances: w.balances, locked: w.locked })),
      }
    } else dexError = 'תשובה-לא-תקינה'
  } else dexError = dexRes ? `HTTP ${dexRes.status}` : 'לא-מגיב'

  const ff = ffRes && ffRes.ok ? await ffRes.json().catch(() => null) : null

  return NextResponse.json({
    ok: arb !== null || dex !== null,
    arb, arbError, dex, dexError,
    ff: (ff as { ff?: unknown } | null)?.ff ?? null,
  })
}
