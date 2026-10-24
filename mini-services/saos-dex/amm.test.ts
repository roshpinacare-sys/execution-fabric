// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/amm.test — סוויטה-דטרמיניסטית על מנוע-ה-AMM הפנימי (Task-134, §3/§7.1)
// ═════════════════════════════════════════════════════════════════════════════
// מנוע-החלפות-המיידיות של-הריבונות: constant-product, µ-שלמים-בלבד, עמלה-30bps
// שנשארת-בבריכה, רצפה-תמיד-לטובת-הבריכה, fail-closed על-כל-קלט-לא-תקין.
// אפס-רשת, אפס-RPC-חיצוני, אפס-גז — דטרמיניזם-מלא (§7.1).
// הרצה: bun test mini-services/saos-dex/amm.test.ts
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  MIN_LIQUIDITY,
  addLiquidityShares,
  applySwap,
  quoteSwap,
  seedPool,
  withdrawLiquidityShares,
  type Pool,
} from './amm'
import { ensureSchema, ensureWalletRow, poolRow, seedWallets, createSqliteStore, insertPoolRow, updatePoolRow } from './store'

const FEE = 30 // 30bps = 0.30% — הקבוע-החתום של-הריבונות

function mkPool(rb: number, rq: number, feeBps = FEE): Pool {
  return seedPool('WSTEEM', 'USDS', rb, rq, feeBps)
}

describe('AMM — seedPool (זריעת-בריכה)', () => {
  test('בריכה-חדשה: מניות-זרע = שורש-שלם-של-המכפלה, נעולות-מינימום-שריפה', () => {
    const p = mkPool(1_000_000, 100_000_000)
    expect(p.base).toBe('WSTEEM')
    expect(p.quote).toBe('USDS')
    expect(p.reserveBaseMu).toBe(1_000_000)
    expect(p.reserveQuoteMu).toBe(100_000_000)
    expect(p.feeBps).toBe(30)
    expect(p.lpSharesMu).toBeGreaterThanOrEqual(MIN_LIQUIDITY)
    // דטרמיניזם: אותה-זריעה = אותן-מניות
    expect(seedPool('WSTEEM', 'USDS', 1_000_000, 100_000_000, 30).lpSharesMu).toBe(p.lpSharesMu)
  })
  test('דחייה-כנה: עתודות-שאינן-חיוביות/שאינן-שלמים', () => {
    expect(() => mkPool(0, 100)).toThrow()
    expect(() => mkPool(100, -5)).toThrow()
    expect(() => mkPool(100.5, 100)).toThrow() // µ-שלמים-בלבד (I7-רוח)
  })
})

describe('AMM — quoteSwap (הצגת-מחיר-טהורה, מסילת-ה-arb)', () => {
  test('מחיר-החלפה: base→quote מכבד-מוצר-קבוע-עם-עמלה', () => {
    const p = mkPool(1_000_000, 100_000_000) // מחיר: 100 µ-quote ל-µ-base
    const q = quoteSwap(p, 'baseToQuote', 10_000)
    // inAfterFee = 10_000 × 9970/10000 = 9970
    // out = floor(100_000_000 × 9970 / (1_000_000 + 9970)) = floor(997_000_000_000/1_009_970) = 987_158
    expect(q.outMu).toBe(987_158)
    expect(q.feeMu).toBe(30) // 10_000×30/10000
  })
  test('כיוון-הפוך quote→base סימטרי-מתמטית', () => {
    const p = mkPool(1_000_000, 100_000_000)
    const q = quoteSwap(p, 'quoteToBase', 1_000_000)
    expect(q.outMu).toBeGreaterThan(0)
    expect(q.outMu).toBeLessThan(1_000_000) // אי-אפשר-לקנות-יותר-מהעתודה-במחיר-0
    expect(q.feeMu).toBe(3_000) // 1_000_000×30/10000
  })
  test('גדלים-גדולים: אפס-עקיפות-מספריות (µ-שלמים-בלבד, מעל-2^31)', () => {
    const p = mkPool(9_000_000_000, 900_000_000_000)
    const q = quoteSwap(p, 'baseToQuote', 123_456_789)
    expect(Number.isSafeInteger(q.outMu)).toBe(true)
    expect(q.outMu).toBeGreaterThan(0)
  })
})

