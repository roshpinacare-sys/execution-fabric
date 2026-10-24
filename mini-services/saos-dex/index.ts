// ═══════════════════════════════════════════════════════════════════════════
// saos-dex — הדקס-הריבוני (Task 106) — בנייה-מחדש (Task-131, לקח-הדם-החי 15:28)
// ═══════════════════════════════════════════════════════════════════════════
// לקח-הדם: הדקס-הישן חי-כ-clone-מקונן (mini-services/repos/saos-dex) — המימוש-שלו מעולם
// לא נשמר בשום-גיט (repo-מקונן = gitlink בעץ-החוץ; הקבצים-עצמם לא נדחפו), ואתחול-פלטפורמה
// מחק-את-התיקיה → הזקיפה re-clone-ה-מה-origin וקיבלה-עץ-ריק-מהמימוש → לולאת-מוות.
// מעתה: הדקס איבר-מהשורה בעץ-הנצחי (mini-services/saos-dex) — מוגן-פעימת-גיט-אוטומטית,
// חסין-אתחול, והזקיפה מזניקה-אותו כמו-כל-איבר (bun run dev).
//
// חוזה-מדוד (מתוך-הצרכנים-החיים — saos-arb קריאות 177-430, dex-hot route, keeper probe):
//  GET  /saos-dex/api/dex/state          → { ok, state:{height,halted,fills,liveOrders,tps,assets},
//                                             markets[](שורש וגם state.markets), wallets[] }
//  GET  /saos-dex/api/dex/price-proof    → { ok, internal:{wsteemUsdsMu}, external:{steemUsd,feedOk,feedStale} }
//  GET  /saos-dex/api/dex/my-orders      → { ok, orders:[{id,base,quote,side,price,amount,filled}] } (?issuer=)
//  POST /saos-dex/api/dex/order          → { action:'order', base, quote, side, price, amount, issuer, postOnly?, ioc? }
//  POST /saos-dex/api/dex/transfer       → { from, to, asset, amount | amountMu }
//  POST /saos-dex/api/dex/fuel           → { to, amount }
//  POST /saos-dex/api/dex/wrap           → { action:'mint', asset, amount } — לארנת-האופרטור
//  Task-134 (§3/§7.1 — מנוע-ההחלפות-הפנימי):
//  GET  /saos-dex/api/dex/amm/state      → { ok, pools:[{id,base,quote,reserves,priceMu,feeBps,lpShares}] }
//  GET  /saos-dex/api/dex/amm/quote      → { ok, outMu, feeMu, priceAfterMu } ?base&quote&direction&amountInMu
//  POST /saos-dex/api/dex/amm-seed       → { base, quote, reserveBaseMu, reserveQuoteMu } — הזרמת-נזילות מארנק-האופרטור
//  POST /saos-dex/api/dex/amm-swap       → { trader, base, quote, direction, amountInMu, minOutMu } — החלפה-מיידית
//  GET  /saos-dex | /health              → חיות-כנה
// אימות-POST: x-saos-operator מול upload/dex-operator.env (נקרא-בזמן-ריצה; אפס-חשיפה).
// אריתמטיקה: µ-שלמים בלבד בכל-נתיבי-הכסף (mu = 1e-6); אפס-צפים-בפנקס.
// התמדה: bun:sqlite (state/dex.db) — פקודות/מילויים/ארנקות שורדים-הפעלה-מחדש.

import { Database } from 'bun:sqlite'
import { join, resolve } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { free, finalizeTaker, matchOrderCore, type Order, type WalletRec } from './engine'
import { applySwap, quoteSwap, seedPool, type Pool } from './amm'
import {
  allPoolRows,
  bookRows,
  createSqliteStore,
  ensureSchema,
  ensureWalletRow,
  getMeta,
  insertFillRow,
  insertPoolRow,
  myOrdersRows,
  placeOrderRow,
  poolByPairRow,
  seedWallets as seedWalletRows,
  saveWalletRow,
  setMeta,
  updatePoolRow,
  upsertLpPositionRow,
  walletRow,
} from './store'

