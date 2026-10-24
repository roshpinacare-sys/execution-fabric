// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/store — שכבת-האחסון (Task-132): DDL + כל-נגישי-ה-sqlite
// ═════════════════════════════════════════════════════════════════════════════
// ניתנת-לייבוא בטוח: בלי Bun.serve, בלי-פורט, בלי-קבצי-ה-state של-האיבר-החי
// (ה-db מוזרק — :memory: בבדיקות, state/dex.db בייצור). הסיבה-הקיומית: ה-blind-spot
// שהשאיר את ה-INSERT-השבור ("open" ללא-מרכאות → "no such column") חי מאז-Task-131
// בלי-שאף-בדיקה יראה-אותו, כי-שכבת-ה-SQL הייתה-לכודה-בתוך index.ts שמגיש-מיד.
// store.test.ts מכסה-עתה את-כל-השכבה הזאת על :memory:, כולל בדיקת-הרגרסיה של-ה-INSERT.
import { Database } from 'bun:sqlite'
import type { Balances, DexStore, Order, WalletRec } from './engine'
import type { Pool } from './amm'

export const DDL = `
CREATE TABLE IF NOT EXISTS wallets(
  name TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0,
  balances TEXT NOT NULL DEFAULT '{}', locked TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, base TEXT NOT NULL, quote TEXT NOT NULL,
  side TEXT NOT NULL, priceMu INTEGER NOT NULL, amountMu INTEGER NOT NULL,
  filledMu INTEGER NOT NULL DEFAULT 0, issuer TEXT NOT NULL,
  postOnly INTEGER NOT NULL DEFAULT 0, ioc INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open', createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fills(
  id INTEGER PRIMARY KEY AUTOINCREMENT, base TEXT NOT NULL, quote TEXT NOT NULL,
  side TEXT NOT NULL, priceMu INTEGER NOT NULL, amountMu INTEGER NOT NULL,
  buyer TEXT NOT NULL, seller TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pools(
  id INTEGER PRIMARY KEY AUTOINCREMENT, base TEXT NOT NULL, quote TEXT NOT NULL,
  reserveBaseMu INTEGER NOT NULL, reserveQuoteMu INTEGER NOT NULL,
  feeBps INTEGER NOT NULL, lpSharesMu INTEGER NOT NULL, walletName TEXT NOT NULL,
  createdAt TEXT NOT NULL, UNIQUE(base, quote));
CREATE TABLE IF NOT EXISTS lp_positions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, poolId INTEGER NOT NULL, holder TEXT NOT NULL,
  sharesMu INTEGER NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(poolId, holder));
`

export function ensureSchema(db: Database): void {
  db.run('PRAGMA journal_mode = WAL;')
  db.run(DDL)
}