describe('AMM — applySwap (אינווריאנטים A1–A7)', () => {
  test('A1: מוצר-העתודות אינו-יורד-לעולם (העמלה-מנפחת-את-הבריכה)', () => {
    let p = mkPool(1_000_000, 100_000_000)
    const k0 = p.reserveBaseMu * p.reserveQuoteMu
    for (const dir of ['baseToQuote', 'quoteToBase'] as const) {
      for (const amt of [1_000, 50_000, 999]) {
        const r = applySwap(p, dir, amt, 0)
        const k1 = r.pool.reserveBaseMu * r.pool.reserveQuoteMu
        expect(k1).toBeGreaterThanOrEqual(k0)
        p = r.pool
      }
    }
  })
  test('A2+A3: הרצפה-תמיד-לטובת-הבריכה; אין-הטבעת-כסף-מאין', () => {
    const p0 = mkPool(1_000_000, 100_000_000)
    const r = applySwap(p0, 'baseToQuote', 10_000, 0)
    // מדויק-ערכי: out_ideal = rq×(in×(1−f)) / (rb + in×(1−f))
    const inAfterFee = Math.floor((10_000 * (10_000 - 30)) / 10_000)
    const ideal = (100_000_000 * inAfterFee) / (1_000_000 + inAfterFee)
    expect(r.outMu).toBe(Math.floor(ideal))
    // שימור-דו-צדדי: בריכה קיבלה in, שילמה out — הפער (עמלה+מחיק) נשאר-בעתודות
    const deltaBase = r.pool.reserveBaseMu - p0.reserveBaseMu
    const deltaQuote = r.pool.reserveQuoteMu - p0.reserveQuoteMu
    expect(deltaBase).toBe(10_000)
    expect(deltaQuote).toBe(-(r.outMu))
    expect(r.outMu).toBeLessThan(100_000_000)
  })
  test('A4: מגן-החלקה minOut — fail-closed בלי-שינוי-מצב', () => {
    const p0 = mkPool(1_000_000, 100_000_000)
    const q = quoteSwap(p0, 'baseToQuote', 10_000)
    expect(() => applySwap(p0, 'baseToQuote', 10_000, q.outMu + 1)).toThrow(/minOut|slippage/i)
  })
  test('A5: דחייה-כנה — אפס/שלילי/מעל-עתודה/עמלה-לא-חוקית', () => {
    const p = mkPool(1_000_000, 100_000_000)
    expect(() => applySwap(p, 'baseToQuote', 0, 0)).toThrow()
    expect(() => applySwap(p, 'baseToQuote', -5, 0)).toThrow()
    expect(() => applySwap(p, 'baseToQuote', 5.5, 0)).toThrow()
    expect(() => applySwap(p, 'baseToQuote', 2_000_000, 0)).toThrow() // מעל-עתודת-הבסיס
    expect(() => applySwap(p, 'baseToQuote', 1_000, 0)).not.toThrow()
    expect(() => applySwap(mkPool(100, 100, 10_000), 'baseToQuote', 10, 0)).toThrow(/fee/i) // עמלה≥10000 = אפס-פלט-תמיד
  })
  test('A6: דטרמיניזם — אותם-קלטים → אותן-תוצאות בדיוק', () => {
    const a = applySwap(mkPool(1_000_000, 100_000_000), 'quoteToBase', 77_777, 0)
    const b = applySwap(mkPool(1_000_000, 100_000_000), 'quoteToBase', 77_777, 0)
    expect(a.outMu).toBe(b.outMu)
    expect(a.pool.reserveBaseMu).toBe(b.pool.reserveBaseMu)
  })
  test('A7: רצף-חליפין-דו-כיווני לא-מרוויח-מהפער (round-trip אובדן-עמלה-בלבד)', () => {
    const p0 = mkPool(1_000_000, 100_000_000)
    const r1 = applySwap(p0, 'baseToQuote', 10_000, 0)
    const r2 = applySwap(r1.pool, 'quoteToBase', r1.outMu, 0)
    expect(r2.outMu).toBeLessThan(10_000) // העמלה-הכפולה+המחיק תמיד-נגד-הסוחר
    expect(r2.outMu).toBeGreaterThan(9_900) // אבל-בגבול-סביר (0.7% בערך על-גודל-קטן)
  })
})

describe('AMM — נזילות (§3: הזרמת-נזילות-עצמאית)', () => {
  test('addLiquidity: מניות-רצפה-לטובת-בריכה; עודף-יחס נשאר-בבריכה', () => {
    const p0 = mkPool(1_000_000, 100_000_000)
    const mint = addLiquidityShares(p0, 100_000, 10_000_000)
    expect(mint).toBe(Math.floor((100_000 * p0.lpSharesMu) / 1_000_000)) // min(יחסים) = בסיס
  })
  test('withdraw: פרופורציה-שלמה, רצפה-לטובת-בריכה, אסור-לרוקן-מתחת-מינימום-שריפה', () => {
    const p0 = mkPool(1_000_000, 100_000_000)
    const out = withdrawLiquidityShares(p0, Math.floor(p0.lpSharesMu / 2))
    expect(out.baseMu).toBe(Math.floor((p0.reserveBaseMu * Math.floor(p0.lpSharesMu / 2)) / p0.lpSharesMu))
    expect(() => withdrawLiquidityShares(p0, p0.lpSharesMu)).toThrow(/MIN_LIQUIDITY|minimum/i)
    expect(() => withdrawLiquidityShares(p0, 0)).toThrow()
  })
})

