// ===== לקוח-שוק-Steem — קריאה-ציבורית-בלבד, fail-closed, אפס-סודות =====
// עוגן-אמת: כל-מחיר-וכל-יתרה מגיעים-מ-RPC-ציבורי; שגיאה = תשובת-שגיאה-גלויה, לא-המצאה.

const RPC_URL = process.env.STEEM_RPC ?? 'https://api.steemit.com'
const RPC_TIMEOUT_MS = 8_000

export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function rpc<T>(method: string, params: unknown[]): Promise<RpcResult<T>> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = (await res.json()) as { result?: T; error?: { message?: string } }
    if (j.error) return { ok: false, error: j.error.message ?? 'rpc error' }
    if (j.result === undefined || j.result === null) return { ok: false, error: 'empty result' }
    return { ok: true, data: j.result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── פקודת-שוק ────────────────────────────────────────────────────────────────
export type OrderBookEntry = { price: number; steem: number; sbd: number }
export type OrderBook = {
  bids: OrderBookEntry[] // קונים (SBD-עבור-STEEM)
  asks: OrderBookEntry[] // מוכרים
  bestBid: number | null
  bestAsk: number | null
  mid: number | null
  bidVolSteem: number // נזילות-צד-קנייה (STEEM-מוצעים)
  askVolSteem: number // נזילות-צד-מכירה
}

type RawOrder = {
  order_price: { base: string; quote: string }
  real_price: string
  steem: number // מילי-יחידות (×1000)
  sbd?: number // מילי-יחידות (×1000)
}

function parseSide(raw: RawOrder[] | undefined): OrderBookEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((o) => ({
      price: parseFloat(o.real_price ?? '0'), // SBD-לכל-STEEM — מוכן-מהשרת
      steem: (o.steem ?? 0) / 1000, // מילי→יחידות
      sbd: (o.sbd ?? 0) / 1000,
    }))
    .filter((e) => e.price > 0 && e.steem > 0)
}

export async function getOrderBook(limit = 50): Promise<RpcResult<OrderBook>> {
  const r = await rpc<{ bids: RawOrder[]; asks: RawOrder[] }>('condenser_api.get_order_book', [limit])
  if (!r.ok) return r
  const bids = parseSide(r.data.bids) // ממוין-מהחזק-לחלש מהשרת
  const asks = parseSide(r.data.asks)
  const bestBid = bids[0]?.price ?? null
  const bestAsk = asks[0]?.price ?? null
  // בפקודת-השוק: base=SBD, quote=STEEM → מחיר=SBD/STEEM
  return {
    ok: true,
    data: {
      bids,
      asks,
      bestBid,
      bestAsk,
      mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk),
      bidVolSteem: bids.reduce((s, e) => s + e.steem, 0),
      askVolSteem: asks.reduce((s, e) => s + e.steem, 0),
    },
  }
}

// ── היסטוריית-מסחר (לאומדן-תנודתיות) ────────────────────────────────────────
export type Trade = { price: number; amount: number; at: string }
export async function getRecentTrades(limit = 50): Promise<RpcResult<Trade[]>> {
  const stop = new Date()
  const start = new Date(stop.getTime() - 3 * 60 * 60_000)
  const r = await rpc<Array<{ time: string; current_pays: string; open_pays: string }>>(
    'condenser_api.get_trade_history',
    [start.toISOString().slice(0, 19), stop.toISOString().slice(0, 19), limit],
  )
  if (!r.ok) return r
  const trades = (Array.isArray(r.data) ? r.data : [])
    .map((t) => {
      // קנייה: current_pays=SBD, open_pays=STEEM → מחיר=SBD/STEEM (ולהפך)
      const cp = t.current_pays ?? ''
      const op = t.open_pays ?? ''
      const sbdStr = cp.includes('SBD') ? cp : op
      const steemStr = cp.includes('STEEM') ? cp : op
      const n = parseFloat(sbdStr ?? '0')
      const d = parseFloat(steemStr ?? '0')
      const amt = parseFloat((steemStr.match(/([\d.]+)\s*STEEM/) ?? [])[1] ?? '0')
      return { price: d > 0 ? n / d : 0, amount: amt, at: t.time }
    })
    .filter((t) => t.price > 0)
  return { ok: true, data: trades }
}

// ── יתרות-חשבון ──────────────────────────────────────────────────────────────
export type AccountBalances = {
  account: string
  steem: number
  sbd: number
  found: boolean
}
export async function getAccounts(names: string[]): Promise<RpcResult<AccountBalances[]>> {
  const r = await rpc<Array<{ name: string; balance: string; sbd_balance: string } | null>>(
    'condenser_api.get_accounts',
    [names],
  )
  if (!r.ok) return r
  const out = names.map<AccountBalances>((n) => {
    const a = (r.data ?? []).find((x) => x?.name === n)
    return {
      account: n,
      steem: a ? parseFloat(a.balance?.replace(' STEEM', '') ?? '0') : 0,
      sbd: a ? parseFloat(a.sbd_balance?.replace(' SBD', '') ?? '0') : 0,
      found: !!a,
    }
  })
  return { ok: true, data: out }
}

// ── פקודות-פתוחות-לחשבון (קריאה-ציבורית) ────────────────────────────────────
export type OpenOrder = {
  orderid: number
  account: string
  side: 'buy' | 'sell'
  price: number
  amountSteem: number
  created: string
}
export async function getOpenOrders(account: string): Promise<RpcResult<OpenOrder[]>> {
  const r = await rpc<
    Array<{ orderid: number; seller: string; for_sale: number; sell_price: { base: string; quote: string }; real_price: string; created: string }>
  >('condenser_api.get_open_orders', [[account]])
  if (!r.ok) return r
  const out = (r.data ?? []).map<OpenOrder>((o) => ({
    orderid: o.orderid,
    account: o.seller,
    side: (o.sell_price?.base ?? '').includes('SBD') ? 'buy' : 'sell',
    price: parseFloat(o.real_price ?? '0'),
    amountSteem: parseFloat(o.for_sale.toString()) / ((o.sell_price?.base ?? '').includes('SBD') && parseFloat(o.real_price ?? '0') > 0 ? parseFloat(o.real_price) : 1),
    created: o.created,
  }))
  return { ok: true, data: out }
}
