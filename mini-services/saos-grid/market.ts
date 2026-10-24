// ===== לקוח-שוק-Steem — קריאה-ציבורית-בלבד, fail-closed, אפס-סודות =====
// עוגן-אמת: כל-מחיר-וכל-יתרה מגיעים-מ-RPC-ציבורי; שגיאה = תשובת-שגיאה-גלויה, לא-המצאה.
//
// Task-135 §3 (מנדט-הבעלים): "הפרוטוקול מסתמך על צמתים-ציבוריים-הסובלים-ממגבלות-קצב"
// → עתה: רשת-failover-מלאה (mesh.ts) — שובר-מעגלים-פר-צומת + הצמדה-דבקה + מדידות-חי.
// הצמתים: סטימיט-רשמי + 3 צמתים-ציבוריים-מדודים; STEEM_RPC-ישן (env) קודם-אם-קיים.
import { RpcMesh, type MeshEndpoint } from './mesh'

function parseEndpoints(): MeshEndpoint[] {
  const out: MeshEndpoint[] = []
  const raw = process.env.STEEM_RPC_ENDPOINTS ?? ''
  for (const part of raw.split(',')) {
    const s = part.trim()
    if (!s) continue
    const i = s.indexOf('=')
    if (i > 0) out.push({ name: s.slice(0, i), url: s.slice(i + 1) })
    else out.push({ name: `node-${out.length + 1}`, url: s })
  }
  if (out.length === 0) {
    const legacy = process.env.STEEM_RPC
    if (legacy) out.push({ name: 'env-legacy', url: legacy })
    out.push(
      { name: 'steemit', url: 'https://api.steemit.com' },
      { name: 'justyy', url: 'https://api.justyy.com' },
      { name: 'boylikegirl', url: 'https://steemapi.boylikegirl.club' },
      { name: 'steampool', url: 'https://rpc.steampool.com' },
    )
  }
  return out
}

export const steemMesh = new RpcMesh(parseEndpoints(), { timeoutMs: 8_000, openAfterFails: 3, halfOpenAfterMs: 30_000 })
export function meshHealth() {
  return steemMesh.health()
}

export type RpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

