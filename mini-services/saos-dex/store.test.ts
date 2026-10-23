// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/store.test — שכבת-ה-sqlite על :memory: (Task-132, TDD-קנון)
// ═════════════════════════════════════════════════════════════════════════════
// ה-blind-spot-ההיסטורי: שכבת-ה-SQL הייתה-לכודה בתוך index.ts (שמגיש-מיד על-פורט
// ופותח-את-db-החי) — אף-בדיקה לא יכלה-לגעת-בה, וה-INSERT-השבור ("open" ללא-מרכאות
// → "no such column") שרד מאז-Task-131 בלי-שאף-עין. עתה: כל-השכבה על :memory:,
// כולל בדיקת-הרגרסיה של אותו-INSERT ומחזור-חיים מלא דרך createSqliteStore + ליבת-המנוע.
// הרצה: bun test mini-services/saos-dex/
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { finalizeTaker, matchOrderCore } from './engine'
import { bookRows, createSqliteStore, ensureSchema, placeOrderRow, seedWallets, walletRow } from './store'

const SEEDS: Record<string, Record<string, number>> = {
  maker: { WSTEEM: 1_000, USDS: 0 },
  taker: { WSTEEM: 0, USDS: 5_000_000 },
}

function freshDb(): Database {
  const db = new Database(':memory:')
  ensureSchema(db)
  expect(seedWallets(db, SEEDS)).toBe(2)
  return db
}

describe('saos-dex store — sql layer on :memory:', () => {
  test('רגרסיה-Task-131: placeOrderRow כותב-שורה עם status=open (היה: "no such column: open")', () => {
    const db = freshDb()
    const id = placeOrderRow(db, { base: 'WSTEEM', quote: 'USDS', side: 'sell', priceMu: 120_000, amountMu: 100, issuer: 'maker', postOnly: false, ioc: false })
    const row = db.query('SELECT * FROM orders WHERE id=?').get(id) as { status: string; issuer: string; priceMu: number }
    expect(row.status).toBe('open') // ← הבאג-ההיסטורי: ה-INSERT כלל נכשל כאן
    expect(row.issuer).toBe('maker')
    expect(row.priceMu).toBe(120_000)
  })

  test('schema+seeds: ארנקות-זרע נקראות-חוזר כ-WalletRec עם אפס-נעילות', () => {
    const db = freshDb()
    const m = walletRow(db, 'maker')
    expect(m).not.toBeNull()
    expect(m!.balances['WSTEEM']).toBe(1_000)
    expect(m!.locked).toEqual({})
  })

  test('מחזור-חיים מלא: ספר→פקודה→התאמה→גמר-IOC — דרך החנות-האמיתית + הליבה', () => {
    const db = freshDb()
    const store = createSqliteStore(db)
    // מייקר: maker מוכר 100 @100
    const mkId = placeOrderRow(db, { base: 'WSTEEM', quote: 'USDS', side: 'sell', priceMu: 100, amountMu: 100, issuer: 'maker', postOnly: false, ioc: false })
    const mk = walletRow(db, 'maker')!
    mk.locked['WSTEEM'] = (mk.locked['WSTEEM'] ?? 0) + 100
    // שמירת-הנעילה דרך-החנות (הדרך-האמיתית — saveWallet של-החנות)
    store.saveWallet(mk)
    // טאקר IOC: taker קונה 150 @120 → מילוי-100 במחיר-המייקר, שארית-50 מתה
    const tkId = placeOrderRow(db, { base: 'WSTEEM', quote: 'USDS', side: 'buy', priceMu: 120, amountMu: 150, issuer: 'taker', postOnly: false, ioc: true })
    const tk = walletRow(db, 'taker')!
    tk.locked['USDS'] = (tk.locked['USDS'] ?? 0) + 150 * 120
    store.saveWallet(tk)
    const takerRow = db.query('SELECT * FROM orders WHERE id=?').get(tkId) as Parameters<typeof matchOrderCore>[0]
    const filled = matchOrderCore(takerRow, store)
    expect(filled).toBe(100)
    const fin = finalizeTaker(takerRow, filled, store)
    expect(fin.status).toBe('canceled')
    db.query('UPDATE orders SET filledMu=?, status=? WHERE id=?').run(fin.filledMu, fin.status, tkId)
    // הכסף-האמיתי על-גבי-ה-sqlite:
    const mAfter = walletRow(db, 'maker')!
    const tAfter = walletRow(db, 'taker')!
    expect(tAfter.locked['USDS']).toBe(0) // נעילת-IOC השתחררה-מלואה (remainder×priceMu)
    expect(tAfter.balances['USDS']).toBe(5_000_000 - 100 * 100) // שילם-מחיר-מייקר
    expect(tAfter.balances['WSTEEM']).toBe(100)
    expect(mAfter.locked['WSTEEM']).toBe(0)
    expect(mAfter.balances['USDS']).toBe(100 * 100)
    const book = bookRows(db, 'WSTEEM', 'USDS')
    expect(book.asks).toHaveLength(0) // המייקר-התמלא ונסגר
    expect(book.bids).toHaveLength(0)
    const fillCount = (db.query('SELECT COUNT(*) c FROM fills').get() as { c: number }).c
    expect(fillCount).toBe(1)
  })

  test('seedWallets אינו-זורע-כפול (אידמפוטנטיות)', () => {
    const db = freshDb()
    expect(seedWallets(db, SEEDS)).toBe(0)
    const c = (db.query('SELECT COUNT(*) c FROM wallets').get() as { c: number }).c
    expect(c).toBe(2)
  })
})