const PORT = 3010 // פורט-קבוע — חוזה-האיברים (לעולם לא env)
const ROOT = resolve(import.meta.dir, '..', '..')
const STATE_DIR = join(import.meta.dir, 'state')
const DB_PATH = join(STATE_DIR, 'dex.db')
const HALT_PATH = join(STATE_DIR, 'halt.flag')
const OPERATOR_ENV = join(ROOT, 'upload', 'dex-operator.env')
const GRID_FF = process.env.SAOS_DEX_GRID_FF ?? 'http://127.0.0.1:3070/ff'

// ── השוק (חוזה-הארב: SPECS — חמשת-הזוגות; ערכי-זרע זהים ל-SEED שבארב) ────────
const MARKETS = [
  { base: 'WSTEEM', quote: 'USDS', refSeedMu: 120_000, refSource: 'seed' }, // STEEM≈$0.12
  { base: 'SAOS', quote: 'USDS', refSeedMu: 100_000, refSource: 'seed' },
  { base: 'WSBD', quote: 'USDS', refSeedMu: 1_000_000, refSource: 'seed' }, // SBD≈$1
  { base: 'PHIVE', quote: 'USDS', refSeedMu: 10_000, refSource: 'seed' },
  { base: 'ENERGY', quote: 'USDS', refSeedMu: 10_000, refSource: 'seed' },
]
// ידיים — זרעים זהים-ל-SPECS של הארב (מקור-אמת יחיד מתועד; הארב מממן-מהאוצר עד-הזרע-בלבד)
const HAND_SEEDS: Record<string, Record<string, number>> = {
  'arb-peg': { USDS: 150_000, WSTEEM: 60_000 },
  'grid-mm': { USDS: 150_000 },
  'mm-wsbd': { USDS: 100_000 },
  'depth-phive': { USDS: 40_000 },
  'depth-energy': { USDS: 40_000 },
  treasury: { USDS: 5_000_000, WSTEEM: 1_000_000, SAOS: 1_000_000, WSBD: 500_000, PHIVE: 500_000, ENERGY: 500_000 },
  operator: { USDS: 2_000_000, WSTEEM: 400_000 },
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
const db = new Database(DB_PATH)
// Task-132: ה-DDL, נגישי-השורות והחנות-חיים-ב-store.ts — ניתנים-לייבוא בטוח (בלי-פורט)
// כדי-ששכבת-ה-SQL תהיה-מכוסה-בדיקות (store.test.ts על :memory:) — ה-blind-spot
// שהשאיר את ה-INSERT-השבור חי-שבוע בלי-שאף-בדיקה יראה-אותו.
ensureSchema(db)
const seeded = seedWalletRows(db, HAND_SEEDS)
if (seeded > 0) log(`ארנקות-זרע נזרעו (${seeded}) — ערכי-SEED זהים-לארב, מתועדים`)

let height = Number(getMeta(db, 'height') ?? 0)
const bump = (): number => { height++; setMeta(db, 'height', String(height)); return height }

// נגישים-מקומיים (חתימות-זהות-למקור — אפס-שינוי-קריאות-במטפלים)
const wallet = (name: string): WalletRec | null => walletRow(db, name)
const saveWallet = (w: WalletRec): void => saveWalletRow(db, w)
const bookOf = (base: string, quote: string): { bids: Order[]; asks: Order[] } => bookRows(db, base, quote)
const store = createSqliteStore(db)

// ── מחיר-חוץ כן (מסילת-הגריד FF — cache 60ש׳; כשל = דגל-כנה, לא-המצאה) ────────
let ffCache: { at: number; steemUsd: number | null } = { at: 0, steemUsd: null }
async function externalSteemUsd(): Promise<{ steemUsd: number | null; feedOk: boolean; feedStale: boolean }> {
  if (Date.now() - ffCache.at > 60_000) {
    try {
      const res = await fetch(GRID_FF, { signal: AbortSignal.timeout(4_000), cache: 'no-store' })
      const j = (await res.json().catch(() => null)) as { ff?: { steemUsd?: number; price?: number } | number } | null
      const v = typeof j?.ff === 'number' ? j.ff : j?.ff?.steemUsd ?? j?.ff?.price ?? null
      ffCache = { at: Date.now(), steemUsd: typeof v === 'number' && v > 0 && v < 100 ? v : null }
    } catch {
      ffCache = { at: Date.now(), steemUsd: null }
    }
  }
  const stale = Date.now() - ffCache.at > 120_000
  return { steemUsd: ffCache.steemUsd, feedOk: ffCache.steemUsd !== null, feedStale: stale }
}

// ── פארים-חיים: fair = מחצי-הספר אם-יש-פקודות, אחרת-זרע-מתועד ────────────────
function marketView(base: string, quote: string) {
  const { bids, asks } = bookOf(base, quote)
  const bestBid = bids[0]?.priceMu ?? null
  const bestAsk = asks[0]?.priceMu ?? null
  const spec = MARKETS.find((m) => m.base === base && m.quote === quote)!
  const mid = bestBid !== null && bestAsk !== null ? Math.round((bestBid + bestAsk) / 2) : bestBid ?? bestAsk ?? null
  const fair = mid ?? spec.refSeedMu
  return {
    base, quote, key: `${base}/${quote}`, fair,
    bestBid, bestAsk,
    spreadBps: bestBid !== null && bestAsk !== null ? Math.round(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000) : 0,
    poolMid: null,
    refSource: mid !== null ? 'book' : spec.refSource,
  }
}

// ── ליבת-ההתאמה חיה ב-engine.ts (Task-132) — matchOrderCore(taker, store) ─────
// חילוץ-דטרמיניסטי עם הזרקת-אחסון; כל-האינווריאנטים-הכספיים מוכחים-בדיקה ב-engine.test.ts
// (מחיר-זמן, עסקה-במחיר-המייקר, חשבונאות-נעילות מדויקת, שימור-כספים, שומר-העקביות).

function operatorToken(): string | null {
  if (!existsSync(OPERATOR_ENV)) return null
  const line = readFileSync(OPERATOR_ENV, 'utf-8').split('\n').find((l) => l.startsWith('DEX_OPERATOR_TOKEN='))
  const v = line?.split('=').slice(1).join('=').trim()
  return v || null
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

// ── סטטוס-כן ─────────────────────────────────────────────────────────────────
function liveOrdersCount(): number {
  return (db.query("SELECT COUNT(*) c FROM orders WHERE status='open'").get() as { c: number }).c
}
function fillsTotal(): number {
  return (db.query('SELECT COUNT(*) c FROM fills').get() as { c: number }).c
}
function tps60s(): number {
  const since = new Date(Date.now() - 60_000).toISOString()
  const c = (db.query('SELECT COUNT(*) c FROM fills WHERE createdAt>=?').get(since) as { c: number }).c
  return Math.round((c / 60) * 100) / 100
}
function fullState() {
  const halted = existsSync(HALT_PATH)
  const markets = MARKETS.map((m) => marketView(m.base, m.quote))
  const assets: Record<string, { refPrice: number; refSource: string }> = {}
  for (const m of markets) {
    assets[m.base] = { refPrice: m.fair, refSource: m.refSource }
  }
  const ext = ffCache.steemUsd
  if (ext !== null) {
    assets['WSTEEM'] = { refPrice: Math.round(ext * 1_000_000), refSource: 'feed:grid-ff' }
  }
  const wallets = db.query('SELECT name,credits,balances,locked FROM wallets ORDER BY name').all().map((r) => {
    const w = r as { name: string; credits: number; balances: string; locked: string }
    return { name: w.name, credits: w.credits, balances: JSON.parse(w.balances), locked: JSON.parse(w.locked) }
  })
  const state = { height, halted, fills: fillsTotal(), liveOrders: liveOrdersCount(), tps: tps60s(), assets }
  // חוזה-כפול: markets בשורש (הספר-החי — כפי-שהארב-קורא) וגם state.markets (השדה-הפנימי)
  return { ok: true, state: { ...state, markets }, markets, wallets, at: new Date().toISOString() }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  const cors = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

  if (req.method === 'GET' && (p === '/health' || p === '/')) return new Response(JSON.stringify({ ok: true, service: 'saos-dex', port: PORT, height, at: new Date().toISOString() }), { headers: cors })
  if (req.method === 'GET' && p === '/saos-dex') return new Response(JSON.stringify({ ok: true, organ: 'saos-dex', height }), { headers: cors })

  if (p === '/saos-dex/api/dex/state' && req.method === 'GET') {
    return new Response(JSON.stringify(fullState()), { headers: cors })
  }

  if (p === '/saos-dex/api/dex/price-proof' && req.method === 'GET') {
    const mv = marketView('WSTEEM', 'USDS')
    const ext = await externalSteemUsd()
    return new Response(JSON.stringify({
      ok: true,
      internal: { wsteemUsdsMu: mv.fair },
      external: { steemUsd: ext.steemUsd, feedOk: ext.feedOk, feedStale: ext.feedStale },
      parityBps: ext.steemUsd !== null ? Math.round(((mv.fair / 1_000_000) / ext.steemUsd - 1) * 10_000) : null,
      at: new Date().toISOString(),
    }), { headers: cors })
  }

  if (p === '/saos-dex/api/dex/my-orders' && req.method === 'GET') {
    const issuer = url.searchParams.get('issuer')
    if (!issuer) return new Response(JSON.stringify({ ok: false, error: 'issuer-required' }), { status: 400, headers: cors })
    const orders = myOrdersRows(db, issuer)
    return new Response(JSON.stringify({ ok: true, issuer, orders }), { headers: cors })
  }

  // ── Task-134: AMM — מסילות-הקריאה (הצגת-מחיר טהורה — מסילת-ה-arb) ─────────────
  if (p === '/saos-dex/api/dex/amm/state' && req.method === 'GET') {
    const pools = allPoolRows(db).map((pl) => {
      // צמיחת-המכפלה מאז-הזריעה — חשבון-BigInt (בריכות-ענק: rb·rq חורג-מ-2^53)
      const k0 = BigInt(getMeta(db, `amm:seedk:${pl.id}`) ?? '0')
      const k1 = BigInt(pl.reserveBaseMu) * BigInt(pl.reserveQuoteMu)
      const kGrowthBps = k0 > 0n ? Number((k1 * 10_000n) / k0) - 10_000 : 0
      return {
        id: pl.id, base: pl.base, quote: pl.quote,
        reserveBaseMu: pl.reserveBaseMu, reserveQuoteMu: pl.reserveQuoteMu,
        priceMu: pl.reserveBaseMu > 0 ? Math.floor((pl.reserveQuoteMu * 1_000_000) / pl.reserveBaseMu) : null,
        feeBps: pl.feeBps, lpSharesMu: pl.lpSharesMu, walletName: pl.walletName,
        kGrowthBps,
      }
    })
    return new Response(JSON.stringify({ ok: true, pools, at: new Date().toISOString() }), { headers: cors })
  }
  if (p === '/saos-dex/api/dex/amm/quote' && req.method === 'GET') {
    const base = url.searchParams.get('base') ?? ''; const quote = url.searchParams.get('quote') ?? ''
    const direction = url.searchParams.get('direction') ?? ''
    const amountInMu = Math.round(Number(url.searchParams.get('amountInMu') ?? 0))
    const pool = poolByPairRow(db, base, quote)
    if (!pool) return new Response(JSON.stringify({ ok: false, error: 'pool-not-found', hint: 'POST amm-seed first' }), { status: 404, headers: cors })
    if (direction !== 'baseToQuote' && direction !== 'quoteToBase')
      return new Response(JSON.stringify({ ok: false, error: 'bad-direction' }), { status: 400, headers: cors })
    try {
      const q = quoteSwap(pool, direction, amountInMu)
      return new Response(JSON.stringify({ ok: true, base, quote, direction, amountInMu, ...q }), { headers: cors })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: cors })
    }
  }

  if (req.method === 'POST' && p.startsWith('/saos-dex/api/dex/')) {
    const tok = operatorToken()
    const got = req.headers.get('x-saos-operator') ?? ''
    if (!tok || got !== tok) {
      return new Response(JSON.stringify({ ok: false, error: 'no-operator-credential' }), { status: 401, headers: cors })
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return new Response(JSON.stringify({ ok: false, error: 'bad-json' }), { status: 400, headers: cors })
    const op = p === '/saos-dex/api/dex/order' ? 'order' : p.split('/').pop() ?? ''

    if (op === 'order') {
      const base = String(body.base ?? ''); const quote = String(body.quote ?? '')
      const side = String(body.side ?? ''); const issuer = String(body.issuer ?? '')
      const price = Number(body.price ?? 0); const amount = Number(body.amountMu ?? body.amount ?? 0)
      const postOnly = body.postOnly === true; const ioc = body.ioc === true
      if (!MARKETS.some((m) => m.base === base && m.quote === quote)) return new Response(JSON.stringify({ ok: false, error: 'unknown-market' }), { status: 400, headers: cors })
      if (side !== 'buy' && side !== 'sell') return new Response(JSON.stringify({ ok: false, error: 'bad-side' }), { status: 400, headers: cors })
      const w = wallet(issuer)
      if (!w) return new Response(JSON.stringify({ ok: false, error: 'unknown-issuer' }), { status: 400, headers: cors })
      const priceMu = Math.round(price); const amountMu = Math.round(amount)
      if (!Number.isFinite(priceMu) || priceMu <= 0 || !Number.isFinite(amountMu) || amountMu <= 0) {
        return new Response(JSON.stringify({ ok: false, error: 'bad-price-or-amount' }), { status: 400, headers: cors })
      }
      if (existsSync(HALT_PATH)) return new Response(JSON.stringify({ ok: false, error: 'halted' }), { status: 423, headers: cors })
      const payAsset = side === 'buy' ? quote : base
      const need = side === 'buy' ? amountMu * priceMu : amountMu // µ-quote לקנייה; µ-בסיס למכירה
      if (free(w, payAsset) < need) return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds' }), { status: 400, headers: cors })
      if (postOnly) {
        const { bids, asks } = bookOf(base, quote)
        const bestOpp = side === 'buy' ? asks[0]?.priceMu : bids[0]?.priceMu
        const wouldCross = bestOpp !== null && (side === 'buy' ? priceMu >= bestOpp : priceMu <= bestOpp)
        if (wouldCross) return new Response(JSON.stringify({ ok: false, error: 'postonly-would-cross' }), { status: 400, headers: cors })
      }
      // Task-132 fix (נלכד-חי בבדיקת-אינטגרציה): 'open' היה ללא-מרכאות → SQLite קרא
      // אותו כעמודה → "no such column: open" → אף-פקודה לא נתקבלה מאז-Task-131.
      // ה-INSERT עתה ב-store.ts (placeOrderRow) — מכוסה-בדיקת-רגרסיה על :memory:.
      const id = placeOrderRow(db, { base, quote, side, priceMu, amountMu, issuer, postOnly, ioc })
      w.locked[payAsset] = (w.locked[payAsset] ?? 0) + need
      saveWallet(w)
      const o = db.query('SELECT * FROM orders WHERE id=?').get(id) as Order
      const filledNow = matchOrderCore(o, store)
      // גמר-הטאקר ב-engine (Task-132): סטטוס + שחרור-נעילת-שארית-IOC — קנייה remainder×priceMu
      // (תיקון-באג-חי: היה remainder בלבד → remainder×(priceMu−1) נעולים-לנצח), מכירה remainder-qty.
      const fin = finalizeTaker(o, filledNow, store)
      db.query('UPDATE orders SET filledMu=?, status=? WHERE id=?').run(fin.filledMu, fin.status, id)
      return new Response(JSON.stringify({ ok: true, orderId: id, filledMu: filledNow, status: fin.status, canceled: fin.status === 'canceled' ? 'ioc-remainder' : undefined, height: bump() }), { headers: cors })
    }

    if (op === 'transfer') {
      const from = String(body.from ?? ''); const to = String(body.to ?? '')
      const asset = String(body.asset ?? '')
      const amt = Math.round(Number(body.amountMu ?? body.amount ?? 0))
      const wf = wallet(from); const wt = wallet(to)
      if (!wf || !wt) return new Response(JSON.stringify({ ok: false, error: 'unknown-wallet' }), { status: 400, headers: cors })
      if (!Number.isFinite(amt) || amt <= 0) return new Response(JSON.stringify({ ok: false, error: 'bad-amount' }), { status: 400, headers: cors })
      if (free(wf, asset) < amt) return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds' }), { status: 400, headers: cors })
      wf.balances[asset] = (wf.balances[asset] ?? 0) - amt
      wt.balances[asset] = (wt.balances[asset] ?? 0) + amt
      saveWallet(wf); saveWallet(wt)
      return new Response(JSON.stringify({ ok: true, from, to, asset, amountMu: amt, height: bump() }), { headers: cors })
    }

    if (op === 'fuel') {
      const to = String(body.to ?? '')
      const amt = Math.round(Number(body.amountMu ?? body.amount ?? 0))
      const credits = Math.round(Number(body.credits ?? 0))
      const wt = wallet(to)
      if (!wt) return new Response(JSON.stringify({ ok: false, error: 'unknown-wallet' }), { status: 400, headers: cors })
      if (credits > 0) {
        wt.credits += credits
        saveWallet(wt)
        return new Response(JSON.stringify({ ok: true, to, credits: wt.credits, height: bump() }), { headers: cors })
      }
      if (!Number.isFinite(amt) || amt <= 0) return new Response(JSON.stringify({ ok: false, error: 'bad-amount' }), { status: 400, headers: cors })
      const gas = wallet('treasury')
      if (!gas || free(gas, 'USDS') < amt) return new Response(JSON.stringify({ ok: false, error: 'treasury-dry' }), { status: 400, headers: cors })
      gas.balances['USDS'] = (gas.balances['USDS'] ?? 0) - amt
      wt.balances['USDS'] = (wt.balances['USDS'] ?? 0) + amt
      saveWallet(gas); saveWallet(wt)
      return new Response(JSON.stringify({ ok: true, to, amountMu: amt, height: bump() }), { headers: cors })
    }

    if (op === 'wrap') {
      const action = String(body.action ?? '')
      const asset = String(body.asset ?? '')
      const amt = Math.round(Number(body.amountMu ?? body.amount ?? 0))
      if (action !== 'mint') return new Response(JSON.stringify({ ok: false, error: 'unsupported-wrap-action' }), { status: 400, headers: cors })
      if (!Number.isFinite(amt) || amt <= 0) return new Response(JSON.stringify({ ok: false, error: 'bad-amount' }), { status: 400, headers: cors })
      const to = String(body.to ?? 'operator')
      const wt = wallet(to)
      if (!wt) return new Response(JSON.stringify({ ok: false, error: 'unknown-wallet' }), { status: 400, headers: cors })
      wt.balances[asset] = (wt.balances[asset] ?? 0) + amt
      saveWallet(wt)
      return new Response(JSON.stringify({ ok: true, action, asset, amountMu: amt, to, height: bump() }), { headers: cors })
    }

    if (op === 'amm-seed') {
      // §3: הזרמת-נזילות — האופרטור מזרים מהארנק-שלו-עצמו לבריכה (שימור-גלובלי-מלא)
      const base = String(body.base ?? ''); const quote = String(body.quote ?? '')
      const rb = Math.round(Number(body.reserveBaseMu ?? 0)); const rq = Math.round(Number(body.reserveQuoteMu ?? 0))
      const opw = wallet('operator')
      if (!opw) return new Response(JSON.stringify({ ok: false, error: 'operator-wallet-missing' }), { status: 400, headers: cors })
      if (free(opw, base) < rb || free(opw, quote) < rq)
        return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds' }), { status: 400, headers: cors })
      if (poolByPairRow(db, base, quote))
        return new Response(JSON.stringify({ ok: false, error: 'pool-exists' }), { status: 409, headers: cors })
      let pool: Pool
      try {
        pool = seedPool(base, quote, rb, rq, 30)
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: cors })
      }
      const walletName = `AMM:${base}/${quote}`
      ensureWalletRow(db, walletName)
      const pw = wallet(walletName)!
      pw.balances[base] = (pw.balances[base] ?? 0) + rb
      pw.balances[quote] = (pw.balances[quote] ?? 0) + rq
      saveWallet(pw)
      opw.balances[base] = (opw.balances[base] ?? 0) - rb
      opw.balances[quote] = (opw.balances[quote] ?? 0) - rq
      saveWallet(opw)
      const id = insertPoolRow(db, { ...pool, walletName })
      setMeta(db, `amm:seedk:${id}`, (BigInt(rb) * BigInt(rq)).toString()) // אנקור-הצמיחה (k0) — חתום-ב-meta
      upsertLpPositionRow(db, id, 'operator', pool.lpSharesMu)
      log(`AMM: בריכה-נזרעה ${base}/${quote} — ${rb}µ/${rq}µ, מניות-זרע ${pool.lpSharesMu}`)
      return new Response(JSON.stringify({ ok: true, poolId: id, base, quote, reserveBaseMu: rb, reserveQuoteMu: rq, lpSharesMu: pool.lpSharesMu, height: bump() }), { headers: cors })
    }

    if (op === 'amm-swap') {
      // §7.1: החלפה-מיידית-פנימית — אפס-RPC-חיצוני, אפס-גז; fail-closed על minOut
      const trader = String(body.trader ?? '')
      const base = String(body.base ?? ''); const quote = String(body.quote ?? '')
      const direction = String(body.direction ?? '')
      const amountInMu = Math.round(Number(body.amountInMu ?? 0))
      const minOutMu = Math.round(Number(body.minOutMu ?? 0))
      const pool = poolByPairRow(db, base, quote)
      if (!pool) return new Response(JSON.stringify({ ok: false, error: 'pool-not-found' }), { status: 404, headers: cors })
      if (direction !== 'baseToQuote' && direction !== 'quoteToBase')
        return new Response(JSON.stringify({ ok: false, error: 'bad-direction' }), { status: 400, headers: cors })
      const w = wallet(trader)
      if (!w) return new Response(JSON.stringify({ ok: false, error: 'unknown-trader' }), { status: 400, headers: cors })
      if (existsSync(HALT_PATH)) return new Response(JSON.stringify({ ok: false, error: 'halted' }), { status: 423, headers: cors })
      const inAsset = direction === 'baseToQuote' ? base : quote
      const outAsset = direction === 'baseToQuote' ? quote : base
      if (free(w, inAsset) < amountInMu)
        return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds' }), { status: 400, headers: cors })
      let r: ReturnType<typeof applySwap>
      try {
        r = applySwap(pool, direction, amountInMu, minOutMu)
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: cors })
      }
      // העברת-כספים: סוחר ← in, בריכה → out; עמלה+מחיק נשארים-בעתודות (A1)
      w.balances[inAsset] = (w.balances[inAsset] ?? 0) - amountInMu
      w.balances[outAsset] = (w.balances[outAsset] ?? 0) + r.outMu
      saveWallet(w)
      const pw = wallet(pool.walletName)
      if (!pw) return new Response(JSON.stringify({ ok: false, error: 'pool-wallet-missing' }), { status: 500, headers: cors })
      pw.balances[inAsset] = (pw.balances[inAsset] ?? 0) + amountInMu
      pw.balances[outAsset] = (pw.balances[outAsset] ?? 0) - r.outMu
      saveWallet(pw)
      updatePoolRow(db, r.pool)
      insertFillRow(db, { base, quote, side: `amm-${direction}`, priceMu: amountInMu > 0 ? Math.floor((r.outMu * 1_000_000) / amountInMu) : 0, amountMu: r.outMu, buyer: trader, seller: pool.walletName })
      return new Response(JSON.stringify({ ok: true, trader, base, quote, direction, amountInMu, outMu: r.outMu, feeMu: r.feeMu, priceAfterMu: r.priceAfterMu, height: bump() }), { headers: cors })
    }

    return new Response(JSON.stringify({ ok: false, error: 'unknown-dex-op' }), { status: 404, headers: cors })
  }

  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), { status: 404, headers: cors })
}

log(`הדקס-הריבוני חי על :${PORT} — חוזה-מדוד מהצרכנים (ארב/dex-hot/זקיפה); µ-שלמים; sqlite ${DB_PATH}`)
Bun.serve({ port: PORT, fetch: handle })