async function rpc<T>(method: string, params: unknown[]): Promise<RpcResult<T>> {
  const r = await steemMesh.call<T>(method, params)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, data: r.data }
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
  // Task-114 (נמדד-בדם 22:50Z): על-פקודות-חיות השדה real_price חוזר "0.00000000000000000"
  // (המדידה: 38-פקודות-על-השרשרת, getOpenOrders-החזירה-0) — המחיר-האמיתי-חי-ב-sell_price
  // (base/quote). המחיר = quote/base — תמיד SBD-ל-STEEM; for_sale-הוא-הנכס-הנמכר (base) במילי.
  const out = (r.data ?? [])
    .map((o) => {
      const base = o.sell_price?.base ?? ''
      const quote = o.sell_price?.quote ?? ''
      const baseN = parseFloat(base) || 0
      const quoteN = parseFloat(quote) || 0
      const price = baseN > 0 && quoteN > 0 ? quoteN / baseN : 0
      const forSale = Number(o.for_sale ?? 0) / 1000 // מילי→יחידות של-הנכס-הנמכר (base)
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
export async function getAccountFills(account: string, last = 100): Promise<RpcResult<ChainFill[]>> {
  // מדידה-חיה: ה-condenser מגביל get_account_history ל-100
  const n = Math.max(1, Math.min(last, 100))
  const r = await rpc<Array<[number, { timestamp: string; op: [string, Record<string, unknown>] }]>>(
    'condenser_api.get_account_history',
    [account, -1, n],
  )
  if (!r.ok) return r
  const out: ChainFill[] = []
  for (const [, item] of r.data ?? []) {
    const [name, body] = item.op ?? []
    // Task-114 (נמדד-בדם 23:00Z): שם-האופ-האמיתי-בשרשרת-הוא fill_order (נמדד: 6-מילויים-
    // אמיתיים-בהיסטוריה-שחולצו-כ-0 בגלל-סינון-שגוי limit_order_fill). שדות: current_*/open_*.
    if (name !== 'fill_order') continue
    const steemStr = String(body.current_pays ?? '').includes('STEEM') ? String(body.current_pays) : String(body.open_pays ?? '')
    const sbdStr = String(body.current_pays ?? '').includes('SBD') ? String(body.current_pays) : String(body.open_pays ?? '')
    const steem = parseFloat(steemStr) || 0
    const sbd = parseFloat(sbdStr) || 0
    if (!(steem > 0) || !(sbd > 0)) continue
    // אם-אנחנו-ה-taker (current_owner=אנחנו) מה-שאנחנו-משלמים-הוא current_pays; כסביל — open_pays.
    // הצד-נקבע-לפי-מה-שאנחנו-משלמים: משלמים-SBD → קנינו-STEEM; משלמים-STEEM → מכרנו.
    const ourIsCurrent = String(body.current_owner ?? '') === account
    const wePay = ourIsCurrent ? String(body.current_pays ?? '') : String(body.open_pays ?? '')
    const orderid = Number((ourIsCurrent ? body.current_orderid : body.open_orderid) ?? 0)
    if (!(orderid > 0)) continue
    out.push({
      at: item.timestamp,
      orderid,
      side: wePay.includes('SBD') ? 'buy' : 'sell',
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
// מדידה-חיה: coingecko-מוגבל-קצב (429 נמדד) → STEEM מול-Binance (STEEMUSDT,
// אומת-חי: 0.05575). sbdUsd-רק-ממקור-אמיתי: אין-מקור → sbdUsd=0 → הקורא
// מדליק-רצפה-null (מצב-שמרני: אין-מכירות-מתחת-ל-bestAsk). אפס-המצאות.
export type ExternalMarks = { steemUsd: number; sbdUsd: number; at: string; stale?: boolean } | null
let marksCache: ExternalMarks = null
let marksAt = 0

// Task-117 (נמדד-בדם 01:04Z): קריסת-עוגן — binance (איפוס-IP), coingecko (429-לסירוגין)
// → identityLine=null → הרצפה-קרסה-ל-bestAsk → מכירות-חיות-מתחת-לערך-החוץ (0.1029 < 0.1101
// פאריטי) — הפרת-דוקטרינה. שלוש-שכבות: (1) שלושה-מקורות-STEEM (binance→coingecko→
// coinpaprika — שלושתם נמדדו-חי); (2) עוגן-אחרון-ידוע-טוב-בדיסק (state/marks.json,
// תוקף-24h); (3) במנוע: אין-עוגן = איסור-מכירות מוחלט (fail-closed), לעולם-לא-מכירה-
// מתחת-לערך-החוץ. העוגן-מהדיסק נשמר-במטמון-קצר (60s) כדי-לנסות-חי-שוב-מהר.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const MARKS_FILE = join(import.meta.dir, 'state', 'marks.json')
const MARKS_MAX_AGE_MS = 24 * 3600_000

// Task-120 מדידה-חיה (02:20-02:30Z): העוגן התנדנד ±0.9% בין-המקורות (binance↔coingecko —
// המקור-שמגיב-ראשון מנצח-את-המרוץ-מחדש-בכל-רענון) → הרצפה קפצה → requote מלא של-הסולם
// בכל-קפיצה (נמדדו 433 ביטולים/שעה). תיקון-כפול:
//   (1) עוגן-דביק: המקור-שהצליח-אחרון נשאר-ראשון-בתור — אין-מרוץ-מחדש כל-עוד-הוא-חי;
//   (2) חגורת-מתים: שינוי-זהות בתוך GRID_ANCHOR_DEADBAND_PCT (ברירת-מחדל 0.4%, גבולות 0.05-2)
//       לא מזיז את-העוגן — הסולם נח על-רעש-מדידה, נע רק על-תזוזה-אמיתית.
type SteemSourceName = 'binance' | 'coingecko' | 'coinpaprika'
let stickySteemSource: SteemSourceName | null = null

function envNum(v: string | undefined, d: number): number {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) ? n : d
}
const ANCHOR_DEADBAND_PCT = Math.min(2, Math.max(0.05, envNum(process.env.GRID_ANCHOR_DEADBAND_PCT, 0.4)))

async function fetchSteemBinance(): Promise<number> {
  // binance (נמדד: זמין-לסירוגין — איפוס-IP-חוזר)
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=STEEMUSDT', { signal: AbortSignal.timeout(6000), cache: 'no-store' })
    if (res.ok) { const p = parseFloat(((await res.json()) as { price?: string }).price ?? '0'); if (Number.isFinite(p) && p > 0 && p < 1e3) return p }
  } catch { /* מקור-הבא */ }
  return 0
}
async function fetchSteemCoingecko(): Promise<number> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=steem&vs_currencies=usd', { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    if (res.ok) { const p = parseFloat(String(((await res.json()) as { steem?: { usd?: number } }).steem?.usd ?? '0')); if (Number.isFinite(p) && p > 0 && p < 1e3) return p }
  } catch { /* מקור-הבא */ }
  return 0
}
async function fetchSteemPaprika(): Promise<number> {
  // coinpaprika (נמדד-חי 00:48Z ו-01:06Z: 0.0552)
  try {
    const res = await fetch('https://api.coinpaprika.com/v1/tickers/steem-steem', { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    if (res.ok) { const p = parseFloat(String(((await res.json()) as { quotes?: { USD?: { price?: number } } }).quotes?.USD?.price ?? '0')); if (Number.isFinite(p) && p > 0 && p < 1e3) return p }
  } catch { /* כנות: אין-מדידה-STEEM */ }
  return 0
}

const STEEM_SOURCES: Array<[SteemSourceName, () => Promise<number>]> = [
  ['binance', fetchSteemBinance],
  ['coingecko', fetchSteemCoingecko],
  ['coinpaprika', fetchSteemPaprika],
]

async function fetchSteemUsd(): Promise<number> {
  const order = [...STEEM_SOURCES]
  if (stickySteemSource) {
    const i = order.findIndex(([n]) => n === stickySteemSource)
    if (i > 0) order.unshift(order.splice(i, 1)[0]) // הדביק-ראשון
  }
  for (const [name, fn] of order) {
    const p = await fn()
    if (p > 0) { stickySteemSource = name; return p }
  }
  return 0
}

async function fetchSbdUsd(): Promise<number> {
  // SBD: coingecko הוא-המקור-היחיד-שנמדד-חי (coinpaprika: אין-ticker-sbd)
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=steem-dollars&vs_currencies=usd', { signal: AbortSignal.timeout(8000), cache: 'no-store' })
    if (res.ok) { const p = parseFloat(String(((await res.json()) as { 'steem-dollars'?: { usd?: number } })['steem-dollars']?.usd ?? '0')); if (Number.isFinite(p) && p > 0 && p < 1e3) return p }
  } catch { /* כנות: אין-מדידה-SBD */ }
  return 0
}

export async function getExternalMarks(): Promise<ExternalMarks> {
  if (marksCache && Date.now() - marksAt < (marksCache.stale ? 60_000 : 10 * 60_000)) return marksCache
  let steemUsd = 0
  let sbdUsd = 0
  steemUsd = await fetchSteemUsd()
  sbdUsd = await fetchSbdUsd()
  if (steemUsd > 0 && sbdUsd > 0) {
    // Task-120 חגורת-מתים: אם-הזהות-הטרייה קרובה-לעוגן-המיושם יותר-מ-DEADBAND —
    // העוגן-הקודם נשאר (רק-מאריכים-מטמון). הסולם לא-נסחט-על-רעש-בין-מקורות/בורסות.
    const candidateIdentity = steemUsd / sbdUsd
    // Task-121 audit fix (fingerprint saos-grid:market-single-source-anchor-no-cross-validation-or-bounds):
    // חגורת-שפיות-מוחלטת + חגורת-צעד: ערך-זהות מחוץ-ל-[0.01,10000] או קפיצה-חד-רענון >25%
    // נדחים — העוגן-האחרון-הטוב קופא (מקור-שקרן/פגום לא מזיז-את-הרצפה). Infinity/NaN נפסלים
    // כבר-ב-parsers (Number.isFinite). מדידות-אמת (Task-120): תנודות-אמת 0.28-0.9% — 25% גבוה-בביטחון.
    if (!(candidateIdentity > 0.01 && candidateIdentity < 10000)) {
      console.warn(`[market] anchor-plausibility-reject: candidateIdentity=${candidateIdentity} (steemUsd=${steemUsd} sbdUsd=${sbdUsd}) — מקור-נפסל`)
      if (marksCache) { marksAt = Date.now(); return marksCache }
      return { steemUsd: 0, sbdUsd: 0, at: new Date().toISOString(), stale: true } as ExternalMarks
    }
    const prevIdentity = marksCache && !marksCache.stale && marksCache.sbdUsd > 0
      ? marksCache.steemUsd / marksCache.sbdUsd
      : 0
    if (prevIdentity > 0 && Math.abs(candidateIdentity - prevIdentity) / prevIdentity > 0.25) {
      console.warn(`[market] anchor-step-bound-reject: ${prevIdentity.toFixed(5)} -> ${candidateIdentity.toFixed(5)} (>25% צעד-חד) — העוגן-הקודם קופא`)
      marksAt = Date.now()
      return marksCache
    }
    if (prevIdentity > 0 && Math.abs(candidateIdentity - prevIdentity) / prevIdentity < ANCHOR_DEADBAND_PCT / 100) {
      marksAt = Date.now()
      return marksCache
    }
    marksCache = { steemUsd, sbdUsd, at: new Date().toISOString() }
    marksAt = Date.now()
    try {
      mkdirSync(join(import.meta.dir, 'state'), { recursive: true })
      writeFileSync(MARKS_FILE, JSON.stringify(marksCache))
    } catch { /* כנות: דיסק-לא-קריטי */ }
    return marksCache
  }
  // נפילה-כנה: עוגן-אחרון-ידוע-טוב-מהדיסק (תוקף-24h) — מסומן stale
  try {
    if (existsSync(MARKS_FILE)) {
      const j = JSON.parse(readFileSync(MARKS_FILE, 'utf-8')) as { steemUsd: number; sbdUsd: number; at: string }
      const age = Date.now() - new Date(j.at).getTime()
      if (j.steemUsd > 0 && j.sbdUsd > 0 && Number.isFinite(age) && age < MARKS_MAX_AGE_MS) {
        marksCache = { steemUsd: j.steemUsd, sbdUsd: j.sbdUsd, at: j.at, stale: true }
        marksAt = Date.now()
        return marksCache
      }
    }
  } catch { /* כנות: עוגן-דיסק-פגום */ }
  return marksCache // null — המנוע יעשה fail-closed: איסור-מכירות מוחלט
}
