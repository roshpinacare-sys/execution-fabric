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
//  POST /saos-dex/api/dex/amm-swap       → { trader, base, quote, direction, amountInMu, minOutMu } — החלפה-מיידית (מאחורי-ארון-הסיכונים)
//  Task-135 (§2/§7.2/§7.3 — ארון-סיכונים + HTLC + סליקת-קבלות):
//  GET  /saos-dex/api/dex/htlc/state?id=  → חוזה-בודד (הסוד נחשף רק-אחרי-פדיון)
//  GET  /saos-dex/api/dex/htlc/list?status= → כל-החוזים
//  POST /saos-dex/api/dex/htlc/initiate   → { sender, recipient, asset, amountMu, secretHash, timelockMs } — נעילה-בערבות + חתימת-HSM (fail-closed)
//  POST /saos-dex/api/dex/htlc/claim      → { id, secret } — פדיון ב-preimage-נכון לפני-הפקיעה
//  POST /saos-dex/api/dex/htlc/refund     → { id } — החזרה-לשולח אחרי-הפקיעה-בלבד
//  GET  /saos-dex | /health              → חיות-כנה
//  Task-141-b (§2/§4 — הפעלת-בריכות-USDS + לכידת-מיקרו-פרשים):
//  לולאת-לכידה פנימית (כל SAOS_DEX_CAPTURE_MS, ברירת-מחדל 15ש׳) משווה מחיר-בריכה
//  מול-fair-הספר ויורה רק-על-רווח-אמת-אחרי-עמלה (feeMu≥1µ ורווח≥1µ — captureStep,
//  מוכח-בspread.test.ts) דרך runAmmSwap — שער-הסיכונים נאכף-גם-על-היד. סטטוס-
//  הלולאה חי-ב-/health (capture). מחיר-מילוי-AMM בפנקס המילויים מתוקן-לשני-הכיוונים
//  (swapFillPriceMu — הישן רשם מחיר-הפוך-פי-מיליון על quoteToBase).
// אימות-POST: x-saos-operator מול upload/dex-operator.env (נקרא-בזמן-ריצה; אפס-חשיפה).
// אריתמטיקה: µ-שלמים בלבד בכל-נתיבי-הכסף (mu = 1e-6); אפס-צפים-בפנקס.
// התמדה: bun:sqlite (state/dex.db) — פקודות/מילויים/ארנקות שורדים-הפעלה-מחדש.

import { Database } from 'bun:sqlite'
import { join, resolve } from 'path'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { free, finalizeTaker, matchOrderCore, type Order, type WalletRec } from './engine'
import { addLiquidityShares, applySwap, poolMidMu, quoteSwap, seedPool, type Pool } from './amm'
import { captureDueMs, captureStep, swapFillPriceMu } from './spread'
import { DEFAULT_RISK, depthSingleCapMu, driftBps, preTradeGate, type RiskConfig, type RiskWindow } from './risk'
import {
  canClaim,
  canRefund,
  ensureHtlcSchema,
  getContract,
  insertContract,
  listContracts,
  nextHtlcId,
  sha256Hex,
  updateContractStatus,
  validSecretHash,
  type HtlcContract,
} from './htlc'
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
  'amm-loop': { USDS: 80_000 }, // Task-135 §2 — יד-ה-AMM-המהירה (זרע-זהה-ל-SPECS שבארב)
  treasury: { USDS: 5_000_000, WSTEEM: 1_000_000, SAOS: 1_000_000, WSBD: 500_000, PHIVE: 500_000, ENERGY: 500_000 },
  operator: { USDS: 2_000_000, WSTEEM: 400_000 },
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
const db = new Database(DB_PATH)
// Task-132: ה-DDL, נגישי-השורות והחנות-חיים-ב-store.ts — ניתנים-לייבוא בטוח (בלי-פורט)
// כדי-ששכבת-ה-SQL תהיה-מכוסה-בדיקות (store.test.ts על :memory:) — ה-blind-spot
// שהשאיר את ה-INSERT-השבור חי-שבוע בלי-שאף-בדיקה יראה-אותו.
ensureSchema(db)
ensureHtlcSchema(db) // Task-135 §7.2 — ערבות-HTLC (טבלה-עצמאית-מאומתת)
const seeded = seedWalletRows(db, HAND_SEEDS)
if (seeded > 0) log(`ארנקות-זרע נזרעו (${seeded}) — ערכי-SEED זהים-לארב, מתועדים`)
ensureWalletRow(db, 'htlc-escrow') // כספת-הערבות — כל-חוזה מזיז-כסף-אמיתי-דרכה
ensureWalletRow(db, 'amm-loop') // Task-135: יד-ה-AMM — שורה-מובטחת-גם-בעץ-חי (seedWallets הוא first-boot-only; המימון-עד-הזרע-מגיע-מהאוצר-דרך-הארב)

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