export function getMeta(db: Database, k: string): string | null {
  return (db.query('SELECT value FROM meta WHERE key=?').get(k) as { value: string } | null)?.value ?? null
}
export function setMeta(db: Database, k: string, v: string): void {
  db.query('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)
}

export function seedWallets(db: Database, seeds: Record<string, Record<string, number>>): number {
  const count = (db.query('SELECT COUNT(*) c FROM wallets').get() as { c: number }).c
  if (count > 0) return 0
  const ins = db.query('INSERT INTO wallets(name,credits,balances,locked) VALUES(?,0,?,?)')
  for (const [name, bal] of Object.entries(seeds)) ins.run(name, JSON.stringify(bal), '{}')
  return Object.keys(seeds).length
}

export function walletRow(db: Database, name: string): WalletRec | null {
  const r = db.query('SELECT * FROM wallets WHERE name=?').get(name) as { name: string; credits: number; balances: string; locked: string } | null
  if (!r) return null
  return { name: r.name, credits: r.credits, balances: JSON.parse(r.balances) as Balances, locked: JSON.parse(r.locked) as Balances }
}

export function saveWalletRow(db: Database, w: WalletRec): void {
  db.query('UPDATE wallets SET credits=?, balances=?, locked=? WHERE name=?').run(w.credits, JSON.stringify(w.balances), JSON.stringify(w.locked), w.name)
}

// ארנק-חדש-בטוח: INSERT OR IGNORE — שמירת-ארנק-שלא-נוצר-מעולם הייתה-שקטה-ומאודת
// (הבדיקה-של-Task-134 תפסה: ארנק-בריכת-AMM חדש לא-היה-נוצר וכל-ההחלפה הייתה אובדת)
export function ensureWalletRow(db: Database, name: string): boolean {
  const info = db.query('INSERT OR IGNORE INTO wallets(name,credits,balances,locked) VALUES(?,0,?,?)').run(name, '{}', '{}')
  return Number(info.changes) > 0
}

export function bookRows(db: Database, base: string, quote: string): { bids: Order[]; asks: Order[] } {
  const open = db.query("SELECT * FROM orders WHERE base=? AND quote=? AND status='open' ORDER BY priceMu ASC, id ASC").all(base, quote) as Order[]
  const asks = open.filter((o) => o.side === 'sell')
  const bids = open.filter((o) => o.side === 'buy').reverse() // קנייה-גבוהה-ראשונה
  return { bids, asks }
}

// ה-INSERT-של-פקודות — המקום-עצמו של באג-Task-131 ("open" ללא-מרכאות). הליטרל
// מצוטט; בדיקת-הרגרסיה ב-store.test.ts מוכיחה-שורה-נכתבת עם status='open'.
export function placeOrderRow(
  db: Database,
  o: { base: string; quote: string; side: string; priceMu: number; amountMu: number; issuer: string; postOnly: boolean; ioc: boolean },
): number {
  const info = db
    .query("INSERT INTO orders(base,quote,side,priceMu,amountMu,filledMu,issuer,postOnly,ioc,status,createdAt) VALUES(?,?,?,?,?,0,?,?,?,'open',?)")
    .run(o.base, o.quote, o.side, o.priceMu, o.amountMu, o.issuer, o.postOnly ? 1 : 0, o.ioc ? 1 : 0, new Date().toISOString())
  return Number(info.lastInsertRowid)
}

export function markFilledIfCompleteRow(db: Database, id: number): void {
  db.query("UPDATE orders SET status='filled' WHERE id=? AND filledMu>=amountMu").run(id)
}
export function setMakerProgressRow(db: Database, id: number, filledMu: number, complete: boolean): void {
  if (complete) db.query('UPDATE orders SET filledMu=?, status=? WHERE id=?').run(filledMu, 'filled', id)
  else db.query('UPDATE orders SET filledMu=? WHERE id=?').run(filledMu, id)
}
export function insertFillRow(
  db: Database,
  f: { base: string; quote: string; side: string; priceMu: number; amountMu: number; buyer: string; seller: string },
): void {
  db.query('INSERT INTO fills(base,quote,side,priceMu,amountMu,buyer,seller,createdAt) VALUES(?,?,?,?,?,?,?,?)')
    .run(f.base, f.quote, f.side, f.priceMu, f.amountMu, f.buyer, f.seller, new Date().toISOString())
}
export function myOrdersRows(db: Database, issuer: string): Order[] {
  return db.query('SELECT * FROM orders WHERE issuer=? ORDER BY id DESC LIMIT 200').all(issuer) as Order[]
}

// ── שכבת-ה-AMM (Task-134): שורות-בריכות-ומניות-LP ─────────────────────────────
export function insertPoolRow(db: Database, p: Pool & { walletName: string }): number {
  const info = db
    .query('INSERT INTO pools(base,quote,reserveBaseMu,reserveQuoteMu,feeBps,lpSharesMu,walletName,createdAt) VALUES(?,?,?,?,?,?,?,?)')
    .run(p.base, p.quote, p.reserveBaseMu, p.reserveQuoteMu, p.feeBps, p.lpSharesMu, p.walletName, new Date().toISOString())
  return Number(info.lastInsertRowid)
}
export function updatePoolRow(db: Database, p: Pool): void {
  if (p.id === undefined) throw new Error('updatePoolRow: pool.id חסר')
  db.query('UPDATE pools SET reserveBaseMu=?, reserveQuoteMu=?, lpSharesMu=? WHERE id=?').run(
    p.reserveBaseMu, p.reserveQuoteMu, p.lpSharesMu, p.id,
  )
}
export function poolRow(db: Database, id: number): Pool | null {
  const r = db.query('SELECT * FROM pools WHERE id=?').get(id) as
    | { id: number; base: string; quote: string; reserveBaseMu: number; reserveQuoteMu: number; feeBps: number; lpSharesMu: number; walletName: string }
    | null
  return r ? { ...r } : null
}
export function poolByPairRow(db: Database, base: string, quote: string): Pool | null {
  const r = db.query('SELECT * FROM pools WHERE base=? AND quote=?').get(base, quote) as
    | { id: number; base: string; quote: string; reserveBaseMu: number; reserveQuoteMu: number; feeBps: number; lpSharesMu: number; walletName: string }
    | null
  return r ? { ...r } : null
}
export function allPoolRows(db: Database): Pool[] {
  return db
    .query('SELECT * FROM pools ORDER BY id')
    .all() as Pool[]
}
export function upsertLpPositionRow(db: Database, poolId: number, holder: string, deltaSharesMu: number): void {
  db.query(
    `INSERT INTO lp_positions(poolId,holder,sharesMu,updatedAt) VALUES(?,?,?,?)
     ON CONFLICT(poolId,holder) DO UPDATE SET sharesMu=sharesMu+excluded.sharesMu, updatedAt=excluded.updatedAt`,
  ).run(poolId, holder, deltaSharesMu, new Date().toISOString())
}

// ה-DexStore המלא מעל מופע-db נתון — זהו-החיבור-בין-הליבה-הטהורה לבין-ה-sqlite.
export function createSqliteStore(db: Database): DexStore {
  return {
    listOpen: (base, quote) => bookRows(db, base, quote),
    getWallet: (name) => walletRow(db, name),
    saveWallet: (w) => saveWalletRow(db, w),
    markFilledIfComplete: (id) => markFilledIfCompleteRow(db, id),
    setMakerProgress: (id, filledMu, complete) => setMakerProgressRow(db, id, filledMu, complete),
    insertFill: (f) => insertFillRow(db, f),
    log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
  }
}
