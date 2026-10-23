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
//  GET  /saos-dex | /health              → חיות-כנה
// אימות-POST: x-saos-operator מול upload/dex-operator.env (נקרא-בזמן-ריצה; אפס-חשיפה).
// אריתמטיקה: µ-שלמים בלבד בכל-נתיבי-הכסף (mu = 1e-6); אפס-צפים-בפנקס.
// התמדה: bun:sqlite (state/dex.db) — פקודות/מילויים/ארנקות שורדים-הפעלה-מחדש.

import { Database } from 'bun:sqlite'
import { join, resolve } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { free, finalizeTaker, matchOrderCore, type Balances, type DexStore, type Order, type WalletRec } from './engine'

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
db.run('PRAGMA journal_mode = WAL;')
db.run(`CREATE TABLE IF NOT EXISTS wallets(
  name TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0,
  balances TEXT NOT NULL DEFAULT '{}', locked TEXT NOT NULL DEFAULT '{}')`)
db.run(`CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, base TEXT NOT NULL, quote TEXT NOT NULL,
  side TEXT NOT NULL, priceMu INTEGER NOT NULL, amountMu INTEGER NOT NULL,
  filledMu INTEGER NOT NULL DEFAULT 0, issuer TEXT NOT NULL,
  postOnly INTEGER NOT NULL DEFAULT 0, ioc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', createdAt TEXT NOT NULL)`)
db.run(`CREATE TABLE IF NOT EXISTS fills(
  id INTEGER PRIMARY KEY AUTOINCREMENT, base TEXT NOT NULL, quote TEXT NOT NULL,
  side TEXT NOT NULL, priceMu INTEGER NOT NULL, amountMu INTEGER NOT NULL,
  buyer TEXT NOT NULL, seller TEXT NOT NULL, createdAt TEXT NOT NULL)`)
db.run(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`)

const getMeta = (k: string): string | null => (db.query('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | null)?.value ?? null
const setMeta = (k: string, v: string): void => db.query('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)

let height = Number(getMeta('height') ?? 0)
const bump = (): number => { height++; setMeta('height', String(height)); return height }

function seedWallets(): void {
  const count = (db.query('SELECT COUNT(*) c FROM wallets').get() as { c: number }).c
  if (count > 0) return
  const ins = db.query('INSERT INTO wallets(name,credits,balances,locked) VALUES(?,0,?,?)')
  for (const [name, bal] of Object.entries(HAND_SEEDS)) {
    ins.run(name, JSON.stringify(bal), '{}')
  }
  log(`ארנקות-זרע נזרעו (${Object.keys(HAND_SEEDS).length}) — ערכי-SEED זהים-לארב, מתועדים`)
}
seedWallets()

function wallet(name: string): WalletRec | null {
  const r = db.query('SELECT * FROM wallets WHERE name=?').get(name) as { name: string; credits: number; balances: string; locked: string } | null
  if (!r) return null
  return { name: r.name, credits: r.credits, balances: JSON.parse(r.balances) as Balances, locked: JSON.parse(r.locked) as Balances }
}
function saveWallet(w: WalletRec): void {
  db.query('UPDATE wallets SET credits=?, balances=?, locked=? WHERE name=?').run(w.credits, JSON.stringify(w.balances), JSON.stringify(w.locked), w.name)
}

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
function bookOf(base: string, quote: string): { bids: Order[]; asks: Order[] } {
  const open = db.query("SELECT * FROM orders WHERE base=? AND quote=? AND status='open' ORDER BY priceMu ASC, id ASC").all(base, quote) as Order[]
  const asks = open.filter((o) => o.side === 'sell')
  const bids = open.filter((o) => o.side === 'buy').reverse() // קנייה-גבוהה-ראשונה
  return { bids, asks }
}
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

// ── מימוש-האחסון של-הליבה מעל sqlite (Task-132) — האיבר-החי מזריק-את-החנות ────
const store: DexStore = {
  listOpen: (base, quote) => bookOf(base, quote),
  getWallet: (name) => wallet(name),
  saveWallet: (w) => saveWallet(w),
  markFilledIfComplete: (id) => db.query("UPDATE orders SET status='filled' WHERE id=? AND filledMu>=amountMu").run(id),
  setMakerProgress: (id, filledMu, complete) => {
    if (complete) db.query('UPDATE orders SET filledMu=?, status=? WHERE id=?').run(filledMu, 'filled', id)
    else db.query('UPDATE orders SET filledMu=? WHERE id=?').run(filledMu, id)
  },
  insertFill: (f) =>
    db.query('INSERT INTO fills(base,quote,side,priceMu,amountMu,buyer,seller,createdAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(f.base, f.quote, f.side, f.priceMu, f.amountMu, f.buyer, f.seller, new Date().toISOString()),
  log,
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
    const orders = db.query('SELECT * FROM orders WHERE issuer=? ORDER BY id DESC LIMIT 200').all(issuer) as Order[]
    return new Response(JSON.stringify({ ok: true, issuer, orders }), { headers: cors })
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
      const info = db.query('INSERT INTO orders(base,quote,side,priceMu,amountMu,filledMu,issuer,postOnly,ioc,status,createdAt) VALUES(?,?,?,?,?,0,?,?,?,open,?)')
        .run(base, quote, side, priceMu, amountMu, issuer, postOnly ? 1 : 0, ioc ? 1 : 0, new Date().toISOString())
      const id = Number(info.lastInsertRowid)
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

    return new Response(JSON.stringify({ ok: false, error: 'unknown-dex-op' }), { status: 404, headers: cors })
  }

  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), { status: 404, headers: cors })
}

log(`הדקס-הריבוני חי על :${PORT} — חוזה-מדוד מהצרכנים (ארב/dex-hot/זקיפה); µ-שלמים; sqlite ${DB_PATH}`)
Bun.serve({ port: PORT, fetch: handle })
