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
// Task-113 מדידה-חיה: פרמטר-ה-condenser הוא מחרוזת-בודדת ([[a]] נכשל-תמיד
// "Bad Cast: Invalid cast from array_type to string"); for_sale הוא-מילי-יחידות
// של-הנכס-הנמכר (base). אפס-המצאה — כל-שדה נגזר-מהשרשרת.
export type OpenOrder = {
  orderid: number
  account: string
  side: 'buy' | 'sell'
  price: number // SBD לכל-STEEM
  amountSteem: number
  amountSbd: number
  created: string
}
export async function getOpenOrders(account: string): Promise<RpcResult<OpenOrder[]>> {
  const r = await rpc<
    Array<{ orderid: number; seller: string; for_sale: number; sell_price: { base: string; quote: string }; real_price: string; created: string }>
  >('condenser_api.get_open_orders', [account])
  if (!r.ok) return r
  const out = (r.data ?? [])
    .map((o) => {
      const base = o.sell_price?.base ?? ''
      const price = parseFloat(o.real_price ?? '0')
      const forSale = Number(o.for_sale ?? 0) / 1000 // מילי→יחידות של-הנכס-הנמכר
      if (base.includes('SBD')) {
        // מוכרים SBD לקנות STEEM — קנייה
        return {
          orderid: o.orderid,
          account: o.seller,
          side: 'buy' as const,
          price,
          amountSteem: price > 0 ? forSale / price : 0,
          amountSbd: forSale,
          created: o.created,
        }
      }
      // מוכרים STEEM לקבל SBD — מכירה
      return {
        orderid: o.orderid,
        account: o.seller,
        side: 'sell' as const,
        price,
        amountSteem: forSale,
        amountSbd: forSale * price,
        created: o.created,
      }
    })
    .filter((o) => o.price > 0 && o.amountSteem > 0)
  return { ok: true, data: out }
}

// ── מילויים-אמיתיים-מהיסטוריית-החשבון (limit_order_fill) ────────────────────
// Task-113: גילוי-מילויים-חי-בלי-תלות-בסינון-RPC-שברירי — מביאים-חלון-אחרון
// לא-מסונן ומסננים-בקוד. orderid-שלנו יכול-להופיע כ-open_orderid (פקודה-סבילה
// שנאכלה) או כ-current_orderid (הפקודה-החוצה). שדה-מזהה-אחד: orderid.
export type ChainFill = {
  at: string
  orderid: number
  side: 'buy' | 'sell'
  price: number // SBD/STEEM
  steem: number
  sbd: number
  counterparty: string | null
}
export async function getAccountFills(account: string, last = 300): Promise<RpcResult<ChainFill[]>> {
  const r = await rpc<Array<[number, { timestamp: string; op: [string, Record<string, unknown>] }]>>(
    'condenser_api.get_account_history',
    [account, -1, last],
  )
  if (!r.ok) return r
  const out: ChainFill[] = []
  for (const [, item] of r.data ?? []) {
    const [name, body] = item.op ?? []
    if (name !== 'limit_order_fill') continue
    const steemStr = String(body.current_pays ?? '').includes('STEEM') ? String(body.current_pays) : String(body.open_pays ?? '')
    const sbdStr = String(body.current_pays ?? '').includes('SBD') ? String(body.current_pays) : String(body.open_pays ?? '')
    const steem = parseFloat(steemStr) || 0
    const sbd = parseFloat(sbdStr) || 0
    if (!(steem > 0) || !(sbd > 0)) continue
    // אם-אנחנו-ה-taker (current_owner=אנחנו) הפקודה-שלנו-היא current_orderid; כסביל — open_orderid
    const ourIsCurrent = String(body.current_owner ?? '') === account
    const orderid = Number((ourIsCurrent ? body.current_orderid : body.open_orderid) ?? 0)
    if (!(orderid > 0)) continue
    out.push({
      at: item.timestamp,
      orderid,
      side: ourIsCurrent ? 'sell' : 'buy', // כשהפקודה-שלנו-פגעה-בספר: current=הצד-שלנו
      price: sbd / steem,
      steem,
      sbd,
      counterparty: (ourIsCurrent ? String(body.open_owner ?? '') : String(body.current_owner ?? '')) || null,
    })
  }
  return { ok: true, data: out }
}

// ── קו-הזהות-החוץ (steemUsd/sbdUsd) — עוגן-מדיניות-המכירה ───────────────────
// Task-113: מדיניות-מדודה (grid-beat R24): אף-מכירת-STEEM-מתחת-לקו-הזהות.
// המקור-החיץ-ציבורי; כשל = מחיר-אחרון-ידוע (cache) ואם-אין → null → fail-honest:
// המדיניות נופלת-למצב-השמרני (אין-מכירות-מתחת-ל-bestAsk הקיים).
export type ExternalMarks = { steemUsd: number; sbdUsd: number; at: string } | null
let marksCache: ExternalMarks = null
let marksAt = 0
export async function getExternalMarks(): Promise<ExternalMarks> {
  if (marksCache && Date.now() - marksAt < 10 * 60_000) return marksCache
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=steem,steem-dollars&vs_currencies=usd', {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const j = (await res.json()) as { steem?: { usd?: number }; 'steem-dollars'?: { usd?: number } }
    const steemUsd = j.steem?.usd ?? 0
    const sbdUsd = j['steem-dollars']?.usd ?? 0
    if (!(steemUsd > 0) || !(sbdUsd > 0)) throw new Error('marks incomplete')
    marksCache = { steemUsd, sbdUsd, at: new Date().toISOString() }
    marksAt = Date.now()
    return marksCache
  } catch {
    return marksCache // כנות: ייתכן-null — הקורא חייב-להתמודד
  }
}
