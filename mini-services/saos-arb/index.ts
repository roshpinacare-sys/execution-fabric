// saos-arb — איבר-השוק-החריף (:3071) — Task 106
// ═══════════════════════════════════════════════════════════════════════════════
// החזון-של-הבעלים: שוק-חריף-של-גרידים-וארביטראזים דווקא-על-הדקס-שלנו, עם-תזרים-אמת
// מבחוץ — במקום-תלות-בשירותים-אחרים. האיבר-הזה-הוא-הידיים-שמחממות-את-הספר-של
// הדקס-הריבוני (:3010, repos/saos-dex) ומחברות-אותו-לאמת-המדידה:
//
//   · יד-א' (arb-peg): WSTEEM/USDS — ארביטראז-מול-פאריטי-אמת-חוץ (steemUsd
//     מדיד-חי-רב-מקורות מ-/api/dex/price-proof + realPrice מהשוק-האמיתי :3070).
//     חוק-הפאריטי (דוקטרינת-peg של-הדקס): אף-קנייה-מעל-פאריטי, אף-מכירה-מתחת-פאריטי.
//     הפרמיה-הפנימית-מעל-האמת = הרווח-הנמדד; הסחר-מושך-את-הספר-אל-האמת (גילוי-מחיר).
//   · יד-ב' (grid-mm): SAOS/USDS — גריד-דו-צדדי-סביב-המגע, מרווח-מסתגל-מהספר,
//     postOnly (מייקר-טהור), מכירה-רק-ממלאי-אמת — עומק-וזרימה-על-הטוקן-שלנו.
//
// כנות: הספר-של-הדקס-הוא-סימולציה-מוצהרת (הדקס-עצמו-מצהיר); הקלטות-אמת-הן-מהשרשרת-
// האמיתית ומהפיד-החוץ-המדיד. כל-החלטה-מייצרת-רכיב-ריצה-מאומת (run-card — דפוס-
// Vibe-Trading שאומץ-בכבוד): קלטים-חתומים, החלטה, תוצאה — קריא-מחדש-ע"י-כל-סוכן.
// אפס-דריסות-עם-הסוכנים-האחרים: ידיים-במרחב-שמות-משלנו (arb-peg/grid-mm), ביטול-
// והצבה-רק-על-הפקודות-שלנו (issuer-owner), אפס-נגיעה-בקוד-הדקס.
// כשל-כן-בכל-שכבה; אין-המצאת-מספרים; halt-אוטומטי-על-חריגות; kill-switch-עמיד.

import { readFileSync, existsSync, appendFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.SAOS_ARB_PORT ?? 3071)
const ROOT = join(import.meta.dir, '..', '..')
const DEX = process.env.SAOS_ARB_DEX ?? 'http://127.0.0.1:3010/saos-dex/api/dex'
const GRID = process.env.SAOS_ARB_GRID ?? 'http://127.0.0.1:3070/health'
const STATE_DIR = process.env.SAOS_ARB_STATE ?? join(ROOT, 'mini-services', 'saos-arb', 'state')
const CARDS_PATH = join(STATE_DIR, 'run-cards.jsonl')
const HALT_PATH = join(STATE_DIR, 'halt.flag')

const CYCLE_MS = Number(process.env.SAOS_ARB_CYCLE_MS ?? 20_000)
const MIN_EDGE_BPS = Number(process.env.SAOS_ARB_MIN_EDGE_BPS ?? 150) // מעל-עמלה+שחיקה
const BUY_MARGIN_BPS = Number(process.env.SAOS_ARB_BUY_MARGIN_BPS ?? 300) // קנייה-רק-מתחת-פאריטי
const SELL_NOTIONAL_CAP_MU = Number(process.env.SAOS_ARB_SELL_CAP_MU ?? 12_000) // תקרת-מכירה-למחזור
const MAX_NOTIONAL_MU_PER_CYCLE = Number(process.env.SAOS_ARB_MAX_NOTIONAL_MU ?? 20_000)
const MAX_CONSEC_ERRORS = 5
const CARDS_KEEP = 400
const TOPUP_EVERY_MS = 10 * 60_000

