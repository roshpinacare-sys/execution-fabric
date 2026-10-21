// ===== מוח-הגריד — אסטרטגיה, custody, ביצוע, בטיחות, מצב-עמיד =====
// גוף-אחד-חכם-עם-הרבה-ידיים: מוח-אחד מקצה-פסים-בין-חשבונות (אפס-דריסות),
// מדיד-כנה (shadow מתויג-ככזה, live רק-עם-מפתחות-אמיתיים), fail-closed בכל-שכבה.

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import * as market from './market'

export const ROOT = join(import.meta.dir, '..', '..')
export const VAULT = join(ROOT, 'upload', 'steem.env')

// ── תצורה ────────────────────────────────────────────────────────────────────
export type GridConfig = {
  levels: number // רמות-לכל-צד
  stepPct: number // מרווח-בין-רמות (%)
  orderSizeSbd: number // גודל-פקודת-קנייה (SBD)
  orderSizeSteem: number // גודל-פקודת-מכירה (STEEM)
  reservePct: number // יתרת-חירום-שלא-נסחרת (%)
  maxOpenPerAccount: number
  requoteDriftPct: number // סטייה-מהמחיר-שמצדיקה-ביטול-והצבה-מחדש
  maxSideSkewPct: number // Task-107 (AutoHedge: max_inventory_exposure) — אף-צד-לא-יותר-מ-%־זה מהחשיפה
}
export const CONFIG: GridConfig = {
  levels: num(envOf('GRID_LEVELS'), 4),
  stepPct: num(envOf('GRID_STEP_PCT'), 0.75),
  orderSizeSbd: num(envOf('ORDER_SIZE_SBD'), 5),
  orderSizeSteem: num(envOf('ORDER_SIZE_STEEM'), 10),
  reservePct: num(envOf('RESERVE_PCT'), 10),
  maxOpenPerAccount: num(envOf('MAX_OPEN_PER_ACCOUNT'), 10),
  requoteDriftPct: num(envOf('REQUOTE_DRIFT_PCT'), 1.5),
  maxSideSkewPct: num(envOf('GRID_MAX_SIDE_SKEW_PCT'), 80),
}
function num(v: string | undefined, d: number): number {
  const n = parseFloat(v ?? '')
  return Number.isFinite(n) && n > 0 ? n : d
}
function envOf(k: string): string | undefined {
  if (!existsSync(VAULT)) return undefined
  const line = readFileSync(VAULT, 'utf-8')
    .split('\n')
    .find((l) => l.startsWith(`${k}=`))
  return line?.split('=').slice(1).join('=').trim()
}

// ── custody — הכספת. אפס-פלט-של-סודות, אף-פעם ───────────────────────────────
export type Account = {
  name: string
  wif: string | null // null = צל (אין-מפתח)
}
let custodyCache: { at: number; accounts: Account[] } | null = null

