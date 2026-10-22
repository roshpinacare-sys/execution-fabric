// ===== מוח-הגריד — אסטרטגיה, custody, ביצוע, בטיחות, מצב-עמיד =====
// גוף-אחד-חכם-עם-הרבה-ידיים: מוח-אחד מקצה-פסים-בין-חשבונות (אפס-דריסות),
// מדיד-כנה (shadow מתויג-ככזה, live רק-עם-מפתחות-אמיתיים), fail-closed בכל-שכבה.
//
// Task-113 (מדידה-חיה שהכתיבה-את-השינוי): המנוע-הישן היה "מציב-ושוכח" במצב-חי —
// אין-גילוי-מילויים, אין-פקודות-נגד, אין-ריקול-סטיות, ו-dup-check-על-שורות-צל
// חסם-הצבות-אמיתיות (1710-הצבות-צל, 0-שידורים). מעתה: אמת-מול-השרשרת-בכל-מחזור
// (אימוץ·מילויים·נגדים·ריקול), קו-זהות-חוץ-כרצפת-מכירה, מנהל-חשיפה-מודע-נעילות,
// ותקרת-מחויבות — הצל נשאר רק לחשבונות-בלי-מפתח, בכנות.

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import * as market from './market'
import * as ff from './ff'

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

// Task-115: טיית-איזון פעילה (AutoHedge: rebalance_threshold פעיל ולא סביל).
// הלקח-החי (00:1xZ): בסטייה-קיצונית (STEEM=97%) המנהל-רק-חוסם-את-הצד-ההפוך —
// והסולם-המאזן נשאר במרחק-מלא-מהמרכז → לא-נמדד-כלום → הסטייה-קפואה-שעות → מועצה-danger.
// התיקון: בעת-חוסר-איזון, הצד-המאזן מתקרב-למרכז (×TILT) → המרה-פעילה-עד-איזון;
// רצפת-המכירה (קו-זהות+buffer) נשמרת — אף-מכירה-מתחת-לערך-החוץ גם-בטייה.
const REBALANCE_TILT = num(envOf('GRID_REBALANCE_TILT'), 0.34)
// Task-116: הגברת-כמות-בצד-המאזן — כשהסטייה-קיצונית, סולם-המכירות-ברצפה הוא-הרגל
// היחידה-שמנבילה-נזילות-בערך-חוץ; כמות-גדולה-יותר-לכל-רמה = יותר-ווליום-שנמדד
// כשקונים-אמיתיים-מגיעים. חסום: ×4 מקסימום, תקרת-מחויבות-ויתרה-נשמרות.
const TILT_QTY_BOOST = Math.min(4, Math.max(1, num(envOf('GRID_TILT_QTY_BOOST'), 2.5)))
// Task-118: סולם-פאריטי — נמדד-חי 01:21Z: כשהמיד-7.6%-מתחת-לרצפה, כל-יעדי-הטייה
// נשאבים-אל-הרצפה ו־4 רונגות נערמות-במחיר-אחד (4×25ST @0.11088 — אפס-עומק-מעל-הרצפה).
// מעתה: רונגה-L-שנשאבה-נפרשת-מעל-הרצפה ברצפה×(1+L×צעד) — עומק-אמיתי-לוכד-מומנטום-עולה
// במחיר-ממוצע-טוב-יותר; אף-רונגה-מתחת-לרצפה (הדוקטרינה-נשמרת) ויעד-יציב-לרונגה (אנטי-צ'רנר).
const PARITY_LADDER_STEP = Math.min(3, Math.max(0.1, num(envOf('GRID_PARITY_LADDER_STEP'), 0.6)))
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