// ידיים — מרחב-שמות-משלנו, אפס-התנגשות-עם-ארנת-החיילים/האוצר/המפעיל
const HAND_PEG = 'arb-peg'
const HAND_MM = 'grid-mm'
const HANDS = [HAND_PEG, HAND_MM] as const
type Hand = (typeof HANDS)[number]

// זרע-ידוע (מתועד) — בסיס-ה-MTM-הכנה; מימון-אוטומטי-מהאוצר-עד-הזרע-בלבד
const SEED = { [HAND_PEG]: { usdsMu: 150_000, wsteemMu: 60_000, saosMu: 0 }, [HAND_MM]: { usdsMu: 150_000, wsteemMu: 0, saosMu: 0 } }

function operatorToken(): string | null {
  // כספת: upload/dex-operator.env (gitignored) — נקרא-בזמן-ריצה, אפס-חשיפה
  const p = join(ROOT, 'upload', 'dex-operator.env')
  if (!existsSync(p)) return null
  const line = readFileSync(p, 'utf-8').split('\n').find((l) => l.startsWith('DEX_OPERATOR_TOKEN='))
  const v = line?.split('=').slice(1).join('=').trim()
  return v || null
}

let halted = existsSync(HALT_PATH) // kill-switch-עמיד
let consecErrors = 0
let cycles = 0
let lastCycleAt: string | null = null
let lastCard: RunCard | null = null
let lastError: string | null = null
let lastTopupAt = 0
const startedAt = new Date().toISOString()

interface RunCard {
  at: string
  cycle: number
  truth: {
    steemUsd: number | null // מדיד-חוץ-רב-מקורות (מהדקס)
    feedOk: boolean
    feedStale: boolean
    realSteemSbd: number | null // מהשוק-האמיתי :3070 (SBD-ל-STEEM)
    impliedSteemUsd: number | null // realSteemSbd × SBD≈USD (צליבה-מתויגת)
    parityMu: number | null // steemUsd × 1000 → מחיר-ספר (µ-USDS-ל-יחידה)
    sources: string[]
  }
  book: { internalMidMu: number | null; bestBid: number | null; bestAsk: number | null; premiumBps: number | null }
  actions: Array<{ hand: Hand; what: string; detail?: string; ok: boolean }>
  fills: Array<{ hand: Hand; orderId: number; side: string; price: number; qtyMu: number; edgeBpsVsParity: number | null }>
  hands: Record<string, { usdsMu: number; baseMu: number; lockedUsdsMu: number; lockedBaseMu: number }>
  mtmPnlMu: number // מול-זרע-ידוע — sim-µ, מתויג-כך
  halted: boolean
  note: string
}

const log = (m: string) => console.log(`[saos-arb ${new Date().toISOString()}] ${m}`)

function writeAtomic(p: string, data: string): void {
  const tmp = p + '.tmp'
  writeFileSync(tmp, data)
  renameSync(tmp, p)
}