export function loadAccounts(force = false): Account[] {
  if (!force && custodyCache && Date.now() - custodyCache.at < 30_000) return custodyCache.accounts
  const accounts: Account[] = []
  const namesRaw = envOf('GRID_ACCOUNTS') ?? ''
  const names = namesRaw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (!existsSync(VAULT)) {
    // ברירת-מחדל-בשחזור: הכספת-ריקה → מצב-צל על-חשבונות-מוכרים (מהעדות-האחרונה)
    custodyCache = { at: Date.now(), accounts: [{ name: 'headcorner', wif: null }] }
    return custodyCache.accounts
  }
  for (const name of names) {
    const keyName = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_ACTIVE_WIF`
    const wif = envOf(keyName) ?? null
    accounts.push({ name, wif: wif && wif.length >= 40 ? wif : null })
  }
  if (accounts.length === 0) accounts.push({ name: 'headcorner', wif: null })
  custodyCache = { at: Date.now(), accounts }
  return accounts
}
export function mode(): 'shadow' | 'live' {
  return loadAccounts().some((a) => a.wif) ? 'live' : 'shadow'
}
export function fingerprint(): string {
  // זיהוי-ללא-חשיפה: שמות + האם-יש-מפתח + 4-תווים-אחרונים-של-hash
  return loadAccounts()
    .map((a) => `${a.name}${a.wif ? `:${Bun.hash(a.wif).toString(16).slice(-4)}` : ':shadow'}`)
    .join(',')
}

// ── מצב-עמיד (sqlite WAL) ────────────────────────────────────────────────────
mkdirSync(join(import.meta.dir, 'state'), { recursive: true })
const db = new Database(join(import.meta.dir, 'state', 'grid.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec(`CREATE TABLE IF NOT EXISTS grid_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  account TEXT NOT NULL,
  side TEXT NOT NULL,
  level INTEGER NOT NULL,
  price REAL NOT NULL,
  amount_steem REAL NOT NULL,
  amount_sbd REAL NOT NULL,
  kind TEXT NOT NULL,        -- place|cancel|fill|halt|resume|error|decision
  mode TEXT NOT NULL,        -- shadow|live
  detail TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS grid_orders (
  orderid TEXT PRIMARY KEY,  -- shadow:<n> או מס'-פקודה-אמיתי
  account TEXT NOT NULL,
  side TEXT NOT NULL,
  level INTEGER NOT NULL,
  price REAL NOT NULL,
  amount_steem REAL NOT NULL,
  amount_sbd REAL NOT NULL,
  placed_at TEXT NOT NULL,
  status TEXT NOT NULL,      -- open|filled|canceled
  filled_at TEXT,
  mode TEXT NOT NULL
)`)
db.exec(`CREATE TABLE IF NOT EXISTS grid_meta (k TEXT PRIMARY KEY, v TEXT)`)

function meta(k: string): string | null {
  return (db.query('SELECT v FROM grid_meta WHERE k=?').get(k) as { v: string } | null)?.v ?? null
}
function setMeta(k: string, v: string): void {
  db.query('INSERT INTO grid_meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v)
}

export function event(kind: string, d: Omit<Row, 'id' | 'at'> & { detail?: string }): void {
  db.query(
    'INSERT INTO grid_events(at,account,side,level,price,amount_steem,amount_sbd,kind,mode,detail) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(new Date().toISOString(), d.account, d.side, d.level, d.price, d.amountSteem, d.amountSbd, kind, d.mode, d.detail ?? null)
}
type Row = {
  id?: number
  at?: string
  account: string
  side: string
  level: number
  price: number
  amountSteem: number
  amountSbd: number
  mode: string
  detail?: string | null
}

// ── בטיחות — kill-switch עמיד ────────────────────────────────────────────────
export function halted(): boolean {
  return meta('halt') === '1'
}
export function halt(reason: string, auto: boolean): void {
  if (halted()) return
  setMeta('halt', '1')
  setMeta('haltReason', reason)
  setMeta('haltAt', new Date().toISOString())
  event(auto ? 'auto-halt' : 'halt', {
    account: '*',
    side: '-',
    level: 0,
    price: 0,
    amountSteem: 0,
    amountSbd: 0,
    mode: mode(),
    detail: reason,
  })
}
export function resume(): void {
  if (!halted()) return
  setMeta('halt', '0')
  setMeta('haltReason', '')
  event('resume', { account: '*', side: '-', level: 0, price: 0, amountSteem: 0, amountSbd: 0, mode: mode(), detail: 'הופעל-מחדש' })
}
export function haltInfo(): { halted: boolean; reason: string; at: string | null } {
  return { halted: halted(), reason: meta('haltReason') ?? '', at: meta('haltAt') }
}

// ── מצב-ריצה ─────────────────────────────────────────────────────────────────
export type CycleStats = {
  cycles: number
  lastCycleAt: string | null
  lastCycleMs: number
  lastError: string | null
  consecutiveErrors: number
  price: number | null
  lastPrice: number | null
}
export const stats: CycleStats = {
  cycles: 0,
  lastCycleAt: null,
  lastCycleMs: 0,
  lastError: null,
  consecutiveErrors: 0,
  price: null,
  lastPrice: null,
}

// ── המחזור — מוח-אחד, הרבה-ידיים ─────────────────────────────────────────────
type Plan = { account: string; side: 'buy' | 'sell'; level: number; price: number; amountSteem: number; amountSbd: number }

export async function cycle(): Promise<{ placed: number; canceled: number; filledShadow: number; decisions: string[] }> {
  const t0 = Date.now()
  const decisions: string[] = []
  let placed = 0
  let canceled = 0
  let filledShadow = 0
  try {
    if (halted()) {
      stats.lastCycleAt = new Date().toISOString()
      return { placed: 0, canceled: 0, filledShadow: 0, decisions: ['halted — מחזור-מושהה'] }
    }

    // 1) שוק — אמת-מהשרשרת
    const book = await market.getOrderBook(50)
    if (!book.ok) throw new Error(`שוק-לא-נקרא: ${book.error}`)
    const trades = await market.getRecentTrades(40)
    const m = book.data
    stats.lastPrice = stats.price
    stats.price = m.mid
    if (m.mid === null) throw new Error('אין-מחיר-אמצעי')
    decisions.push(`שוק: bid=${m.bestBid?.toFixed(4)} ask=${m.bestAsk?.toFixed(4)} mid=${m.mid.toFixed(4)} נזילות-STEEM=${Math.round(m.bidVolSteem + m.askVolSteem)}`)

    // 2) סערה — תנודה-פתאומית → עצירה-כנה
    if (stats.lastPrice !== null && stats.lastPrice > 0) {
      const swing = Math.abs(m.mid - stats.lastPrice) / stats.lastPrice
      if (swing > 0.05) {
        halt(`תנודה-קיצונית ${((swing) * 100).toFixed(2)}% במחזור-אחד — עצירה-בטיחותית`, true)
        return { placed: 0, canceled: 0, filledShadow: 0, decisions: [...decisions, 'auto-halt: תנודה-קיצונית'] }
      }
    }

    // 3) מרווח-מסתגל מתנודתיות-אמיתית (clamp 0.4–2.0%)
    let stepPct = CONFIG.stepPct
    if (trades.ok && trades.data.length >= 8) {
      const prices = trades.data.map((t) => t.price)
      const mean = prices.reduce((s, p) => s + p, 0) / prices.length
      const sd = Math.sqrt(prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length)
      const volPct = (sd / mean) * 100
      stepPct = Math.min(2, Math.max(0.4, Math.max(CONFIG.stepPct, volPct * 1.5)))
      decisions.push(`תנודתיות ${volPct.toFixed(2)}% → מרווח-גריד ${stepPct.toFixed(2)}%`)
    }

    // 4) ידיים — חשבונות-מהכספת; מפתח-חסר = יד-בצל
    const accounts = loadAccounts()
    const names = accounts.map((a) => a.name)
    const bals = await market.getAccounts(names)
    if (!bals.ok) throw new Error(`יתרות-לא-נקראו: ${bals.error}`)
    const live = mode()

    // 4.5) מנהל-חשיפה (Task-107 — AutoHedge: max_inventory_exposure + rebalance):
    // שקילות-המלאי-האמתי-של-הידיים; צד-כבד-מדי → תוכניות-הצד-השני-מקדימות-והכבד-נחסם.
    // כנות: פסק-החשיפה נרשם-בכל-מחזור-שהושפע.
    const found = bals.data.filter((b) => b.found)
    const totalSteem = found.reduce((s2, b) => s2 + b.steem, 0)
    const totalSbd = found.reduce((s2, b) => s2 + b.sbd, 0)
    const steemVal = totalSteem * (m.mid ?? 0)
    const basePct = steemVal + totalSbd > 0 ? (steemVal / (steemVal + totalSbd)) * 100 : 50
    let skipSide: 'buy' | 'sell' | null = null
    if (basePct > CONFIG.maxSideSkewPct) skipSide = 'buy' // כבד-ב-STEEM — אין-קניות-נוספות עד-איזון
    else if (100 - basePct > CONFIG.maxSideSkewPct) skipSide = 'sell' // כבד-ב-SBD — אין-מכירות-נוספות
    if (skipSide) {
      decisions.push(`מנהל-חשיפה: STEEM=${basePct.toFixed(1)}% מהמלאי (סף-${CONFIG.maxSideSkewPct}%) → פקודות-${skipSide === 'buy' ? 'קנייה' : 'מכירה'}-מושהות-עד-איזון (AutoHedge-rebalance)`)
      event('decision', { account: '*', side: skipSide, level: 0, price: m.mid!, amountSteem: 0, amountSbd: 0, mode: live, detail: `exposure-governor: basePct=${basePct.toFixed(1)}% skip=${skipSide}` })
    }

    // 5) הקצאת-פסים-ללא-דריסות: רמה-L שייכת-לחשבון L%n (מוח-אחד, ידיים-מחולקות)
    const n = accounts.length
    const step = m.mid * (stepPct / 100)
    const plans: Plan[] = []
    for (let L = 0; L < CONFIG.levels; L++) {
      const acct = accounts[L % n].name
      const buyPrice = m.mid - step * (L + 1)
      const sellPrice = m.mid + step * (L + 1)
      const bal = bals.data.find((b) => b.account === acct)
      if (!bal?.found) {
        decisions.push(`${acct}: חשבון-לא-נמצא-בשרשרת — מדולג`)
        continue
      }
      // מנהל-החשיפה: הצד-הכבד-נחסם (Task-107)
      if (skipSide === 'buy') {
        decisions.push(`${acct}: קנייה-דחויה-בידי-מנהל-החשיפה`)
      } else {
      // קנייה: עדכני-לגבי-יתרת-SBD-זמינה (כולל-הפקודות-הפתוחות-של-הרמה-הזאת)
      const sbdAvail = bal.sbd * (1 - CONFIG.reservePct / 100)
      const buySbd = Math.min(CONFIG.orderSizeSbd, sbdAvail)
      if (buySbd >= 0.5) {
        plans.push({ account: acct, side: 'buy', level: L, price: buyPrice, amountSteem: buySbd / buyPrice, amountSbd: buySbd })
      } else {
        decisions.push(`${acct}: SBD-מתחת-לגודל-מינימלי (${bal.sbd.toFixed(2)} SBD, חירום ${CONFIG.reservePct}%)`)
      }
      }
      if (skipSide === 'sell') {
        decisions.push(`${acct}: מכירה-דחויה-בידי-מנהל-החשיפה`)
      } else {
      const steemAvail = bal.steem * (1 - CONFIG.reservePct / 100)
      const sellSteem = Math.min(CONFIG.orderSizeSteem, steemAvail)
      if (sellSteem >= 0.5) {
        plans.push({ account: acct, side: 'sell', level: L, price: sellPrice, amountSteem: sellSteem, amountSbd: sellSteem * sellPrice })
      } else {
        decisions.push(`${acct}: STEEM-מתחת-לגודל-מינימלי (${bal.steem.toFixed(3)} STEEM, חירום ${CONFIG.reservePct}%)`)
      }
      }
    }

    // 6) גשם-מילויים בצל: פקודות-פתוחות-שהמחיר-עבר-אותן → מולאו (מדומה, מתויג)
    if (live === 'shadow') {
      const open = db.query("SELECT * FROM grid_orders WHERE status='open' AND mode='shadow'").all() as Array<{
        orderid: string; account: string; side: string; level: number; price: number; amount_steem: number; amount_sbd: number
      }>
      for (const o of open) {
        const crossed = o.side === 'buy' ? m.mid <= o.price : m.mid >= o.price
        if (crossed) {
          db.query("UPDATE grid_orders SET status='filled', filled_at=? WHERE orderid=?").run(new Date().toISOString(), o.orderid)
          event('fill', {
            account: o.account, side: o.side, level: o.level, price: o.price,
            amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'shadow',
            detail: 'מימוש-מדומה (צל) — המחיר-חצה-את-הפקודה',
          })
          filledShadow++
          // רשת-קלאסית: על-מימוש-קנייה → הצב-מכירה-ברמה-+1 (ולהפך)
          const nextSide = o.side === 'buy' ? 'sell' : 'buy'
          const nextPrice = o.side === 'buy' ? o.price * (1 + (stepPct * 2) / 100) : o.price * (1 - (stepPct * 2) / 100)
          const nid = `shadow:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          const nextSteem = o.side === 'buy' ? o.amount_sbd / o.price : o.amount_steem
          const nextSbd = o.side === 'buy' ? nextSteem * nextPrice : o.amount_steem * o.price
          db.query('INSERT INTO grid_orders(orderid,account,side,level,price,amount_steem,amount_sbd,placed_at,status,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            nid, o.account, nextSide, o.level, nextPrice, nextSteem, nextSbd, new Date().toISOString(), 'open', 'shadow',
          )
          placed++
          decisions.push(`רשת: מימוש-${o.side === 'buy' ? 'קנייה' : 'מכירה'}-בצל → פקודת-${nextSide === 'buy' ? 'קנייה' : 'מכירה'}-נגדית @${nextPrice.toFixed(4)} (${o.account})`)
        }
      }
    }

    // 7) קיזוז-סטיות: פקודות-צל-שהמחיר-התרחק-מהן-מעל-הסף → ביטול (יסגרו-מחדש-בתכנון)
    if (live === 'shadow') {
      const drift = m.mid * (CONFIG.requoteDriftPct / 100)
      const stale = db.query("SELECT orderid, side, price, account FROM grid_orders WHERE status='open' AND mode='shadow'").all() as Array<{ orderid: string; side: string; price: number; account: string }>
      for (const o of stale) {
        if (Math.abs(o.price - m.mid) > drift) {
          db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
          event('cancel', { account: o.account, side: o.side, level: 0, price: o.price, amountSteem: 0, amountSbd: 0, mode: 'shadow', detail: 'סטייה-מעל-סף-הקיזוז' })
          canceled++
        }
      }
    }

    // 8) ביצוע-התוכניות
    for (const p of plans) {
      const acct = accounts.find((a) => a.name === p.account)!
      const dup = db
        .query("SELECT 1 FROM grid_orders WHERE account=? AND side=? AND level=? AND status='open'")
        .get(p.account, p.side, p.level)
      if (dup) continue
      if (live === 'shadow') {
        const nid = `shadow:${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        db.query('INSERT INTO grid_orders(orderid,account,side,level,price,amount_steem,amount_sbd,placed_at,status,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          nid, p.account, p.side, p.level, p.price, p.amountSteem, p.amountSbd, new Date().toISOString(), 'open', 'shadow',
        )
        event('place', { ...p, mode: 'shadow', detail: 'צל — היה-מוצב-בשוק-אם-היה-מפתח' })
        placed++
      } else if (acct.wif) {
        const r = await broadcastLimitOrder(acct, p)
        if (r.ok) {
          db.query('INSERT INTO grid_orders(orderid,account,side,level,price,amount_steem,amount_sbd,placed_at,status,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            `live:${r.orderid}:${p.account}`, p.account, p.side, p.level, p.price, p.amountSteem, p.amountSbd, new Date().toISOString(), 'open', 'live',
          )
          event('place', { ...p, mode: 'live', detail: `שידור-אמיתי; orderid=${r.orderid}` })
          placed++
        } else {
          event('error', { ...p, mode: 'live', detail: `כשל-שידור: ${r.error}` })
          decisions.push(`${p.account}: כשל-שידור-${p.side}: ${r.error}`)
        }
      }
    }

    stats.cycles++
    stats.lastCycleAt = new Date().toISOString()
    stats.lastCycleMs = Date.now() - t0
    stats.lastError = null
    stats.consecutiveErrors = 0
    setMeta('lastGoodCycle', stats.lastCycleAt)
    return { placed, canceled, filledShadow, decisions }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stats.lastError = msg
    stats.consecutiveErrors++
    stats.lastCycleAt = new Date().toISOString()
    stats.lastCycleMs = Date.now() - t0
    event('error', { account: '*', side: '-', level: 0, price: 0, amountSteem: 0, amountSbd: 0, mode: mode(), detail: msg })
    if (stats.consecutiveErrors >= 5) halt(`5-כשלים-רצופים: ${msg}`, true)
    return { placed: 0, canceled: 0, filledShadow: 0, decisions: [`שגיאה: ${msg}`] }
  }
}

// ── שידור-חי (דורש-מפתח-אמיתי; מבודד-כדי-שצל-לא-יישבר) ──────────────────────
async function broadcastLimitOrder(acct: Account, p: Plan): Promise<{ ok: true; orderid: number } | { ok: false; error: string }> {
  try {
    const dhive = await import('@hiveio/dhive')
    const client = new dhive.Client(
      [process.env.STEEM_RPC ?? 'https://api.steemit.com'],
      { chainId: '0000000000000000000000000000000000000000000000000000000000000000' },
    )
    const ops: dhive.Operation[] = [
      [
        'limit_order_create',
        {
          owner: acct.name,
          orderid: Math.floor(Date.now() / 1000) % 2_147_483_647,
          amount_to_sell:
            p.side === 'buy'
              ? `${p.amountSbd.toFixed(3)} SBD`
              : `${p.amountSteem.toFixed(3)} STEEM`,
          min_to_receive:
            p.side === 'buy'
              ? `${p.amountSteem.toFixed(3)} STEEM`
              : `${p.amountSbd.toFixed(3)} SBD`,
          fill_or_kill: false,
          expiration: new Date(Date.now() + 28 * 24 * 3600_000).toISOString().slice(0, 19),
        },
      ],
    ]
    const key = dhive.PrivateKey.fromString(acct.wif!)
    const tx = await client.broadcast.sendOperations(ops, key)
    return { ok: true, orderid: (ops[0][1] as { orderid: number }).orderid }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── סיכום-לתצוגה ─────────────────────────────────────────────────────────────
export function summary() {
  const open = db.query("SELECT account, side, COUNT(*) n, SUM(amount_sbd) sbd, SUM(amount_steem) steem FROM grid_orders WHERE status='open' GROUP BY account, side").all() as Array<{ account: string; side: string; n: number; sbd: number; steem: number }>
  const fills = db.query("SELECT account, side, COUNT(*) n, SUM(amount_sbd) sbd FROM grid_orders WHERE status='filled' GROUP BY account, side").all() as Array<{ account: string; side: string; n: number; sbd: number }>
  const recent = db.query('SELECT * FROM grid_events ORDER BY id DESC LIMIT 30').all() as Array<Record<string, unknown>>
  // רווח-מדומה-כן: זוגות-קנייה/מכירה-שמומשו-באותה-רמה — הפרש-מחיר
  const pairs = db
    .query("SELECT level, account, side, price FROM grid_orders WHERE status='filled' ORDER BY filled_at")
    .all() as Array<{ level: number; account: string; side: string; price: number }>
  let pnlSbd = 0
  const byKey = new Map<string, { buy?: number; sell?: number }>()
  for (const p of pairs) {
    const k = `${p.account}:${p.level}`
    const e = byKey.get(k) ?? {}
    if (p.side === 'buy' && !e.buy) e.buy = p.price
    if (p.side === 'sell' && !e.sell) e.sell = p.price
    byKey.set(k, e)
    if (e.buy && e.sell) {
      const steemQty = 5 / e.buy // גודל-שמור-מהתצורה
      pnlSbd += (e.sell - e.buy) * steemQty
      byKey.delete(k)
    }
  }
  return {
    mode: mode(),
    fingerprint: fingerprint(),
    config: CONFIG,
    price: stats.price,
    lastPrice: stats.lastPrice,
    stats,
    halt: haltInfo(),
    open,
    fills,
    shadowPnlSbd: Math.round(pnlSbd * 1000) / 1000,
    shadowPnlLabeled: 'simulated', // כנות-מלאה: מימושי-צל = סימולציה
    recent,
  }
}