// Task-113: מגבלות-ריצה-מדודות — עיגול-ספרד-הפנימי הוא 0.001-SBD; רמה-מינימלית
export const MIN_ORDER_SBD = 0.05
export const MIN_ORDER_STEEM = 0.5
const COMMIT_PCT = 0.9 // תקרת-מחויבות-לכל-צד (grid-beat-תואם)
const FLOOR_BUFFER_BPS = 50 // הרצפה = קו-הזהות + 0.5% (אותו-מדף-מדיד)
const MAX_REQUOTE_PER_CYCLE = 4 // אנטי-צ'רנר: מקסימום-קיזוזי-חיים-למחזור
const EXPIRY_DAYS = 27 // מדידה-חיה: 28-ימים נדחה-על-ידי-השרשרת (STEEM_MAX_LIMIT_ORDER_EXPIRATION); 27 = תקרה-בטוחה-שנמדדה
// orderid-חד-ערכי-בתהליך (מדידה-חיה: שני-שידורים-באותה-שנייה עם-orderid-זהה
// נדחים-על-ידי-השרשרת "uniqueness constraint violated")
let orderIdSeq = Math.floor(Date.now() / 1000) % 2_147_483_647
function nextOrderId(): number {
  orderIdSeq = (orderIdSeq + 1) % 2_147_483_647
  return orderIdSeq
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
  kind TEXT NOT NULL,        -- place|cancel|fill|adopt|halt|resume|error|decision
  mode TEXT NOT NULL,        -- shadow|live
  detail TEXT
)`)
db.exec(`CREATE TABLE IF NOT EXISTS grid_orders (
  orderid TEXT PRIMARY KEY,  -- shadow:<n> או live:<chainid>:<account>
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
// Task-116: פנקס-מילויים-ראשי — זהות-אופ-היסטוריה. מדידה-חיה 00:34-00:42Z: 10-מילויים-
// אמיתיים-נרשמו-283-פעמים (מילוי-אחד=192-רשומות) כי-לולאת-הכנות-לא-זכרה-מה-נרשם.
// מפתח: חשבון+orderid+זמן-שרשרת+צד+כמויות — סובל-מילויים-חלקיים-חוזרים-של-אותו-orderid.
db.exec(`CREATE TABLE IF NOT EXISTS fill_ledger (
  k TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  orderid INTEGER NOT NULL,
  at TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  amount_steem REAL NOT NULL,
  amount_sbd REAL NOT NULL,
  recorded_at TEXT NOT NULL
)`)
// Task-116 ניקוי-חד-פעמי-עמיד: מחיקת-רשומות-המילוי-הכפולות-מהעבר (נשמר-הראשון-מכל
// קבוצה-זהה), עם-קבלה-גלויה. אידמפוטנטי — אחרי-הניקוי-הראשון אפס-שינויים.
try {
  const del = db.query("DELETE FROM grid_events WHERE kind='fill' AND detail LIKE '%שלא-היה-במעקב%' AND id NOT IN (SELECT MIN(id) FROM grid_events WHERE kind='fill' AND detail LIKE '%שלא-היה-במעקב%' GROUP BY account, side, price, amount_steem, amount_sbd)").run()
  if (del.changes > 0) {
    console.log(`[saos-grid] Task-116 ניקוי-חד-פעמי: ${del.changes} רשומות-מילוי-כפולות-נמחקו (נשמר-ראשון-מכל-קבוצה)`)
    db.query("INSERT INTO grid_events(at,account,side,level,price,amount_steem,amount_sbd,kind,mode,detail) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      new Date().toISOString(), '*', 'buy', 0, 0, 0, 0, 'decision', 'live',
      `Task-116-ניקוי-פנקס: ${del.changes} רשומות-כפולות-נמחקו; מעתה פנקס-fill_ledger מבטיח מילוי-אחד=רשומה-אחת`,
    )
  }
} catch { /* כנות: ניקוי-לא-קריטי */ }

// Task-113 תיקון-חד-פעמי-עמיד: שורות-שאומצו-לפני-הפרדת-הסמכויות (level=0 אבל
// לא-הוצבו-על-ידי-המנוע) → מסומנות level=-9 (מעקב-בלבד). זיהוי-הפקודות-שלנו:
// כל-הצבה-שלנו רושמת-אירוע-place-עם orderid=<N> בפירוט. אידמפוטנטי.
try {
  const mine = new Set<number>()
  for (const e of db.query("SELECT detail FROM grid_events WHERE kind='place' AND mode='live' AND detail LIKE '%orderid=%'").all() as Array<{ detail: string }>) {
    const m = /orderid=(\d+)/.exec(String(e.detail))
    if (m) mine.add(Number(m[1]))
  }
  const rows = db.query("SELECT orderid FROM grid_orders WHERE mode='live' AND status='open' AND level >= 0").all() as Array<{ orderid: string }>
  let fixed = 0
  for (const r of rows) {
    const cid = Number(r.orderid.split(':')[1])
    if (!mine.has(cid)) {
      db.query("UPDATE grid_orders SET level=-9 WHERE orderid=?").run(r.orderid)
      fixed++
    }
  }
  if (fixed) console.log(`[saos-grid] תיקון-הפרדת-סמכויות: ${fixed} פקודות-מאומצות → מעקב-בלבד`)
} catch { /* כנות: תיקון-לא-קריטי */ }

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
  floor: number | null // רצפת-מכירה (קו-זהות+בופר) — null=אין-מדידה-חיה
  identityLine: number | null
  lastReconcileAt: string | null
  lastFillsLive: number
  ffRail: { ok: boolean | null; checkedAt: string | null; note: string | null } // Task-118 דופק-FF-אוטונומי
}
export const stats: CycleStats = {
  cycles: 0,
  lastCycleAt: null,
  lastCycleMs: 0,
  lastError: null,
  consecutiveErrors: 0,
  price: null,
  lastPrice: null,
  floor: null,
  identityLine: null,
  lastReconcileAt: null,
  lastFillsLive: 0,
  ffRail: { ok: null, checkedAt: null, note: null },
}

// ── שידור-חי (דורש-מפתח-אמיתי; מבודד-כדי-שצל-לא-יישבר) ──────────────────────
async function dhiveClient() {
  const dhive = await import('@hiveio/dhive')
  const client = new dhive.Client(
    [process.env.STEEM_RPC ?? 'https://api.steemit.com'],
    { chainId: '0000000000000000000000000000000000000000000000000000000000000000' },
  )
  return { dhive, client }
}