describe('AMM על-sqlite אמיתי (store :memory:) — שרשרת-מלאה עם שימור-כספים-גלובלי', () => {
  test('זריעה→החלפה→שימור: Σכספים-על-כל-הארנקות קבוע (I4-גלובלי עם-בריכה)', () => {
    const db = new Database(':memory:')
    ensureSchema(db)
    seedWallets(db, { trader: { WSTEEM: 1_000_000, USDS: 0 }, operator: { WSTEEM: 0, USDS: 0 } })
    const store = createSqliteStore(db)
    // זריעת-בריכה מארנק-ה-operator (הזרמת-נזילות §3)
    const op = store.getWallet('operator')!
    op.balances.WSTEEM = 1_000_000
    op.balances.USDS = 100_000_000
    store.saveWallet(op)
    const before = {
      WSTEEM: (store.getWallet('trader')?.balances.WSTEEM ?? 0) + (store.getWallet('operator')?.balances.WSTEEM ?? 0),
      USDS: (store.getWallet('trader')?.balances.USDS ?? 0) + (store.getWallet('operator')?.balances.USDS ?? 0),
    }
    // העברת-עתודות-לארנק-הבריכה + רישום-בריכה
    const op2 = store.getWallet('operator')!
    op2.balances.WSTEEM -= 1_000_000
    op2.balances.USDS -= 100_000_000
    store.saveWallet(op2)
    const poolWalletName = 'AMM:WSTEEM/USDS'
    ensureWalletRow(db, poolWalletName) // ארנק-בריכה-חדש — התיקון-שהבדיקה-כפתה
    store.saveWallet({ name: poolWalletName, credits: 0, balances: { WSTEEM: 1_000_000, USDS: 100_000_000 }, locked: {} })
    const poolId = insertPoolViaStore(db, 'WSTEEM', 'USDS', 1_000_000, 100_000_000, 30, poolWalletName)
    // החלפה: trader שולח 10_000 µ-WSTEEM לבריכה, מקבל µ-USDS
    const p0 = poolRow(db, poolId)!
    const trader = store.getWallet('trader')!
    trader.balances.WSTEEM -= 10_000
    store.saveWallet(trader)
    const pw = store.getWallet(poolWalletName)!
    pw.balances.WSTEEM += 10_000
    const r = applySwap(p0, 'baseToQuote', 10_000, 0)
    pw.balances.USDS -= r.outMu
    store.saveWallet(pw)
    const poolRowAfter = poolRow(db, poolId)!
    poolRowAfter.reserveBaseMu = r.pool.reserveBaseMu
    poolRowAfter.reserveQuoteMu = r.pool.reserveQuoteMu
    updatePoolRow(db, poolRowAfter)
    const traderAfter = store.getWallet('trader')!
    traderAfter.balances.USDS += r.outMu
    store.saveWallet(traderAfter)
    const after = {
      WSTEEM: (store.getWallet('trader')?.balances.WSTEEM ?? 0) + (store.getWallet(poolWalletName)?.balances.WSTEEM ?? 0) + (store.getWallet('operator')?.balances.WSTEEM ?? 0),
      USDS: (store.getWallet('trader')?.balances.USDS ?? 0) + (store.getWallet(poolWalletName)?.balances.USDS ?? 0) + (store.getWallet('operator')?.balances.USDS ?? 0),
    }
    expect(after.WSTEEM).toBe(before.WSTEEM)
    expect(after.USDS).toBe(before.USDS)
    // והבריכה עצמה גדלה-במכפלה (עמלה)
    const k0 = 1_000_000 * 100_000_000
    const k1 = r.pool.reserveBaseMu * r.pool.reserveQuoteMu
    expect(k1).toBeGreaterThan(k0)
  })
})

// עזרי-store לבדיקה (המימוש-האמיתי-ב-store.ts)
function insertPoolViaStore(db: Database, base: string, quote: string, rb: number, rq: number, fee: number, walletName: string): number {
  const p = seedPool(base, quote, rb, rq, fee)
  return insertPoolRow(db, { ...p, walletName })
}