// ── פארים-חיים: fair = מחצי-הספר → אמצע-הבריכה → זרע-מתועד (Task-142) ─────────
// הבריכה היא נזילות-דו-צדדית אמת: כשהספר רזה, אמצע-הבריכה (poolMidMu) הוא ה-fair
// החי — קודם-לכן poolMid-היה-מקודד-null-וה-fair-נפל-לזרע-סטטי (נמדד-ותוקן).
function marketView(base: string, quote: string) {
  const { bids, asks } = bookOf(base, quote)
  const bestBid = bids[0]?.priceMu ?? null
  const bestAsk = asks[0]?.priceMu ?? null
  const spec = MARKETS.find((m) => m.base === base && m.quote === quote)!
  const mid = bestBid !== null && bestAsk !== null ? Math.round((bestBid + bestAsk) / 2) : bestBid ?? bestAsk ?? null
  const pool = poolByPairRow(db, base, quote)
  const poolMid = pool ? poolMidMu(pool.reserveBaseMu, pool.reserveQuoteMu) : null
  const fair = mid ?? poolMid ?? spec.refSeedMu
  return {
    base, quote, key: `${base}/${quote}`, fair,
    bestBid, bestAsk,
    spreadBps: bestBid !== null && bestAsk !== null ? Math.round(((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000) : 0,
    poolMid,
    refSource: mid !== null ? 'book' : poolMid !== null ? 'pool' : spec.refSource,
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

// ── סליקת-קבלות-ל-fleet-economy (הנחיית-בעלים §2/§5) ─────────────────────────────────────
// כל-החלפה/סגירת-חוזה נחתמת-בשרשרת-האמת של האפליקציה (hash-linked).
// best-effort: כשל-רשת לא מפיל את העסקה — הקבלה-המקומית (fills/htlc) היא-האמת-הראשונה.
const RECEIPT_URL = process.env.SAOS_RECEIPT_URL ?? 'http://127.0.0.1:3000/api/sovereign/ops/dex-receipt'
function organToken(): string | null {
  const p = join(ROOT, 'upload', 'organ-token')
  if (!existsSync(p)) return null
  try {
    const v = readFileSync(p, 'utf8').trim()
    return v || null
  } catch {
    return null
  }
}
function reportReceipt(kind: string, status: string, worker: string, outputHash: string, durationMs: number): void {
  const tok = organToken()
  if (!tok) return
  void fetch(RECEIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-saos-organ': tok },
    body: JSON.stringify({ worker, receipts: [{ kind, status, attempts: 1, durationMs, errorClass: null, outputHash }] }),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined) // כנות: כשל-סליקה שקט-בכוונה — הקבלה-המקומית-קיימת
}

// ── HSM-החתימה (saos-wallet :3085) — חתימת-התחייבות-HTLC; fail-closed ─────────────────────
const WALLET_SIGN = process.env.SAOS_WALLET_SIGN ?? 'http://127.0.0.1:3085/sign'
async function signCommitment(commitmentJson: string): Promise<HtlcContract['commitmentSig']> {
  try {
    // דירקטיבת-בעלים 25/10 §1: ה-HSM נעול-טוקן — החתימה-שלנו-נושאת-את-טוקן-האיבר (fail-closed: אין-טוקן = אין-חתימה)
    const tok = organToken()
    if (!tok) throw new Error('organ-token-missing — HSM-נעול (כנות, לא-עוקפים)')
    const res = await fetch(WALLET_SIGN, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-saos-organ': tok },
      body: JSON.stringify({ keyId: 'mesh-identity', payload: commitmentJson }),
      signal: AbortSignal.timeout(4_000),
    })
    const j = (await res.json().catch(() => null)) as
      | { ok?: boolean; keyId?: string; fp?: string; scheme?: string; signatureBase64?: string; error?: string }
      | null
    if (!res.ok || !j?.ok || !j.signatureBase64 || !j.fp || !j.scheme) {
      throw new Error(j?.error ?? `HTTP ${res.status}`)
    }
    return { keyId: j.keyId ?? 'mesh-identity', fp: j.fp, scheme: j.scheme, signatureBase64: j.signatureBase64 }
  } catch (e) {
    throw new Error(`hsm-unavailable: ${e instanceof Error ? e.message : String(e)}`)
  }
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

// ── ארון-הסיכונים האדפטיבי (saos-desk gate, Task-136 §1 — דירקטיבת-הבעלים) ─────────
// כל-החלפת-AMM עוברת-את-השער לפני-כל-חיוב. Task-136: אפס-עצירות-מלאכותיות —
// תקרה-בודדת = אחוז-מעומק-הבריכה (צומחת-אוטומטית), חלון = דלי-טוקנים-רציף
// (HF לעולם לא נחנק), סטייה-רכה = עיגון-עצמי-חתום (המסחר-ממשיך).
// halt נשאר רק לאירועי-שלמות: דגל-בעלים, סטייה-מעל-50%-בחלון (ניקוז-אמת).
function envNum(name: string, d: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : d
}
const RISK: RiskConfig = {
  windowCapMu: envNum('SAOS_RISK_WINDOW_CAP_MU', DEFAULT_RISK.windowCapMu),
  windowMs: envNum('SAOS_RISK_WINDOW_MS', DEFAULT_RISK.windowMs),
  singleCapPpm: envNum('SAOS_RISK_SINGLE_CAP_PPM', DEFAULT_RISK.singleCapPpm),
  maxDriftBps: envNum('SAOS_RISK_MAX_DRIFT_BPS', DEFAULT_RISK.maxDriftBps),
  integrityCeilingBps: envNum('SAOS_RISK_INTEGRITY_BPS', DEFAULT_RISK.integrityCeilingBps),
}
const riskWindows = new Map<string, RiskWindow>() // poolId → דלי-טוקנים חי (מילוי-רציף בתוך-השער)
function poolPriceMu(rb: number, rq: number): number | null {
  return rb > 0 ? Math.floor((rq * 1_000_000) / rb) : null
}
/** עוגן-המחיר מהזריעה — lazily: בריכות-ישנות מקבלות-עוגן-במדידה-הראשונה (מתועד). */
function anchorPriceMu(poolId: string, currentPriceMu: number | null): number | null {
  const key = `amm:seedpx:${poolId}`
  const existing = getMeta(db, key)
  if (existing) {
    const v = Number(existing)
    return Number.isFinite(v) && v > 0 ? v : null
  }
  if (currentPriceMu === null) return null
  setMeta(db, key, String(currentPriceMu)) // עוגן-בסיס-מהשעה-הנוכחית — מתועד-ב-meta
  return currentPriceMu
}
function riskHalted(poolId: string): string | null {
  const v = getMeta(db, `amm:risk-halt:${poolId}`)
  return v && v.length > 0 ? v : null
}

// ── ליבת-ההחלפה (Task-141-b): חולצה-מהמטפל — משותפת ל-HTTP וללולאת-הלכידה ────
// הסמנטיקה זהה-מילה-במילה למטפל-של-Task-135/136: סדר-הבדיקות לא-שונה
// (בריכה → כיוון → סוחר → halt → שער-סיכונים → יתרה → applySwap), fail-closed
// על minOut, עמלה+מחיק-נשארים-בבריכה (A1), קבלה-hash-linked best-effort.
type OpOk = { ok: true; payload: Record<string, unknown> }
type OpErr = { ok: false; error: string; status: number; extra?: Record<string, unknown> }
function runAmmSwap(a: {
  trader: string
  base: string
  quote: string
  direction: string
  amountInMu: number
  minOutMu: number
}): OpOk | OpErr {
  const pool = poolByPairRow(db, a.base, a.quote)
  if (!pool) return { ok: false, error: 'pool-not-found', status: 404 }
  if (a.direction !== 'baseToQuote' && a.direction !== 'quoteToBase')
    return { ok: false, error: 'bad-direction', status: 400 }
  const direction = a.direction
  const w = wallet(a.trader)
  if (!w) return { ok: false, error: 'unknown-trader', status: 400 }
  if (existsSync(HALT_PATH)) return { ok: false, error: 'halted', status: 423 }
  // ── ארון-הסיכונים האדפטיבי (Task-136 §1): השער-קודם-לחיוב; סטייה-רכה=עיגון-עצמי-חתום; אפס-קפיאות ──
  const rh = riskHalted(pool.id)
  if (rh) return { ok: false, error: `risk-halt: ${rh}`, status: 423, extra: { poolId: pool.id } }
  const curPx = poolPriceMu(pool.reserveBaseMu, pool.reserveQuoteMu)
  const anchor = anchorPriceMu(pool.id, curPx)
  const drift = curPx !== null && anchor !== null ? driftBps(curPx, anchor) : null
  const reserveInMu = direction === 'baseToQuote' ? pool.reserveBaseMu : pool.reserveQuoteMu
  const win0 = riskWindows.get(pool.id) ?? { lastMs: Date.now(), availMu: RISK.windowCapMu }
  const verdict = preTradeGate(
    { amountInMu: a.amountInMu, driftBps: drift, reserveInMu, halted: false, nowMs: Date.now() },
    RISK,
    win0,
  )
  if (!verdict.allow) {
    if (verdict.reason.startsWith('integrity-drift')) {
      // סטיית-שלמות-אמת (>50% בחלון) — העצירה-היחידה-שנותרת; שורדת-הפעלה-מחדש (meta)
      setMeta(db, `amm:risk-halt:${pool.id}`, verdict.reason)
      log(`🛑 ארון-הסיכונים: סטיית-שלמות — ${verdict.reason} (בריכה ${pool.id}; מחיר ${curPx}µ מול-עוגן ${anchor}µ)`)
    } else {
      log(`ארון-הסיכונים: נדחה (${verdict.reason}) — ${a.amountInMu}µ על-בריכה ${pool.id}; אפס-שינוי-מצב`)
    }
    return {
      ok: false,
      error: verdict.reason,
      status: verdict.httpStatus,
      extra: { poolId: pool.id, risk: { driftBps: drift, anchorPriceMu: anchor, bucketAvailMu: verdict.window.availMu, windowCapMu: RISK.windowCapMu } },
    }
  }
  riskWindows.set(pool.id, verdict.window) // אימוץ-הדלי רק-אחרי-ההיתר
  if (verdict.reAnchor && curPx !== null) {
    // עיגון-עצמי-חתום (Task-136 §1/§6): העוגן-עוקב-אחרי-מחיר-האמת; המסחר-מעולם-לא-נעצר
    setMeta(db, `amm:seedpx:${pool.id}`, String(curPx))
    reportReceipt('dex-desk-reanchor', 'anchored', 'saos-dex:desk', sha256Hex(JSON.stringify({ poolId: pool.id, prevAnchorPriceMu: anchor, newAnchorPriceMu: curPx, driftBps: verdict.driftBps })), 0)
    log(`⚖️ ארון-הסיכונים: עיגון-עצמי ${anchor}µ→${curPx}µ (סטייה נמדדה ${verdict.driftBps}bps) — המסחר-המשיך, קבלה-חתומה`)
  }
  const inAsset = direction === 'baseToQuote' ? a.base : a.quote
  const outAsset = direction === 'baseToQuote' ? a.quote : a.base
  if (free(w, inAsset) < a.amountInMu)
    return { ok: false, error: 'insufficient-free-funds', status: 400 }
  let r: ReturnType<typeof applySwap>
  try {
    r = applySwap(pool, direction, a.amountInMu, a.minOutMu)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), status: 400 }
  }
  // העברת-כספים: סוחר ← in, בריכה → out; עמלה+מחיק נשארים-בעתודות (A1)
  w.balances[inAsset] = (w.balances[inAsset] ?? 0) - a.amountInMu
  w.balances[outAsset] = (w.balances[outAsset] ?? 0) + r.outMu
  saveWallet(w)
  const pw = wallet(pool.walletName)
  if (!pw) return { ok: false, error: 'pool-wallet-missing', status: 500 }
  pw.balances[inAsset] = (pw.balances[inAsset] ?? 0) + a.amountInMu
  pw.balances[outAsset] = (pw.balances[outAsset] ?? 0) - r.outMu
  saveWallet(pw)
  updatePoolRow(db, r.pool)
  // Task-141-b: מחיר-מילוי-אמת בשני-הכיוונים (swapFillPriceMu; הישן רשם out/in גם-בקנייה)
  insertFillRow(db, { base: a.base, quote: a.quote, side: `amm-${direction}`, priceMu: swapFillPriceMu(direction, a.amountInMu, r.outMu), amountMu: r.outMu, buyer: a.trader, seller: pool.walletName })
  // סליקה-ל-fleet-economy (§2/§5): קבלה-hash-linked-על-השרשרת — best-effort
  reportReceipt('dex-amm-swap', 'filled', `saos-dex:${a.trader}`, sha256Hex(JSON.stringify({ trader: a.trader, base: a.base, quote: a.quote, direction, amountInMu: a.amountInMu, outMu: r.outMu, height })), 0)
  return { ok: true, payload: { trader: a.trader, base: a.base, quote: a.quote, direction, amountInMu: a.amountInMu, outMu: r.outMu, feeMu: r.feeMu, priceAfterMu: r.priceAfterMu, height: bump() } }
}

// ── לולאת-לכידת-מיקרו-פרשים (Task-141-b — הנחיה §2/§4) ─────────────────────────
// נמדד-תחילה: אין-שום-לולאת-סחר-קיימת באיבר (אפס-setInterval ב-saos-dex) — נוסף
// שלב-מזערי-דטרמיניסטי: כל-CAPTURE_MS נמדדת סטיית מחיר-בריכה מול-fair-הספר, וירי
// רק-על-רווח-אמת-אחרי-עמלה (captureStep — S1–S6, מוכח-בspread.test.ts). הביצוע
// דרך runAmmSwap עצמו — שער-הסיכונים וה-fail-closed נאכפים-גם-על-היד. כל-החלטה
// נחתמת-כן כאן וב-/health — אפס-ירי-מזויף, אפס-תרומת-עמלות-נסתרת.
const CAPTURE_MS = envNum('SAOS_DEX_CAPTURE_MS', 1_500) // Task-142: 15s→1.5s — תגובת-שער-לסטיית-בריכה (הירי-עדיין-רק-על-רווח-אמת)
interface CaptureStats {
  armed: boolean
  everyMs: number
  ticks: number
  decisions: number
  fires: number
  rejected: number
  lastAt: string | null
  lastReason: string | null
  lastFire: string | null
}
// חסין-הפעלה-חמה (--hot): הסטטיסטיקה והטיימר חיים-על globalThis; הפונקציה נקשרת-
// מחדש בכל-טעינה — הסגר הישן לא מצטבר, המונים שורדים-טעינה (מדוד ומתועד).
const G_HOT = globalThis as unknown as {
  __saosDexCaptureStats?: CaptureStats
  __saosDexCaptureTick?: () => void
  __saosDexCaptureTimer?: ReturnType<typeof setInterval>
  __saosDexCaptureLastTickMs?: number
}
const captureStats: CaptureStats = G_HOT.__saosDexCaptureStats ?? {
  armed: false,
  everyMs: CAPTURE_MS,
  ticks: 0,
  decisions: 0,
  fires: 0,
  rejected: 0,
  lastAt: null,
  lastReason: null,
  lastFire: null,
}
captureStats.everyMs = CAPTURE_MS
G_HOT.__saosDexCaptureStats = captureStats

function captureTick(): void {
  captureStats.ticks++
  if (existsSync(HALT_PATH)) {
    captureStats.lastReason = 'halted'
    return
  }
  for (const m of MARKETS) {
    const pool = poolByPairRow(db, m.base, m.quote)
    if (!pool) continue // בריכה-לא-נזרעה — אין-מה-ללכוד (נרשם-כן באימות-הזריעה)
    const hand = wallet('amm-loop')
    if (!hand) continue // אין-יד — אין-סוחר (כנות)
    const fair = marketView(m.base, m.quote).fair
    const dec = captureStep(pool, fair, { freeQuoteMu: free(hand, m.quote), freeBaseMu: free(hand, m.base) })
    captureStats.decisions++
    captureStats.lastAt = new Date().toISOString()
    if (dec.action === 'idle') {
      captureStats.lastReason = `${m.base}/${m.quote}: ${dec.reason}`
      continue // המתנה-כנה — אין-עסקה-לא-רווחית
    }
    const r = runAmmSwap({ trader: 'amm-loop', base: m.base, quote: m.quote, direction: dec.action, amountInMu: dec.amountInMu, minOutMu: dec.expectedOutMu })
    if (r.ok) {
      captureStats.fires++
      captureStats.lastFire = `${m.base}/${m.quote} ${dec.action} ${dec.amountInMu}µ→${String(r.payload.outMu)}µ (רווח-צף ${dec.expectedProfitMu}µ)`
      captureStats.lastReason = null
      log(`🕷️ לכידת-מיקרו-פרשים: ${captureStats.lastFire}`)
    } else {
      captureStats.rejected++
      captureStats.lastReason = `${m.base}/${m.quote}: נדחה-כן — ${r.error}`
      log(`🕷️ לכידה-נדחתה-כן (אפס-שינוי-מצב): ${captureStats.lastReason}`)
    }
  }
}

G_HOT.__saosDexCaptureTick = captureTick
// Task-141-b (נמדד-חי 26/10 15:43–15:53: ticks=0 למשך-שעות): שני-שערים-מתים ב-bun --hot 1.3.14 —
// (א) הידית-הישנה על-ה-global חסמה-יצירה-מחדש אחרי-ש-hot מנקה-טיימרים; (ב) גם-טיימר-חד-טרי
// לא-נורה-כלל (בדיקה-מבוקרת: rev-marker נראה-אך-ticks=0 אחרי-מחזור-מלא). הפתרון-הכן:
// פעימה-עצלה-מכל-בקשת-HTTP דרך-שער-captureDueMs (טהור, מוכח-בspread.test.ts) — הזקיפה/
// הארב/הסקרים דוגמים-/health ו-/state תדיר → קצב-פעימה-אמת ללא-תלות-בטיימרים.
// ה-setInterval נשאר-לייצור-ללא-hot (נזק-אפס; כיסוי-כפול). המונים חיים-על-ה-global —
// שורדים-טעינה-חמה בלי-איפוס.
function lazyCaptureTick(): void {
  const nowMs = Date.now()
  if (!captureDueMs(nowMs, G_HOT.__saosDexCaptureLastTickMs ?? 0, CAPTURE_MS)) return
  G_HOT.__saosDexCaptureLastTickMs = nowMs
  try {
    captureTick()
  } catch (e) {
    // כנות: פעימה-כושלת לא מפילה-בקשה — חתום-וכן ב-/health
    captureStats.lastReason = `tick-error: ${e instanceof Error ? e.message : String(e)}`
  }
}
if (G_HOT.__saosDexCaptureTimer) clearInterval(G_HOT.__saosDexCaptureTimer)
G_HOT.__saosDexCaptureTimer = setInterval(() => G_HOT.__saosDexCaptureTick?.(), CAPTURE_MS)
log(`🕷️ לולאת-לכידת-מיקרו-פרשים חמושה — כל ${CAPTURE_MS}ms (יד amm-loop; ירי-רק-על-רווח-אחרי-עמלה; פעימה-עצלה-מכל-בקשה)`)
captureStats.armed = true

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function handle(req: Request): Promise<Response> {
  lazyCaptureTick() // Task-141-b: פעימת-הלכידה-העצלה — מנוהלת-על-ידי-שער-captureDueMs (≤פעימה-אחת ל-CAPTURE_MS)
  const url = new URL(req.url)
  const p = url.pathname
  const cors = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

  if (req.method === 'GET' && (p === '/health' || p === '/')) return new Response(JSON.stringify({ ok: true, service: 'saos-dex', port: PORT, height, rev: '141-b', pools: allPoolRows(db).length, capture: captureStats, at: new Date().toISOString() }), { headers: cors })
  if (req.method === 'GET' && p === '/saos-dex') return new Response(JSON.stringify({ ok: true, organ: 'saos-dex', rev: '141-b', height }), { headers: cors })

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
      const curPx = poolPriceMu(pl.reserveBaseMu, pl.reserveQuoteMu)
      const anchor = anchorPriceMu(pl.id, curPx) // lazily — גם-כאן קובע-עוגן-במידת-הצורך
      return {
        id: pl.id, base: pl.base, quote: pl.quote,
        reserveBaseMu: pl.reserveBaseMu, reserveQuoteMu: pl.reserveQuoteMu,
        priceMu: curPx,
        // Task-135 (באג-יחידות-חי): priceMu הוא ×1e6 (תצוגה) — לא-בסקאלת-הספר.
        // priceRatioMu = rq/rb הגלם (µ-quote-ל-µ-base) — זה-המספר-הנילחם-מול-מחירי-הספר
        // (נתיב-הפקודות: need=amount×price — בדיוק-הסקאלה-הזו). אף-צרכן-ארב לא ישווה-עוד-סקאלות.
        priceRatioMu: pl.reserveBaseMu > 0 ? Math.floor(pl.reserveQuoteMu / pl.reserveBaseMu) : null,
        feeBps: pl.feeBps, lpSharesMu: pl.lpSharesMu, walletName: pl.walletName,
        kGrowthBps,
        risk: {
          halted: riskHalted(pl.id),
          driftBps: curPx !== null && anchor !== null ? driftBps(curPx, anchor) : null,
          anchorPriceMu: anchor,
          windowCapMu: RISK.windowCapMu,
          bucketAvailMu: riskWindows.get(pl.id)?.availMu ?? RISK.windowCapMu,
          singleCapDepthMu:
            curPx !== null
              ? depthSingleCapMu(
                  pl.reserveBaseMu, // נמדד-על-צד-הבסיס; השער-עצמו נוגע-לצד-הכניסה בפועל
                  RISK.singleCapPpm,
                )
              : null,
          singleCapPpm: RISK.singleCapPpm,
          maxDriftBps: RISK.maxDriftBps,
          integrityCeilingBps: RISK.integrityCeilingBps,
        },
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

  if (p === '/saos-dex/api/dex/htlc/state' && req.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    const c = getContract(db, id)
    if (!c) return new Response(JSON.stringify({ ok: false, error: 'contract-not-found' }), { status: 404, headers: cors })
    // הסוד-חי-רק-אחרי-הפדיון (ההוכחה) — לפני-כן רק-ה-hashlock גלוי
    return new Response(JSON.stringify({ ok: true, contract: c.status === 'claimed' ? c : { ...c, secret: null } }), { headers: cors })
  }
  if (p === '/saos-dex/api/dex/htlc/list' && req.method === 'GET') {
    const status = url.searchParams.get('status') ?? undefined
    const valid = ['locked', 'claimed', 'refunded']
    if (status && !valid.includes(status)) return new Response(JSON.stringify({ ok: false, error: 'bad-status' }), { status: 400, headers: cors })
    const contracts = listContracts(db, status).map((c) => (c.status === 'claimed' ? c : { ...c, secret: null }))
    return new Response(JSON.stringify({ ok: true, count: contracts.length, contracts }), { headers: cors })
  }

  if (req.method === 'POST' && p.startsWith('/saos-dex/api/dex/')) {
    const tok = operatorToken()
    const got = req.headers.get('x-saos-operator') ?? ''
    if (!tok || got !== tok) {
      return new Response(JSON.stringify({ ok: false, error: 'no-operator-credential' }), { status: 401, headers: cors })
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return new Response(JSON.stringify({ ok: false, error: 'bad-json' }), { status: 400, headers: cors })
    const op = p.startsWith('/saos-dex/api/dex/htlc/')
      ? `htlc-${p.split('/').pop() ?? ''}` // htlc/initiate → htlc-initiate (מרחב-שמות-גלוי)
      : p === '/saos-dex/api/dex/order' ? 'order' : p.split('/').pop() ?? ''

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
      // §7.1: החלפה-מיידית-פנימית — הליבה חיה ב-runAmmSwap (Task-141-b: משותפת-ללולאת-הלכידה)
      const r = runAmmSwap({
        trader: String(body.trader ?? ''),
        base: String(body.base ?? ''),
        quote: String(body.quote ?? ''),
        direction: String(body.direction ?? ''),
        amountInMu: Math.round(Number(body.amountInMu ?? 0)),
        minOutMu: Math.round(Number(body.minOutMu ?? 0)),
      })
      if (!r.ok) return new Response(JSON.stringify({ ok: false, error: r.error, ...(r.extra ?? {}) }), { status: r.status, headers: cors })
      return new Response(JSON.stringify({ ok: true, ...r.payload }), { headers: cors })
    }

    if (op === 'amm-add-lp') {
      // Task-136 §1/§2: העמקת-נזילות-עצמאית — כל-ארנק-חייל יכול-להפוך-לספק-נזילות-אמת.
      // העמלות-נשארות-בבריכה (k-growth) → המניות-שוקלות-יתרות — ערוץ-מימון-עצמי פנימי.
      // fail-closed: יחס-פרופורציונלי מחויב-בדיוק (ceil לטובת-הבריכה) — אפס-תרומה-עודפת.
      const issuer = String(body.issuer ?? '')
      const base = String(body.base ?? ''); const quote = String(body.quote ?? '')
      const amountBaseMu = Math.round(Number(body.amountBaseMu ?? 0))
      const pool = poolByPairRow(db, base, quote)
      if (!pool) return new Response(JSON.stringify({ ok: false, error: 'pool-not-found' }), { status: 404, headers: cors })
      if (existsSync(HALT_PATH)) return new Response(JSON.stringify({ ok: false, error: 'halted' }), { status: 423, headers: cors })
      const w = wallet(issuer)
      if (!w) return new Response(JSON.stringify({ ok: false, error: 'unknown-issuer' }), { status: 400, headers: cors })
      if (!Number.isSafeInteger(amountBaseMu) || amountBaseMu <= 0)
        return new Response(JSON.stringify({ ok: false, error: 'bad-amount' }), { status: 400, headers: cors })
      if (free(w, base) < amountBaseMu)
        return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds', asset: base, haveFree: free(w, base), need: amountBaseMu }), { status: 400, headers: cors })
      // יחס-הבריכה: quote הדרוש = ceil(ab × rq / rb) — הערכה-לעומק-אמת, לא-מימוש-הנחה
      const needQuoteMu = Math.ceil((amountBaseMu * pool.reserveQuoteMu) / pool.reserveBaseMu)
      if (free(w, quote) < needQuoteMu)
        return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds', asset: quote, haveFree: free(w, quote), need: needQuoteMu, hint: 'pool-פרופורציה מחייבת צמד-מלא — הזרם את שני הצדדים' }), { status: 400, headers: cors })
      let mint: number
      try {
        mint = addLiquidityShares(pool, amountBaseMu, needQuoteMu)
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 400, headers: cors })
      }
      // העברה-אמת: issuer → בריכה (שני-הצדדים); עדכון-עתודות+מניות-אמת
      w.balances[base] = (w.balances[base] ?? 0) - amountBaseMu
      w.balances[quote] = (w.balances[quote] ?? 0) - needQuoteMu
      saveWallet(w)
      const pw = wallet(pool.walletName)
      if (!pw) return new Response(JSON.stringify({ ok: false, error: 'pool-wallet-missing' }), { status: 500, headers: cors })
      pw.balances[base] = (pw.balances[base] ?? 0) + amountBaseMu
      pw.balances[quote] = (pw.balances[quote] ?? 0) + needQuoteMu
      saveWallet(pw)
      const newPool: Pool = {
        ...pool,
        reserveBaseMu: pool.reserveBaseMu + amountBaseMu,
        reserveQuoteMu: pool.reserveQuoteMu + needQuoteMu,
        lpSharesMu: pool.lpSharesMu + mint,
      }
      updatePoolRow(db, newPool)
      upsertLpPositionRow(db, pool.id, issuer, mint)
      log(`AMM: העמקת-נזילות — ${issuer} הזרים ${amountBaseMu}µ ${base} + ${needQuoteMu}µ ${quote} → מניות ${mint}µ (בריכה ${pool.id}: ${newPool.reserveBaseMu}µ/${newPool.reserveQuoteMu}µ)`)
      reportReceipt('dex-amm-lp', 'added', `saos-dex:${issuer}`, sha256Hex(JSON.stringify({ issuer, base, quote, amountBaseMu, needQuoteMu, mint, poolId: pool.id })), 0)
      return new Response(JSON.stringify({ ok: true, poolId: pool.id, issuer, mintedSharesMu: mint, requiredQuoteMu: needQuoteMu, reservesBaseMu: newPool.reserveBaseMu, reservesQuoteMu: newPool.reserveQuoteMu, lpSharesMu: newPool.lpSharesMu, height: bump() }), { headers: cors })
    }

    if (op === 'amm-risk-clear') {
      // Task-136: סמכות-המפעיל בלבד — ניקוי-דגל-שלמות + קביעת-עוגן-מחיר-חדש-מהשעה.
      // ב-Task-136 העיגון-הרך-מעגן-עצמו; השער-הזה-נותר-כלי-הבעלים לאירועי-שלמות בלבד.
      const base = String(body.base ?? ''); const quote = String(body.quote ?? '')
      const pool = poolByPairRow(db, base, quote)
      if (!pool) return new Response(JSON.stringify({ ok: false, error: 'pool-not-found' }), { status: 404, headers: cors })
      const curPx = poolPriceMu(pool.reserveBaseMu, pool.reserveQuoteMu)
      if (curPx === null) return new Response(JSON.stringify({ ok: false, error: 'pool-price-unmeasurable' }), { status: 400, headers: cors })
      const prevHalt = riskHalted(pool.id)
      setMeta(db, `amm:risk-halt:${pool.id}`, '') // ניקוי (הקורא מתייחס-לריק כלא-עצור)
      riskWindows.delete(pool.id) // חלון-טרי — החלטת-השולחן
      setMeta(db, `amm:seedpx:${pool.id}`, String(curPx))
      log(`ארון-הסיכונים: המפעיל ניקה-עצירה (היה: ${prevHalt ?? 'none'}) — עוגן-חדש ${curPx}µ על בריכה ${pool.id}`)
      return new Response(JSON.stringify({ ok: true, poolId: pool.id, prevHalt, newAnchorPriceMu: curPx, height: bump() }), { headers: cors })
    }

    if (op === 'htlc-initiate') {
      // §7.2: נעילה-אטומית — העברה-אמיתית-לערבות + חתימת-HSM על-ההתחייבות (fail-closed)
      const sender = String(body.sender ?? '')
      const recipient = String(body.recipient ?? '')
      const asset = String(body.asset ?? '')
      const amountMu = Math.round(Number(body.amountMu ?? 0))
      const secretHash = String(body.secretHash ?? '')
      const timelockMs = Math.round(Number(body.timelockMs ?? 0))
      const ws = wallet(sender); const wr = wallet(recipient)
      if (!ws || !wr) return new Response(JSON.stringify({ ok: false, error: 'unknown-wallet' }), { status: 400, headers: cors })
      if (sender === 'htlc-escrow' || recipient === 'htlc-escrow') return new Response(JSON.stringify({ ok: false, error: 'escrow-not-a-party' }), { status: 400, headers: cors })
      if (sender === recipient) return new Response(JSON.stringify({ ok: false, error: 'self-swap' }), { status: 400, headers: cors })
      if (!validSecretHash(secretHash)) return new Response(JSON.stringify({ ok: false, error: 'bad-secret-hash (64-hex-קטן נדרש)' }), { status: 400, headers: cors })
      if (!Number.isFinite(amountMu) || amountMu <= 0) return new Response(JSON.stringify({ ok: false, error: 'bad-amount' }), { status: 400, headers: cors })
      const now = Date.now()
      if (!Number.isFinite(timelockMs) || timelockMs <= now) return new Response(JSON.stringify({ ok: false, error: 'timelock-must-be-future' }), { status: 400, headers: cors })
      if (timelockMs > now + 30 * 24 * 3600_000) return new Response(JSON.stringify({ ok: false, error: 'timelock-too-far (≤30-ימים)' }), { status: 400, headers: cors })
      if (free(ws, asset) < amountMu) return new Response(JSON.stringify({ ok: false, error: 'insufficient-free-funds' }), { status: 400, headers: cors })
      const id = nextHtlcId(db)
      const commitment = JSON.stringify({ id, sender, recipient, asset, amountMu, secretHash, timelockMs, organ: 'saos-dex' })
      let sig: HtlcContract['commitmentSig']
      try {
        sig = await signCommitment(commitment)
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 503, headers: cors })
      }
      // העברה-אמיתית: שולח → ערבות (אפס-כסף-מומצא — כמו-transfer)
      ws.balances[asset] = (ws.balances[asset] ?? 0) - amountMu
      const escrow = wallet('htlc-escrow')!
      escrow.balances[asset] = (escrow.balances[asset] ?? 0) + amountMu
      saveWallet(ws); saveWallet(escrow)
      const contract: HtlcContract = {
        id, sender, recipient, asset, amountMu, secretHash, timelockMs,
        createdAt: new Date(now).toISOString(), status: 'locked', commitmentSig: sig,
        closedAt: null, secret: null,
      }
      insertContract(db, contract)
      log(`HTLC: חוזה-${id} ננעל — ${sender}→${recipient} ${amountMu}µ ${asset} (פקיעה ${new Date(timelockMs).toISOString()}; חתימת-HSM ${sig!.fp.slice(0, 12)})`)
      return new Response(JSON.stringify({ ok: true, id, status: 'locked', commitmentSignedBy: sig!.fp, height: bump() }), { headers: cors })
    }

    if (op === 'htlc-claim') {
      // פדיון: preimage-נכון לפני-הפקיעה → הערבות משולמת-לנמען + גילוי-הסוד
      const id = String(body.id ?? '')
      const secret = String(body.secret ?? '')
      const c = getContract(db, id)
      if (!c) return new Response(JSON.stringify({ ok: false, error: 'contract-not-found' }), { status: 404, headers: cors })
      const v = canClaim(c, secret, Date.now())
      if (!v.ok) return new Response(JSON.stringify({ ok: false, error: v.reason }), { status: 400, headers: cors })
      const wr = wallet(c.recipient)
      const escrow = wallet('htlc-escrow')!
      if (!wr) return new Response(JSON.stringify({ ok: false, error: 'recipient-wallet-missing' }), { status: 500, headers: cors })
      escrow.balances[c.asset] = (escrow.balances[c.asset] ?? 0) - c.amountMu
      wr.balances[c.asset] = (wr.balances[c.asset] ?? 0) + c.amountMu
      saveWallet(escrow); saveWallet(wr)
      const closedAt = new Date().toISOString()
      updateContractStatus(db, id, 'claimed', closedAt, secret)
      log(`HTLC: חוזה-${id} פדוי — ${c.recipient} קיבל ${c.amountMu}µ ${c.asset} (הסוד נחשף; hashlock מאומת)`)
      reportReceipt('dex-htlc-claim', 'claimed', `saos-dex:${c.recipient}`, sha256Hex(JSON.stringify({ id, secretHash: c.secretHash, amountMu: c.amountMu })), 0)
      return new Response(JSON.stringify({ ok: true, id, status: 'claimed', recipient: c.recipient, amountMu: c.amountMu, asset: c.asset, revealedSecret: secret, height: bump() }), { headers: cors })
    }

    if (op === 'htlc-refund') {
      // החזרה: אחרי-הפקיעה-בלבד → הערבות חוזרת-לשולח
      const id = String(body.id ?? '')
      const c = getContract(db, id)
      if (!c) return new Response(JSON.stringify({ ok: false, error: 'contract-not-found' }), { status: 404, headers: cors })
      const v = canRefund(c, Date.now())
      if (!v.ok) return new Response(JSON.stringify({ ok: false, error: v.reason }), { status: 400, headers: cors })
      const ws = wallet(c.sender)
      const escrow = wallet('htlc-escrow')!
      if (!ws) return new Response(JSON.stringify({ ok: false, error: 'sender-wallet-missing' }), { status: 500, headers: cors })
      escrow.balances[c.asset] = (escrow.balances[c.asset] ?? 0) - c.amountMu
      ws.balances[c.asset] = (ws.balances[c.asset] ?? 0) + c.amountMu
      saveWallet(escrow); saveWallet(ws)
      const closedAt = new Date().toISOString()
      updateContractStatus(db, id, 'refunded', closedAt, null)
      log(`HTLC: חוזה-${id} הוחזר-לשולח — ${c.amountMu}µ ${c.asset} (פקיעה-חלפה)`)
      reportReceipt('dex-htlc-refund', 'refunded', `saos-dex:${c.sender}`, sha256Hex(JSON.stringify({ id, secretHash: c.secretHash, amountMu: c.amountMu })), 0)
      return new Response(JSON.stringify({ ok: true, id, status: 'refunded', sender: c.sender, amountMu: c.amountMu, asset: c.asset, height: bump() }), { headers: cors })
    }

    return new Response(JSON.stringify({ ok: false, error: 'unknown-dex-op' }), { status: 404, headers: cors })
  }

  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), { status: 404, headers: cors })
}

log(`הדקס-הריבוני חי על :${PORT} — חוזה-מדוד מהצרכנים (ארב/dex-hot/זקיפה); µ-שלמים; sqlite ${DB_PATH}`)
Bun.serve({ port: PORT, fetch: handle })