async function broadcastLimitOrder(acct: Account, p: Plan): Promise<{ ok: true; orderid: number } | { ok: false; error: string }> {
  try {
    const { dhive, client } = await dhiveClient()
    const ops: dhive.Operation[] = [
      [
        'limit_order_create',
        {
          owner: acct.name,
          orderid: nextOrderId(),
          amount_to_sell:
            p.side === 'buy'
              ? `${p.amountSbd.toFixed(3)} SBD`
              : `${p.amountSteem.toFixed(3)} STEEM`,
          min_to_receive:
            p.side === 'buy'
              ? `${p.amountSteem.toFixed(3)} STEEM`
              : `${p.amountSbd.toFixed(3)} SBD`,
          fill_or_kill: false,
          expiration: new Date(Date.now() + EXPIRY_DAYS * 24 * 3600_000).toISOString().slice(0, 19),
        },
      ],
    ]
    const key = dhive.PrivateKey.fromString(acct.wif!)
    await client.broadcast.sendOperations(ops, key)
    return { ok: true, orderid: (ops[0][1] as { orderid: number }).orderid }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function broadcastCancel(acct: Account, orderid: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { dhive, client } = await dhiveClient()
    const ops: dhive.Operation[] = [['limit_order_cancel', { owner: acct.name, orderid }]]
    const key = dhive.PrivateKey.fromString(acct.wif!)
    await client.broadcast.sendOperations(ops, key)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── המחזור — מוח-אחד, הרבה-ידיים ─────────────────────────────────────────────
type Plan = {
  account: string
  side: 'buy' | 'sell'
  level: number
  price: number
  amountSteem: number
  amountSbd: number
  origin?: 'ladder' | 'counter' | 'requote'
}

export async function cycle(): Promise<{ placed: number; canceled: number; filledShadow: number; filledLive: number; decisions: string[] }> {
  const t0 = Date.now()
  const decisions: string[] = []
  let placed = 0
  let canceled = 0
  let filledShadow = 0
  let filledLive = 0
  try {
    if (halted()) {
      stats.lastCycleAt = new Date().toISOString()
      return { placed: 0, canceled: 0, filledShadow: 0, filledLive: 0, decisions: ['halted — מחזור-מושהה'] }
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

    // 1.5) Task-118: דופק-FF-אוטונומי — מסילת-ההמרה-החוצה נבדקת-מעצמה כל-13-מחזורים (~10ד')
    // בלי-שום-גורם-חיצוני; שינוי-מצב (401→חי) נרשם-כאירוע — המערכת-רואה-לבד שהשער-נפתח.
    if (stats.cycles % 13 === 0) {
      const ffp = await ff.probe()
      const ok = ffp.currencies !== null
      const note = ffp.currencies !== null ? `currencies=${ffp.currencies}` : (ffp.lastError ?? 'שגיאה')
      const changed = stats.ffRail.ok !== ok
      stats.ffRail = { ok, checkedAt: new Date().toISOString(), note }
      if (changed || stats.cycles === 0) {
        event('ff-probe', { account: '*', side: '-', level: 0, price: 0, amountSteem: 0, amountSbd: 0, mode: mode(), detail: `מסילת-FF: ${ok ? 'חיה' : 'חסומה'} (${note})` })
      }
      decisions.push(`מסילת-FF: ${ok ? 'חיה' : 'חסומה'} — דופק-אוטונומי (${note})`)
    }

    // 2) סערה — תנודה-פתאומית → עצירה-כנה
    if (stats.lastPrice !== null && stats.lastPrice > 0) {
      const swing = Math.abs(m.mid - stats.lastPrice) / stats.lastPrice
      if (swing > 0.05) {
        halt(`תנודה-קיצונית ${((swing) * 100).toFixed(2)}% במחזור-אחד — עצירה-בטיחותית`, true)
        return { placed: 0, canceled: 0, filledShadow: 0, filledLive: 0, decisions: [...decisions, 'auto-halt: תנודה-קיצונית'] }
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

    // 3.5) קו-הזהות-החוץ → רצפת-מכירה (מדיניות-מדודה: אף-מכירה-מתחת-לערך-החוץ)
    const marks = await market.getExternalMarks()
    const identityLine = marks && marks.sbdUsd > 0 ? marks.steemUsd / marks.sbdUsd : null
    const floor = identityLine ? identityLine * (1 + FLOOR_BUFFER_BPS / 10_000) : null
    stats.identityLine = identityLine
    stats.floor = floor
    if (identityLine) {
      decisions.push(`קו-זהות: ${identityLine.toFixed(4)} SBD/STEEM → רצפת-מכירה ${floor!.toFixed(4)} (steemUsd=$${marks!.steemUsd}, sbdUsd=$${marks!.sbdUsd}${marks!.stale ? ', עוגן-ישן-מהדיסק' : ''})`)
    } else {
      decisions.push(`קו-זהות: לא-נמדד-ואין-עוגן-דיסק-בתוקף → Task-117-fail-closed: איסור-מכירות מוחלט (לעולם-לא-מכירה-בלי-עוגן-ערך-חוץ)`)
    }

    // 4) ידיים — חשבונות-מהכספת; מפתח-חסר = יד-בצל
    const accounts = loadAccounts()
    const names = accounts.map((a) => a.name)
    const bals = await market.getAccounts(names)
    if (!bals.ok) throw new Error(`יתרות-לא-נקראו: ${bals.error}`)
    const live = mode()

    // 4.2) אמת-הפקודות-על-השרשרת (live): fail-closed — כשל-קריאה = מחזור-צפייה
    const chainOrders = new Map<string, market.OpenOrder[]>()
    if (live === 'live') {
      for (const n of names) {
        const oo = await market.getOpenOrders(n)
        if (!oo.ok) throw new Error(`פקודות-פתוחות-לא-נקראו (${n}): ${oo.error}`)
        chainOrders.set(n, oo.data)
      }
    }

    // 4.5) מנהל-חשיפה (Task-107 + Task-113): מלאי-אמתי = נזיל + נעול-בפקודות.
    // הלקח-החי: נעילות-הפקודות של-הרץ-היומי היו-בלתי-נראות-למנהל → מדידה-משובשת.
    const found = bals.data.filter((b) => b.found)
    const locked = new Map<string, { steem: number; sbd: number; sells: number; buysSbd: number }>()
    for (const n of names) {
      const oo = chainOrders.get(n) ?? []
      locked.set(n, {
        steem: oo.filter((o) => o.side === 'sell').reduce((s, o) => s + o.amountSteem, 0),
        sbd: oo.filter((o) => o.side === 'buy').reduce((s, o) => s + o.amountSbd, 0),
        sells: oo.filter((o) => o.side === 'sell').length,
        buysSbd: 0,
      })
    }
    const totalSteem = found.reduce((s2, b) => s2 + b.steem + (locked.get(b.account)?.steem ?? 0), 0)
    const totalSbd = found.reduce((s2, b) => s2 + b.sbd + (locked.get(b.account)?.sbd ?? 0), 0)
    const steemVal = totalSteem * (m.mid ?? 0)
    const basePct = steemVal + totalSbd > 0 ? (steemVal / (steemVal + totalSbd)) * 100 : 50
    let skipSide: 'buy' | 'sell' | null = null
    if (basePct > CONFIG.maxSideSkewPct) skipSide = 'buy' // כבד-ב-STEEM — אין-קניות-נוספות עד-איזון
    else if (100 - basePct > CONFIG.maxSideSkewPct) skipSide = 'sell' // כבד-ב-SBD — אין-מכירות-נוספות
    // Task-117 fail-closed: אין-עוגן-ערך-חוץ → איסור-מכירות מוחלט. הרצפה-לא-קורסת-ל-bestAsk —
    // מדידה-חיה 01:04Z: קריסת-עוגן גרמה למכירות-חיות-מתחת-לפאריטי (0.1029 < 0.1101). לעולם-שוב-לא.
    if (floor === null) skipSide = 'sell'
    if (skipSide) {
      decisions.push(`מנהל-חשיפה: STEEM=${basePct.toFixed(1)}% מהמלאי (נזיל+נעול, סף-${CONFIG.maxSideSkewPct}%) → פקודות-${skipSide === 'buy' ? 'קנייה' : 'מכירה'}-מושהות-עד-איזון (AutoHedge-rebalance)`)
      event('decision', { account: '*', side: skipSide, level: 0, price: m.mid!, amountSteem: 0, amountSbd: 0, mode: live, detail: `exposure-governor: basePct=${basePct.toFixed(1)}% skip=${skipSide}` })
      // Task-115: איזון-פעיל — לא-רק-חסימה-סבילה; הצד-המאזן מתקרב-למרכז
      decisions.push(`טיית-איזון (Task-115): הצד-המאזן (${skipSide === 'buy' ? 'מכירות' : 'קניות'}) מתקרב-למרכז ×${REBALANCE_TILT} — המרה-פעילה-עד-איזון; רצפת-קו-הזהות-נשמרת`)
    }

    // 4.6) הגירת-צל→חי (Task-113): פקודות-צל-פתוחות-על-ידיים-עם-מפתח — משודרות-או-נסגרות.
    // סוף-עידן-הצל-המטעה: שורות-צל-לא-מחזיקות-עוד-בני-דודות-אמיתיות-כבנות-עוגן.
    if (live === 'live') {
      const shadowOpen = db
        .query("SELECT orderid, account, side, level, price, amount_steem, amount_sbd FROM grid_orders WHERE status='open' AND mode='shadow'")
        .all() as Array<{ orderid: string; account: string; side: string; level: number; price: number; amount_steem: number; amount_sbd: number }>
      for (const o of shadowOpen) {
        const acct = accounts.find((a) => a.name === o.account)
        if (!acct?.wif) continue // אין-מפתח → צל-כנה-נשאר
        const band = stepPct / 100 / 2
        const chainForAcct = chainOrders.get(o.account) ?? []
        const twinOnChain = chainForAcct.some((c) => c.side === o.side && Math.abs(c.price - o.price) <= o.price * band)
        if (twinOnChain) {
          db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
          event('cancel', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'shadow', detail: 'הגירה: תאום-חי-קיים-בשרשרת — שורת-הצל-נסגרת' })
          canceled++
          continue
        }
        if (o.side === 'sell' && floor !== null && o.price < floor) {
          db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
          event('cancel', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'shadow', detail: `הגירה: מחיר-צל-מתחת-לרצפת (${floor.toFixed(4)}) — לא-משודר` })
          canceled++
          continue
        }
        if (o.side === 'buy' && skipSide === 'buy') {
          db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
          event('cancel', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'shadow', detail: 'הגירה: קנייה-חסומה-במנהל-החשיפה — לא-משודרת' })
          canceled++
          continue
        }
        const r = await broadcastLimitOrder(acct, { account: o.account, side: o.side as 'buy' | 'sell', level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd })
        if (r.ok) {
          db.query("UPDATE grid_orders SET orderid=?, mode='live' WHERE orderid=?").run(`live:${r.orderid}:${o.account}`, o.orderid)
          event('place', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'live', detail: `הגירת-צל→חי; orderid=${r.orderid}` })
          placed++
          decisions.push(`הגירה: ${o.side} @${o.price.toFixed(4)} שודר-אמיתית (${o.account})`)
        } else {
          db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
          event('error', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'live', detail: `הגירה: שידור-נכשל → שורת-הצל-נסגרת: ${r.error}` })
          canceled++
        }
      }
    }

    // 4.7) יישור-אמת-מול-השרשרת (Task-113): אימוץ · גילוי-מילויים · סגירת-יתומים · נגדים
    const counterPlans: Plan[] = []
    if (live === 'live') {
      for (const n of names) {
        const acct = accounts.find((a) => a.name === n)
        if (!acct?.wif) continue
        const chain = chainOrders.get(n) ?? []
        const chainIds = new Set(chain.map((c) => c.orderid))

        // Task-114 — מנגנון-נגד-רוחות-רפאים (נמדד-בדם 22:50Z): קריאת-שרשרת-ריקה אינה
        // ראיה-ש"הפקודות-נעלמו". כשהקורא-מחזיר-אפס-פקודות-בעוד-יש-לנו-שורות-חיות-במעקב,
        // סגירת-יתומים ("נעלם-מהשרשרת") מוקפאת למחזור-זה — צפייה-בלבד. בלי-זה: הפנקס
        // סוגר-פקודות-חיות-כביכול-נעלמו → מציב-מחדש → כפילויות-מצטברות-על-הספר
        // (נמדד: 18→38-פקודות-תוך-דקות). fail-closed על-קריאה, לא-על-אמת.
        const trackedLive = db
          .query("SELECT COUNT(1) AS n FROM grid_orders WHERE status='open' AND mode='live' AND account=?")
          .get(n) as { n: number }
        if (chain.length === 0 && trackedLive.n > 0) {
          decisions.push(`מנגנון-נגד-רוחות-רפאים: קריאת-השרשרת-ריקה-אך-יש ${trackedLive.n} פקודות-חיות-במעקב — סגירת-יתומים-מוקפאת (צפייה)`)
          continue
        }

        // אימוץ: פקודות-חיות-שלנו-שלא-במעקב (כולל-של-הרץ-היומי) → מעקב-מלא.
        // Task-113 הפרדת-סמכויות (נמדד-בדם): פקודות-שלא-הוצבו-על-ידי-המנוע-הזה
        // מסומנות level=-9 — מעקב-מילויים/ביטולים-בלבד, אף-קיזוז, אף-ביטול.
        // Task-114 (נמדד-בדם): השרשרת-היא-האמת — שורה-מסומנת-כ-'canceled'-בפנקס-אך-חיה-
        // בשרשרת (רוח-רפאים-מהעבר) נפתחת-מחדש; אסור-שפקודה-חיה-בשרשרת-תהיה-בלתי-נראית-
        // לגילוי-מילויים (היתומים-החיים-הם-הדלקה-לכפילויות-ולאובדן-מילויים).
        for (const c of chain) {
          const id = `live:${c.orderid}:${n}`
          const known = db.query('SELECT status FROM grid_orders WHERE orderid=?').get(id) as { status?: string } | undefined
          if (!known) {
            db.query('INSERT INTO grid_orders(orderid,account,side,level,price,amount_steem,amount_sbd,placed_at,status,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
              id, n, c.side, -9, c.price, c.amountSteem, c.amountSbd, c.created, 'open', 'live',
            )
            event('adopt', { account: n, side: c.side, level: -9, price: c.price, amountSteem: c.amountSteem, amountSbd: c.amountSbd, mode: 'live', detail: `אומץ-למעקב-בלבד (לא-לניהול); orderid=${c.orderid}` })
          } else if (known.status === 'canceled') {
            db.query("UPDATE grid_orders SET status='open' WHERE orderid=?").run(id)
            event('adopt', { account: n, side: c.side, level: -9, price: c.price, amountSteem: c.amountSteem, amountSbd: c.amountSbd, mode: 'live', detail: `השרשרת-מנצחת-את-הפנקס: שורה-שסומנה-כמבוטלת-חיה-בשרשרת — נפתחה-מחדש; orderid=${c.orderid}` })
          }
        }

        // מילויים-אמיתיים: היסטוריית-החשבון → סגירת-נעלמים-כמילויים-ופקודות-נגד
        const fillsRes = await market.getAccountFills(n, 300)
        if (fillsRes.ok) {
          const fillByOrder = new Map<number, market.ChainFill>()
          for (const f of fillsRes.data) if (!fillByOrder.has(f.orderid)) fillByOrder.set(f.orderid, f)
          const tracked = db
            .query("SELECT orderid, account, side, level, price, amount_steem, amount_sbd FROM grid_orders WHERE status='open' AND mode='live' AND account=?")
            .all(n) as Array<{ orderid: string; account: string; side: string; level: number; price: number; amount_steem: number; amount_sbd: number }>
          for (const row of tracked) {
            const chainId = Number(row.orderid.split(':')[1])
            if (chainIds.has(chainId)) continue // עדיין-חיה
            const f = fillByOrder.get(chainId)
            if (f) {
              db.query("UPDATE grid_orders SET status='filled', filled_at=? WHERE orderid=?").run(f.at, row.orderid)
              const edgeBps = identityLine ? Math.round(((f.price - identityLine) / identityLine) * 10_000) : null
              event('fill', { account: n, side: f.side, level: row.level, price: f.price, amountSteem: f.steem, amountSbd: f.sbd, mode: 'live', detail: `מילוי-אמיתי-מהשרשרת; edge-מול-קו-זהות=${edgeBps ?? 'נ/ל'}bps; נגד=${f.counterparty ?? '?'}` })
              filledLive++
              decisions.push(`מילוי-חי: ${f.side} ${f.steem.toFixed(1)}-STEEM @${f.price.toFixed(4)} (edge=${edgeBps ?? 'נ/ל'}bps)`)
              // פקודה-נגדית (רשת-קלאסית — בחיים): מכירה-מומשה → קנייה-מתחת; קנייה-מומשה → מכירה-מעל
              const back = 2 * stepPct
              if (f.side === 'sell') {
                const bp = f.price * (1 - back / 100)
                const budget = Math.min(f.sbd, (bals.data.find((b) => b.account === n)?.sbd ?? 0) * (1 - CONFIG.reservePct / 100))
                const qty = budget / bp
                if (budget >= MIN_ORDER_SBD && qty >= MIN_ORDER_STEEM && skipSide !== 'buy') {
                  counterPlans.push({ account: n, side: 'buy', level: -1, price: bp, amountSteem: qty, amountSbd: budget, origin: 'counter' })
                }
              } else {
                let sp = f.price * (1 + back / 100)
                if (floor !== null) sp = Math.max(sp, floor)
                const bal = bals.data.find((b) => b.account === n)
                const avail = (bal?.steem ?? 0) * (1 - CONFIG.reservePct / 100)
                const qty = Math.min(f.steem, avail)
                if (qty >= MIN_ORDER_STEEM && skipSide !== 'sell') {
                  counterPlans.push({ account: n, side: 'sell', level: -1, price: sp, amountSteem: qty, amountSbd: qty * sp, origin: 'counter' })
                }
              }
            } else {
              db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(row.orderid)
              event('cancel', { account: n, side: row.side, level: row.level, price: row.price, amountSteem: row.amount_steem, amountSbd: row.amount_sbd, mode: 'live', detail: 'נעלם-מהשרשרת-בלי-מילוי — בוטל/פג-תוקף' })
              canceled++
            }
          }
          // כנות: מילויים-היסטוריים-של-פקודות-שלא-היו-במעקב — נרשמים, בלי-נגדים.
          // Task-116: פנקס-fill_ledger — מילוי-אחד-בהיסטוריה = רשומה-אחת-לנצח.
          // מדידה-חיה: בלי-הפנקס, מילוי-אחד-נרשם-192-פעמים וזיהם-מדדים-ומועצה.
          const recent = fillsRes.data.filter((f) => Date.now() - new Date(f.at + 'Z').getTime() < 24 * 3600_000)
          for (const f of recent) {
            const everTracked = db.query('SELECT 1 FROM grid_orders WHERE orderid=?').get(`live:${f.orderid}:${n}`)
            if (everTracked || chainIds.has(f.orderid)) continue
            const lk = `${n}:${f.orderid}:${f.at}:${f.side}:${f.steem.toFixed(6)}:${f.sbd.toFixed(6)}`
            const seen = db.query('SELECT 1 FROM fill_ledger WHERE k=?').get(lk)
            if (seen) continue
            db.query('INSERT INTO fill_ledger(k,account,orderid,at,side,price,amount_steem,amount_sbd,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
              lk, n, f.orderid, f.at, f.side, f.price, f.steem, f.sbd, new Date().toISOString(),
            )
            event('fill', { account: n, side: f.side, level: 0, price: f.price, amountSteem: f.steem, amountSbd: f.sbd, mode: 'live', detail: `מילוי-אמיתי-שלא-היה-במעקב (נרשם-מההיסטוריה, בלי-נגד; פנקס-Task-116); orderid=${f.orderid}; שרשרת=${f.at}` })
          }
        } else {
          decisions.push(`היסטוריית-מילויים-לא-נקראה (${n}): ${fillsRes.error} — סגירת-נעלמים-נדחית`)
        }
      }
      stats.lastReconcileAt = new Date().toISOString()
      stats.lastFillsLive = filledLive
    }

    // 5) הקצאת-פסים-ללא-דריסות: רמה-L שייכת-לחשבון L%n (מוח-אחד, ידיים-מחולקות)
    // Task-113: dup-בחיפוש-פס-מחיר מול-השרשרת-ומול-db-באותו-מצב; תקרת-מחויבות-לצד-מכירה.
    const n = accounts.length
    const step = m.mid * (stepPct / 100)
    const band = step / 2
    const plans: Plan[] = []
    const plannedSellByAcct = new Map<string, number>()
    for (let L = 0; L < CONFIG.levels; L++) {
      const acct = accounts[L % n].name
      // Task-115: טיית-איזון — הצד-המאזן מתקרב-למרכז כשהחשיפה-קיצונית
      const tiltSell = basePct > CONFIG.maxSideSkewPct
      const tiltBuy = 100 - basePct > CONFIG.maxSideSkewPct
      const buyPrice = m.mid - step * (L + 1) * (tiltBuy ? REBALANCE_TILT : 1)
      const sellPrice = m.mid + step * (L + 1) * (tiltSell ? REBALANCE_TILT : 1)
      const bal = bals.data.find((b) => b.account === acct)
      if (!bal?.found) {
        decisions.push(`${acct}: חשבון-לא-נמצא-בשרשרת — מדולג`)
        continue
      }
      const chainForAcct = chainOrders.get(acct) ?? []
      const hasNear = (side: string, price: number) =>
        chainForAcct.some((c) => c.side === side && Math.abs(c.price - price) <= price * (band / m.mid)) ||
        !!db
          .query("SELECT 1 FROM grid_orders WHERE account=? AND side=? AND status='open' AND mode=? AND ABS(price-?)<=?*?")
          .get(acct, side, live, price, price, band / m.mid)

      // מנהל-החשיפה: הצד-הכבד-נחסם (Task-107)
      if (skipSide === 'buy') {
        decisions.push(`${acct}: קנייה-דחויה-בידי-מנהל-החשיפה`)
      } else {
        // קנייה: עדכני-לגבי-יתרת-SBD-זמינה (כולל-הפקודות-הפתוחות-של-הרמה-הזאת)
        const sbdAvail = bal.sbd * (1 - CONFIG.reservePct / 100)
        const buySbd = Math.min(CONFIG.orderSizeSbd, sbdAvail)
        if (buySbd >= Math.max(0.5, MIN_ORDER_SBD) && !hasNear('buy', buyPrice)) {
          plans.push({ account: acct, side: 'buy', level: L, price: buyPrice, amountSteem: buySbd / buyPrice, amountSbd: buySbd })
        } else if (buySbd < Math.max(0.5, MIN_ORDER_SBD)) {
          decisions.push(`${acct}: SBD-מתחת-לגודל-המינימלי (${bal.sbd.toFixed(2)} SBD, חירום ${CONFIG.reservePct}%)`)
        }
      }
      if (skipSide === 'sell') {
        decisions.push(`${acct}: מכירה-דחויה-בידי-מנהל-החשיפה`)
      } else {
        // Task-113: תקרת-מחויבות — נעול-במכירות-+מתוכנן ≤ 90% מהנזיל-+הנעול
        const lk = locked.get(acct) ?? { steem: 0, sbd: 0, sells: 0, buysSbd: 0 }
        const commitCap = Math.max(0, (bal.steem + lk.steem) * COMMIT_PCT - lk.steem - (plannedSellByAcct.get(acct) ?? 0))
        const sellFloor = floor ?? m.bestAsk ?? m.mid!
        let sellPrice2 = Math.max(sellPrice, sellFloor) // מדיניות: לעולם-לא-מתחת-לרצפה
        // Task-118: סולם-פאריטי — יעד-מתחת-לרצפה לא-נערם-על-ידיה אלא-נפרש-מעל-יה
        if (sellPrice < sellFloor && L > 0) sellPrice2 = sellFloor * (1 + (L * PARITY_LADDER_STEP) / 100)
        const steemAvail = Math.min(bal.steem * (1 - CONFIG.reservePct / 100), commitCap)
        // Task-116: הגברת-כמות-בצד-המאזן (טיית-פעילה) — יותר-עומק-בערך-חוץ
        const boost = tiltSell ? TILT_QTY_BOOST : 1
        const sellSteem = Math.min(CONFIG.orderSizeSteem * boost, steemAvail)
        if (sellSteem >= MIN_ORDER_STEEM && !hasNear('sell', sellPrice2)) {
          plans.push({ account: acct, side: 'sell', level: L, price: sellPrice2, amountSteem: sellSteem, amountSbd: sellSteem * sellPrice2 })
          plannedSellByAcct.set(acct, (plannedSellByAcct.get(acct) ?? 0) + sellSteem)
        } else if (sellSteem < MIN_ORDER_STEEM) {
          decisions.push(`${acct}: STEEM-מתחת-לגודל-המינימלי/תקרת-המחויבות (נזיל ${bal.steem.toFixed(3)}, נעול ${lk.steem.toFixed(1)}, חירום ${CONFIG.reservePct}%)`)
        }
      }
    }
    // נגדים-ממילויים-חיים — עם-אותו-פס-אנטי-כפילות
    for (const cp of counterPlans) {
      if (hasNear(cp.side, cp.price)) continue
      plans.push(cp)
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

    // 7) קיזוז-סטיות — עתה גם בחיים (Task-113; מוגבל-אנטי-צ'רנר):
    // פקודות-שהמחיר-התרחק-מהן-מעל-הסף → ביטול-אמיתי + הצבה-מחדש-במדרגה-הנוכחית.
    {
      const drift = m.mid * (CONFIG.requoteDriftPct / 100)
      let requoted = 0
      const staleRows = db
        .query("SELECT orderid, account, side, level, price, amount_steem, amount_sbd, mode FROM grid_orders WHERE status='open'")
        .all() as Array<{ orderid: string; account: string; side: string; level: number; price: number; amount_steem: number; amount_sbd: number; mode: string }>
      for (const o of staleRows) {
        // Task-117 טיהור-רצפה: מכירה-פתוחה-מתחת-לרצפה = הפרת-דוקטרינה חיה — מורמת-לרצפה
        // גם-בלי-סטיית-מחיר (מדידה-חיה: מכירות-0.1029-שנשתלו-בחלון-קריסת-העוגן לא-היו
        // מקוזזות-לעולם כי הסטייה-מהמרכז היתה 1.1% < סף-1.5%).
        const belowFloorPurge = o.side === 'sell' && floor !== null && o.price < floor
        if (!belowFloorPurge && Math.abs(o.price - m.mid!) <= drift) continue
        if (o.mode === 'shadow') {
          db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
          event('cancel', { account: o.account, side: o.side, level: 0, price: o.price, amountSteem: 0, amountSbd: 0, mode: 'shadow', detail: 'סטייה-מעל-סף-הקיזוז' })
          canceled++
          continue
        }
        // חיים: רק-ידיים-עם-מפתח, תקרה-אנטי-צ'רנר, והצד-מותר-במנהל-החשיפה.
        // Task-113: פקודות-מאומצות (level=-9) — מעקב-בלבד, לעולם-לא-מקוזזות/מבוטלות-על-ידינו.
        if (requoted >= MAX_REQUOTE_PER_CYCLE) continue
        if (o.level === -9) continue
        const acct = accounts.find((a) => a.name === o.account)
        if (!acct?.wif) continue
        // Task-117: טיהור-רצפה עוקף את מנהל-החשיפה — הרמת-מכירה-אל-הרצפה היא הכיוון-המרפא
        // (היעד = רצפה ≥ ערך-החוץ), ואסור-שה-fail-closed יקפיא אותה.
        if ((o.side === 'buy' && skipSide === 'buy') || (o.side === 'sell' && skipSide === 'sell' && !belowFloorPurge)) continue
        // יעד-מדרגה (עם-רצפה-למכירה — קו-זהות, ואם-אין-מדידה: bestAsk הקיים)
        // Task-115: יעד-הקיזוז מקבל-את-אותה-טיית-איזון — פקודות-רחוקות-נמשכות-למרכז-בעת-חוסר-איזון
        const levelForTarget = o.level >= 0 ? o.level : 0
        const rebalSell = basePct > CONFIG.maxSideSkewPct
        const rebalBuy = 100 - basePct > CONFIG.maxSideSkewPct
        let target = o.side === 'sell'
          ? m.mid! + step * (levelForTarget + 1) * (rebalSell ? REBALANCE_TILT : 1)
          : m.mid! - step * (levelForTarget + 1) * (rebalBuy ? REBALANCE_TILT : 1)
        if (o.side === 'sell') {
          const fl = floor ?? m.bestAsk ?? m.mid!
          // Task-118: סולם-פאריטי-גם-בקיזוז — רונגה-L-שנשאבה-לרצפה נפרשת-מעל-יה
          target = target < fl && levelForTarget > 0
            ? fl * (1 + (levelForTarget * PARITY_LADDER_STEP) / 100)
            : Math.max(target, fl)
        }
        if (Math.abs(target - o.price) <= o.price * 0.0005) continue // כבר-ביעד
        const chainId = Number(o.orderid.split(':')[1])
        const twin = (chainOrders.get(o.account) ?? []).some((c) => c.side === o.side && Math.abs(c.price - target) <= target * (band / m.mid))
        const c = await broadcastCancel(acct, chainId)
        if (!c.ok) {
          event('error', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: 0, amountSbd: 0, mode: 'live', detail: `קיזוז: ביטול-נכשל: ${c.error}` })
          continue
        }
        db.query("UPDATE grid_orders SET status='canceled' WHERE orderid=?").run(o.orderid)
        canceled++
        if (twin) {
          // Task-113 זרימה-חכמה: היעד-תפוס-כבר-בשרשרת → ביטול-בלבד (המדרגה-תציב-מחדש-בעצמה)
          event('cancel', { account: o.account, side: o.side, level: o.level, price: o.price, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'live', detail: `קיזוז: היעד-${target.toFixed(4)}-תפוס — פקודה-רחוקה-בוטלה-בלבד` })
          continue
        }
        const r = await broadcastLimitOrder(acct, { account: o.account, side: o.side as 'buy' | 'sell', level: o.level, price: target, amountSteem: o.amount_steem, amountSbd: o.amount_sbd })
        if (r.ok) {
          db.query('INSERT INTO grid_orders(orderid,account,side,level,price,amount_steem,amount_sbd,placed_at,status,mode) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            `live:${r.orderid}:${o.account}`, o.account, o.side, o.level, target, o.amount_steem, o.amount_sbd, new Date().toISOString(), 'open', 'live',
          )
          event('place', { account: o.account, side: o.side, level: o.level, price: target, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'live', detail: `קיזוז-חי: ${o.price.toFixed(4)}→${target.toFixed(4)}; orderid=${r.orderid}` })
          placed++
          requoted++
        } else {
          event('error', { account: o.account, side: o.side, level: o.level, price: target, amountSteem: o.amount_steem, amountSbd: o.amount_sbd, mode: 'live', detail: `קיזוז: הצבה-מחדש-נכשלה: ${r.error}` })
        }
      }
      if (requoted) decisions.push(`קיזוזי-חיים: ${requoted} פקודות-הותאמו-למדרגה`)
    }

    // 8) ביצוע-התוכניות
    for (const p of plans) {
      const acct = accounts.find((a) => a.name === p.account)!
      const dup = db
        .query("SELECT 1 FROM grid_orders WHERE account=? AND side=? AND level=? AND status='open' AND mode=?")
        .get(p.account, p.side, p.level, live)
      if (dup) continue
      // אנטי-כפילות-מול-השרשרת (כל-מקור): פס-מחיר
      const chainTwin = (chainOrders.get(p.account) ?? []).some((c) => c.side === p.side && Math.abs(c.price - p.price) <= p.price * (band / m.mid))
      if (live === 'live' && chainTwin) continue
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
          event('place', { ...p, mode: 'live', detail: `שידור-אמיתי (${p.origin ?? 'ladder'}); orderid=${r.orderid}` })
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
    return { placed, canceled, filledShadow, filledLive, decisions }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    stats.lastError = msg
    stats.consecutiveErrors++
    stats.lastCycleAt = new Date().toISOString()
    stats.lastCycleMs = Date.now() - t0
    event('error', { account: '*', side: '-', level: 0, price: 0, amountSteem: 0, amountSbd: 0, mode: mode(), detail: msg })
    if (stats.consecutiveErrors >= 5) halt(`5-כשלים-רצופים: ${msg}`, true)
    return { placed: 0, canceled: 0, filledShadow: 0, filledLive: 0, decisions: [`שגיאה: ${msg}`] }
  }
}

// ── סיכום-לתצוגה ─────────────────────────────────────────────────────────────
export function summary() {
  const open = db.query("SELECT account, side, mode, COUNT(*) n, SUM(amount_sbd) sbd, SUM(amount_steem) steem FROM grid_orders WHERE status='open' GROUP BY account, side, mode").all() as Array<{ account: string; side: string; mode: string; n: number; sbd: number; steem: number }>
  const fills = db.query("SELECT account, side, mode, COUNT(*) n, SUM(amount_sbd) sbd FROM grid_orders WHERE status='filled' GROUP BY account, side, mode").all() as Array<{ account: string; side: string; mode: string; n: number; sbd: number }>
  const recent = db.query('SELECT * FROM grid_events ORDER BY id DESC LIMIT 30').all() as Array<Record<string, unknown>>
  const lastLiveFills = db.query("SELECT at, account, side, price, amount_steem, amount_sbd, detail FROM grid_events WHERE kind='fill' AND mode='live' ORDER BY id DESC LIMIT 10").all() as Array<Record<string, unknown>>
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
    identityLine: stats.identityLine,
    sellFloor: stats.floor,
    lastReconcileAt: stats.lastReconcileAt,
    lastLiveFills,
    shadowPnlSbd: Math.round(pnlSbd * 1000) / 1000,
    shadowPnlLabeled: 'simulated', // כנות-מלאה: מימושי-צל = סימולציה
    recent,
  }
}