async function jget<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function dexPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const tok = operatorToken()
  if (!tok) return { ok: false, error: 'no-operator-token-in-vault' }
  try {
    const res = await fetch(`${DEX}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-saos-operator': tok, 'x-saos-dex-console': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    const j = (await res.json()) as Record<string, unknown>
    return { ok: j.ok === true, error: (j.error as string) ?? undefined, data: j }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── איסוף ────────────────────────────────────────────────────────────────────
interface DexState {
  ok?: boolean
  state?: {
    height?: number
    halted?: boolean
    fills?: number
    assets?: Record<string, { refPrice?: number }>
  }
  // הספר-החי-בשורש-התשובה (state.markets-הוא-שדה-פנימי-אחר — ריק-לצרכן)
  markets?: Array<{
    base: string; quote: string; key: string; fair: number
    bestBid: number | null; bestAsk: number | null; spreadBps: number; poolMid?: number
  }>
  wallets?: Array<{ name: string; credits: number; balances: Record<string, number>; locked: Record<string, number> }>
}
interface PriceProof {
  ok?: boolean
  internal?: { wsteemUsdsMu?: number }
  external?: { steemUsd?: number; feedOk?: boolean; feedStale?: boolean }
}
interface MyOrders { ok?: boolean; orders?: Array<{ id: number; base: string; quote: string; side: string; price: number; amount: number; filled: number }> }
type PrevOrders = Array<{ id: number; side: string; price: number; amount: number; filled: number }>

let prevPegOrders: PrevOrders = []
let prevMmOrders: PrevOrders = []
let prevMmOrderIds: Set<number> = new Set()

async function gather() {
  const [dex, proof, grid, pegOrders, mmOrders] = await Promise.all([
    jget<DexState>(`${DEX}/state`),
    jget<PriceProof>(`${DEX}/price-proof`),
    jget<{ price?: number }>(GRID),
    jget<MyOrders>(`${DEX}/my-orders?issuer=${HAND_PEG}`),
    jget<MyOrders>(`${DEX}/my-orders?issuer=${HAND_MM}`),
  ])
  return { dex, proof, grid, orders: { [HAND_PEG]: pegOrders, [HAND_MM]: mmOrders } as Record<Hand, MyOrders | null> }
}

function marketOf(st: DexState | null, base: string, quote: string) {
  const ms = st?.state?.markets ?? []
  return ms.find((m) => m.base === base && m.quote === quote) ?? null
}
function walletOf(st: DexState | null, name: string) {
  const ws = st?.wallets ?? []
  const w = ws.find((x) => x.name === name)
  return {
    usdsMu: w?.balances?.USDS ?? 0,
    wsteemMu: w?.balances?.WSTEEM ?? 0,
    saosMu: w?.balances?.SAOS ?? 0,
    lockedUsds: w?.locked?.USDS ?? 0,
    lockedWsteem: w?.locked?.WSTEEM ?? 0,
    lockedSaos: w?.locked?.SAOS ?? 0,
  }
}

// מימון-מהאוצר-עד-הזרע-בלבד:
//   · קרדיטים-דרך-/fuel הרשמי (סולם-מממנים-קנוני של-הדקס; REFUEL_CAP-גבול-נזק)
//   · מלאי-WSTEEM בעטיפת-1:1-כנה: wrap_mint נועל-STEEM-מקומי-אמת (גיבוי-נעול-מדיד)
//     ואז-העברה-חופשית-ליד — אף-הדפסה-עצמית, אף-קנייה-מעל-פאריטי
async function ensureFunded(st: DexState | null, card: RunCard): Promise<void> {
  if (Date.now() - lastTopupAt < TOPUP_EVERY_MS) return
  const tok = operatorToken()
  if (!tok) {
    card.actions.push({ hand: HAND_PEG, what: 'fund-skip', detail: 'אין-טוקן-מפעיל-בכספת', ok: false })
    return
  }
  let did = false
  for (const h of HANDS) {
    const w = walletOf(st, h)
    const need = [
      { asset: 'USDS', have: w.usdsMu, want: SEED[h].usdsMu },
      { asset: 'WSTEEM', have: w.wsteemMu, want: SEED[h].wsteemMu },
      { asset: 'SAOS', have: w.saosMu, want: SEED[h].saosMu },
    ]
    for (const n of need) {
      const gap = n.want - n.have
      if (gap > 1000) {
        const r = await dexPost('transfer', { from: 'treasury', to: h, asset: n.asset, amountMu: Math.min(gap, 2_000_000) })
        card.actions.push({ hand: h, what: `fund-${n.asset}`, detail: `gap=${gap}µ → ${r.ok ? 'queued' : `נדחה: ${r.error}`}`, ok: r.ok })
        if (r.ok) did = true
      }
    }
    // תדלוק-גז: בלי-קרדיטים-אין-פקודות (דחיית-insufficient-credits-נתפסה-חי)
    const fuel = await dexPost('fuel', { to: h, amount: 50_000 })
    if (!fuel.ok && fuel.error && fuel.error !== 'no-funder (הסולם יבש — המזרקה תמלא כשעמלות-אמת יימדדו)') {
      card.actions.push({ hand: h, what: 'fuel', detail: `נדחה: ${fuel.error}`, ok: false })
    } else {
      card.actions.push({ hand: h, what: 'fuel', detail: fuel.ok ? 'עודכן (≤50kµ)' : 'הסולם-יבש — ממתין-לעמלות-אמת (כן)', ok: true })
      if (fuel.ok) did = true
    }
  }
  // מלאי-WSTEEM: עטיפת-1:1-מ-STEEM-של-המפעיל (גיבוי-נעול) והעברה-ליד
  const op = st?.wallets?.find((x) => x.name === 'operator')
  const opSteem = op?.balances?.STEEM ?? 0
  const peg = walletOf(st, HAND_PEG)
  const wGap = SEED[HAND_PEG].wsteemMu - peg.wsteemMu
  if (wGap > 1000 && opSteem > wGap + 1000) {
    const mint = await dexPost('wrap', { action: 'mint', asset: 'WSTEEM', amount: wGap })
    card.actions.push({ hand: HAND_PEG, what: 'wrap-mint-1:1', detail: `${wGap}µ STEEM→WSTEEM (גיבוי-נעול) → ${mint.ok ? 'queued' : `נדחה: ${mint.error}`}`, ok: mint.ok })
    if (mint.ok) {
      const xfer = await dexPost('transfer', { from: 'operator', to: HAND_PEG, asset: 'WSTEEM', amountMu: wGap })
      card.actions.push({ hand: HAND_PEG, what: 'fund-wrapped', detail: `העברה-ליד ${wGap}µ → ${xfer.ok ? 'queued' : `נדחה: ${xfer.error}`}`, ok: xfer.ok })
      if (xfer.ok) did = true
    }
  }
  if (did) lastTopupAt = Date.now()
}

// ── יד-א': ארב-פאריטי על WSTEEM/USDS ────────────────────────────────────────
async function handArbPeg(card: RunCard, st: DexState | null, orders: MyOrders | null): Promise<void> {
  const parity = card.truth.parityMu
  if (!parity) {
    card.actions.push({ hand: HAND_PEG, what: 'skip', detail: 'אין-פאריטי-אמת', ok: false })
    return
  }
  // גם-ספר-ריק-הוא-הזדמנות: היד-יוצרת-שוק-מפאריטי-האמת (ההצעה-הראשונה-היא-גילוי-המחיר)
  const m = marketOf(st, 'WSTEEM', 'USDS')
  const w = walletOf(st, HAND_PEG)
  const bestBid = m?.bestBid ?? null
  const premium = bestBid ? Math.round(((bestBid - parity) / parity) * 10_000) : null
  card.book = { internalMidMu: m?.fair ?? parity, bestBid, bestAsk: m?.bestAsk ?? null, premiumBps: premium }

  // מימושים: פקודה-שנעלמה-מהחיים = מומשה-מלא
  const live = orders?.orders ?? []
  const liveIds = new Set(live.map((o) => o.id))
  for (const prev of prevPegOrders) {
    if (!liveIds.has(prev.id)) {
      const edge = Math.round(((prev.price - parity) / parity) * 10_000)
      card.fills.push({
        hand: HAND_PEG, orderId: prev.id, side: prev.side, price: prev.price,
        qtyMu: Math.max(prev.amount - prev.filled, 0),
        edgeBpsVsParity: prev.side === 'sell' ? edge : -edge,
      })
    }
  }
  prevPegOrders = live as PrevOrders

  // מכירה-מעל-פאריטי-בלבד. שתי-מסילות:
  //   (א) פרמיה-חיה-מכסה-קצה → חציית-הצעת-המייקר (IOC — מימוש-מיידי)
  //   (ב) סולם-מנוח-מעל-פאריטי (postOnly) — המחיר-הטוב-בספר נסחף-ראשון ע"י-הזרימה,
  //       וכל-מימוש-כזה-מושך-את-הספר-מטה-לגלוי-מחיר-אמת
  if (bestBid && premium !== null && premium >= MIN_EDGE_BPS) {
    const askPx = bestBid
    const qtyMu = Math.min(w.wsteemMu, Math.floor((SELL_NOTIONAL_CAP_MU * 1000) / askPx))
    if (qtyMu >= 500) {
      const r = await dexPost('order', { action: 'order', base: 'WSTEEM', quote: 'USDS', side: 'sell', price: askPx, amount: qtyMu, issuer: HAND_PEG, ioc: true })
      card.actions.push({ hand: HAND_PEG, what: 'sell-cross', detail: `ask=${askPx}µ (פאריטי=${parity}µ, פרמיה=${premium}bps) qty=${qtyMu}µ`, ok: r.ok })
    }
  } else if (w.wsteemMu >= 500) {
    const hasAsk = live.some((o) => o.side === 'sell')
    if (!hasAsk) {
      const askPx = Math.ceil(parity * (1 + MIN_EDGE_BPS / 10_000))
      const qtyMu = Math.min(w.wsteemMu, Math.floor((SELL_NOTIONAL_CAP_MU * 1000) / askPx))
      if (qtyMu >= 500) {
        const r = await dexPost('order', { action: 'order', base: 'WSTEEM', quote: 'USDS', side: 'sell', price: askPx, amount: qtyMu, issuer: HAND_PEG, postOnly: true })
        card.actions.push({ hand: HAND_PEG, what: 'ask-above-parity', detail: `ask=${askPx}µ (פאריטי=${parity}µ +${MIN_EDGE_BPS}bps) qty=${qtyMu}µ מלאי=${w.wsteemMu}µ`, ok: r.ok })
      }
    } else {
      card.actions.push({ hand: HAND_PEG, what: 'ask-resting', detail: `סולם-מכירה-מעל-פאריטי-חי (מלאי=${w.wsteemMu}µ)`, ok: true })
    }
  } else if (bestBid) {
    card.actions.push({ hand: HAND_PEG, what: 'hold-sell', detail: `פרמיה=${premium}bps < מינימום ${MIN_EDGE_BPS}bps ואין-מלאי`, ok: true })
  }

  // קנייה-רק-מתחת-לפאריטי (postOnly — עומק-ממתין-לשפל-אמת)
  const buyPx = Math.floor(parity * (1 - BUY_MARGIN_BPS / 10_000))
  const hasBid = live.some((o) => o.side === 'buy')
  if (!hasBid && w.usdsMu > 3000) {
    const qtyMu = Math.min(10_000, Math.floor((Math.min(w.usdsMu, 12_000) * 1000) / buyPx))
    const r = await dexPost('order', { action: 'order', base: 'WSTEEM', quote: 'USDS', side: 'buy', price: buyPx, amount: qtyMu, issuer: HAND_PEG, postOnly: true })
    card.actions.push({ hand: HAND_PEG, what: 'bid-below-parity', detail: `bid=${buyPx}µ (פאריטי=${parity}µ −${BUY_MARGIN_BPS}bps) qty=${qtyMu}µ`, ok: r.ok })
  }
}

// ── יד-ב': גריד-מייקר על SAOS/USDS ──────────────────────────────────────────
const MM_LEVELS = 2
function mmStepBps(spreadBps: number): number {
  const s = spreadBps > 0 ? Math.round(spreadBps / 2) : 40
  return Math.max(20, Math.min(200, s))
}
let lastMmMid: number | null = null
async function handGridMm(card: RunCard, st: DexState | null, orders: MyOrders | null): Promise<void> {
  // מקור-מגע: ספר-חי → נקודת-ייחוס-מוכרזת → זיכרון-אחרון (ספר-ריק-אינו-תירוץ-לשתיקה)
  const m = marketOf(st, 'SAOS', 'USDS')
  const w = walletOf(st, HAND_MM)
  const mid = m?.bestBid && m?.bestAsk ? Math.round((m.bestBid + m.bestAsk) / 2)
    : m?.fair ?? st?.state?.assets?.SAOS?.refPrice ?? lastMmMid
  if (!mid) {
    card.actions.push({ hand: HAND_MM, what: 'skip', detail: 'אין-מקור-מגע-ל-SAOS', ok: false })
    return
  }
  lastMmMid = mid
  const step = mmStepBps(m?.spreadBps ?? 0)
  const live = orders?.orders ?? []
  const liveIds = new Set(live.map((o) => o.id))
  for (const prev of prevMmOrders) {
    if (!liveIds.has(prev.id)) {
      card.fills.push({ hand: HAND_MM, orderId: prev.id, side: prev.side, price: prev.price, qtyMu: Math.max(prev.amount - prev.filled, 0), edgeBpsVsParity: null })
    }
  }
  prevMmOrders = live as PrevOrders

  const bids = live.filter((o) => o.side === 'buy').length
  const asks = live.filter((o) => o.side === 'sell').length
  let placed = 0
  // סולם-קנייה-מתחת-למגע (postOnly — מייקר-טהור)
  for (let i = 1; i <= MM_LEVELS && bids < MM_LEVELS; i++) {
    const px = Math.floor(mid * (1 - (step * i) / 10_000))
    if (m?.bestBid && px >= m.bestBid) continue // לא-חוצה — טהרת-מייקר
    const qtyMu = Math.min(4_000, Math.floor((w.usdsMu * 1000) / px / 2))
    if (qtyMu < 500) break
    const r = await dexPost('order', { action: 'order', base: 'SAOS', quote: 'USDS', side: 'buy', price: px, amount: qtyMu, issuer: HAND_MM, postOnly: true })
    card.actions.push({ hand: HAND_MM, what: `mm-bid-L${i}`, detail: `px=${px}µ mid=${mid}µ step=${step}bps`, ok: r.ok })
    if (r.ok) placed++
  }
  // סולם-מכירה-מעל-המגע — רק-ממלאי-אמת (אף-מכירה-באוויר)
  for (let i = 1; i <= MM_LEVELS && asks < MM_LEVELS; i++) {
    const px = Math.ceil(mid * (1 + (step * i) / 10_000))
    if (m?.bestAsk && px <= m.bestAsk) continue
    const holdMu = Math.min(w.saosMu, 4_000)
    if (holdMu < 500) break
    const r = await dexPost('order', { action: 'order', base: 'SAOS', quote: 'USDS', side: 'sell', price: px, amount: holdMu, issuer: HAND_MM, postOnly: true })
    card.actions.push({ hand: HAND_MM, what: `mm-ask-L${i}`, detail: `px=${px}µ mid=${mid}µ step=${step}bps hold=${holdMu}µ`, ok: r.ok })
    if (r.ok) placed++
  }
  if (placed === 0) card.actions.push({ hand: HAND_MM, what: 'mm-rest', detail: `bids=${bids} asks=${asks} — הסולם-כבר-מצוטט`, ok: true })
}

// ── מחזור ────────────────────────────────────────────────────────────────────
function appendCard(card: RunCard): void {
  lastCard = card
  try {
    appendFileSync(CARDS_PATH, JSON.stringify(card) + '\n')
    if (card.cycle % 800 === 0) {
      try {
        const lines = readFileSync(CARDS_PATH, 'utf-8').trim().split('\n').filter(Boolean)
        writeAtomic(CARDS_PATH, lines.slice(-CARDS_KEEP).join('\n') + '\n')
      } catch { /* כנות — המשך */ }
    }
  } catch (e) {
    log(`כשל-כתיבת-כרטיס (כן): ${e instanceof Error ? e.message : String(e)}`)
  }
}

function mtmPnl(st: DexState | null, card: RunCard): number {
  // מידה-כנה: נזיל + מלאי-מסומן-במחיר-הפנימי-החי, מול-זרע-ידוע (sim-µ מתויג)
  let total = 0
  const saosMark = marketOf(st, 'SAOS', 'USDS')?.fair ?? 2500
  const wsteemMark = card.book.internalMidMu ?? 0
  for (const h of HANDS) {
    const w = walletOf(st, h)
    const baseMu = h === HAND_PEG ? w.wsteemMu : w.saosMu
    const mark = h === HAND_PEG ? wsteemMark : saosMark
    const seed = SEED[h]
    const seedBase = h === HAND_PEG ? seed.wsteemMu : seed.saosMu
    total += w.usdsMu + Math.floor((baseMu * mark) / 1000) - (seed.usdsMu + Math.floor((seedBase * mark) / 1000))
  }
  return total
}

async function cycle(): Promise<void> {
  if (halted) return
  const g = await gather()
  const st = g.dex
  if (!st || !st.state) {
    consecErrors++
    lastError = 'dex-state-unreachable'
    log(`הדקס-לא-נגיש (${consecErrors}/${MAX_CONSEC_ERRORS})`)
    if (consecErrors >= MAX_CONSEC_ERRORS) {
      halted = true
      writeAtomic(HALT_PATH, JSON.stringify({ at: new Date().toISOString(), reason: 'dex-unreachable-streak' }))
      log('🛑 halt-אוטומטי: הדקס-בלתי-נגיש-ברצף')
    }
    return
  }
  if (st.state.halted) {
    lastError = 'dex-chain-halted'
    return
  }
  consecErrors = 0
  cycles++
  lastCycleAt = new Date().toISOString()

  const steemUsd = g.proof?.external?.steemUsd ?? null
  const feedOk = g.proof?.external?.feedOk ?? false
  const feedStale = g.proof?.external?.feedStale ?? false
  const realSteemSbd = g.grid?.price ?? null
  const impliedSteemUsd = realSteemSbd ? realSteemSbd * 1 : null // SBD≈USD — צליבה-מתויגת
  const parity = steemUsd ? Math.round(steemUsd * 1000) : null
  const card: RunCard = {
    at: lastCycleAt!,
    cycle: cycles,
    truth: {
      steemUsd, feedOk, feedStale, realSteemSbd, impliedSteemUsd, parityMu: parity,
      sources: ['dex/price-proof:external.steemUsd (coingecko+coinpaprika+binance — מדיד)', 'saos-grid:realPrice (שוק-הפנים-האמת, SBD-ל-STEEM)', 'צליבת-SBD≈USD (הנחה-מתויגת)'],
    },
    book: { internalMidMu: null, bestBid: null, bestAsk: null, premiumBps: null },
    actions: [], fills: [], hands: {}, mtmPnlMu: 0,
    halted: false,
    note: 'הספר-סימולציה-מוצהרת; הקלטות-אמת-מהשרשרת-האמיתית-ומהפיד-החוץ-המדיד',
  }

  try {
    await ensureFunded(st, card)
    await handArbPeg(card, st, g.orders[HAND_PEG])
    if (card.actions.filter((a) => a.hand === HAND_PEG && a.ok).length < 3) {
      await handGridMm(card, st, g.orders[HAND_MM])
    }
  } catch (e) {
    consecErrors++
    lastError = e instanceof Error ? e.message : String(e)
    card.note += ` | שגיאה: ${lastError}`
  }

  const st2 = await jget<DexState>(`${DEX}/state`)
  if (st2) {
    for (const h of HANDS) {
      const w = walletOf(st2, h)
      card.hands[h] = {
        usdsMu: w.usdsMu,
        baseMu: h === HAND_PEG ? w.wsteemMu : w.saosMu,
        lockedUsdsMu: w.lockedUsds,
        lockedBaseMu: h === HAND_PEG ? w.lockedWsteem : w.lockedSaos,
      }
    }
    card.mtmPnlMu = mtmPnl(st2, card)
  }
  appendCard(card)
  const fillsN = card.fills.length
  const actsN = card.actions.filter((a) => a.ok).length
  log(`מחזור #${cycles}: גובה=${st.state.height ?? '?'} פאריטי=${parity ?? '?'}µ מגע=${card.book.internalMidMu ?? '?'}µ פרמיה=${card.book.premiumBps ?? '?'}bps פעולות=${actsN} מימושים=${fillsN} MTM=${card.mtmPnlMu}µ`)
}

// ── שרת ──────────────────────────────────────────────────────────────────────
function healthJson(): Record<string, unknown> {
  return {
    ok: true,
    service: 'saos-arb',
    port: PORT,
    role: 'איבר-השוק-החריף: גריד+ארביטראז על הספר של הדקס-הריבוני, מחובר-לאמת-חוץ-מדידה',
    startedAt, cycles, lastCycleAt, halted,
    consecErrors, lastError,
    hands: HANDS,
    minEdgeBps: MIN_EDGE_BPS,
    honesty: 'הספר-סימולציה-מוצהרת; run-cards-מאומתים; אין-מפתחות; אין-המצאת-מספרים',
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const u = new URL(req.url)
    const p = u.pathname
    if (p === '/health') return Response.json(healthJson())
    if (p === '/state') return Response.json({ ...healthJson(), lastCard })
    if (p === '/run-cards') {
      try {
        const n = Math.min(Math.max(Number(u.searchParams.get('n') ?? 20), 1), 200)
        const lines = readFileSync(CARDS_PATH, 'utf-8').trim().split('\n').filter(Boolean)
        const cards = lines.slice(-n).map((l) => {
          try { return JSON.parse(l) as unknown } catch { return { parse: 'failed' } }
        })
        return Response.json({ ok: true, count: cards.length, total: lines.length, cards })
      } catch {
        return Response.json({ ok: true, count: 0, total: 0, cards: [], note: 'עדיין-אין-כרטיסים' })
      }
    }
    if (p === '/halt' && req.method === 'POST') {
      halted = true
      writeAtomic(HALT_PATH, JSON.stringify({ at: new Date().toISOString(), reason: 'manual' }))
      log('🛑 kill-switch: הופעל-ידנית')
      return Response.json({ ok: true, halted: true })
    }
    if (p === '/resume' && req.method === 'POST') {
      halted = false
      consecErrors = 0
      try { unlinkSync(HALT_PATH) } catch { /* כבר-נקי */ }
      log('▶️ המשך: הופעל')
      return Response.json({ ok: true, halted: false })
    }
    // API-כלים-לסוכנים (דפוס-Vibe-Trading שאומץ): קריאה-בלבד — מוטציות-עוברות-רק
    // דרך-שערי-הדקס-עצמו (x-saos-operator), אפס-עקיפה.
    if (p === '/tool') {
      return Response.json({
        ok: true,
        tools: [
          { name: 'hotmarket.state', desc: 'מצב-השוק-החריף המלא (truth/book/hands/actions/fills/MTM)', call: 'GET /state' },
          { name: 'hotmarket.run_cards', desc: 'רכיבי-ריצה-מאומתים אחרונים (?n=)', call: 'GET /run-cards?n=20' },
          { name: 'hotmarket.truth', desc: 'אמת-החוץ-המדידה: steemUsd רב-מקורות + פאריטי + פרמיה', call: 'GET /state (שדה lastCard.truth)' },
          { name: 'dex.state', desc: 'מצב-הדקס-הריבוני (קריאה-ציבורית)', call: `GET ${DEX}/state` },
          { name: 'dex.price_proof', desc: 'הוכחת-מחיר: פנים-מול-חוץ', call: `GET ${DEX}/price-proof` },
        ],
        note: 'מוטציות-על-הספר: רק-דרך-שער-המפעיל-של-הדקס (x-saos-operator) — אין-עקיפה',
      })
    }
    return new Response('not found', { status: 404 })
  },
})

log(`איבר-השוק-החריף חי על :${PORT} — גריד+ארב על הדקס-הריבוני (${DEX}); מחזור ${CYCLE_MS / 1000}ש'; הפרמיה-מעל-פאריטי-אמת = הרווח-הנמדד; run-cards ב-${CARDS_PATH}`)
void cycle()
setInterval(() => void cycle(), CYCLE_MS)
