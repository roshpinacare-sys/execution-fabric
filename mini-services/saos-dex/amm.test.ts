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
  poolMidMu,
  quoteSwap,
  seedPool,
  seedQuoteAtFairMu,
  withdrawLiquidityShares,
  type Pool,
} from './amm'
import { ensureSchema, ensureWalletRow, poolRow, seedWallets, createSqliteStore, insertPoolRow, updatePoolRow } from './store'
import { captureStep } from './spread'

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

// ── Task-141-b (הפעלת-הבריכות): חישוב-צד-ה-quote לזריעה-על-ה-fair ────────────
// חוזה-הזריעה-הכן: הבריכה נזרעת-בדיוק-על מחיר-ה-fair של הספר (µ-quote ליחידת-בסיס-
// שלמה) — אפס-רווח-פיקטיבי-מול-הספר ברגע-היוולדה. הרצפה-תמיד-לטובת-הבריכה:
// אם המנה-אינה-מתחלקת, העיגול-למטה מציב-את-המחיר מעט-מתחת-ל-fair (לעולם לא מעליו).
describe('AMM — seedQuoteAtFairMu (Task-141-b: זריעה-על-מחיר-ה-fair)', () => {
  const pxOf = (rb: number, rq: number): number => Math.floor((rq * 1_000_000) / rb)

  test('מדויק: rb=1_000_000 על fair=120_000 → rq=120_000 ומחיר-הבריכה = ה-fair בדיוק', () => {
    const rb = 1_000_000
    const rq = seedQuoteAtFairMu(rb, 120_000)
    expect(rq).toBe(120_000)
    expect(pxOf(rb, rq)).toBe(120_000)
  })

  test('תרחיש-החי (Task-141-b): WSTEEM 900_000µ על fair 120_000 → 108_000µ; SAOS 900_000µ על fair 100_400 → 90_360µ', () => {
    expect(seedQuoteAtFairMu(900_000, 120_000)).toBe(108_000)
    expect(seedQuoteAtFairMu(900_000, 100_400)).toBe(90_360)
    expect(pxOf(900_000, 108_000)).toBe(120_000)
    expect(pxOf(900_000, 90_360)).toBe(100_400)
  })

  test('חוק-הרצפה: לכל (rb,fair) — מחיר-הבריכה לעולם לא מעל-ה-fair, ואובדן-העיגול ≤ ceil(1e6/rb)+1', () => {
    const cases: Array<[number, number]> = [
      [1, 120_000], [7, 100_400], [999_983, 123_457], [1_000_000, 1], [333_333, 999_999], [2_000_000, 10_040],
    ]
    for (const [rb, fair] of cases) {
      const rq = seedQuoteAtFairMu(rb, fair)
      const px = pxOf(rb, rq)
      expect(px).toBeLessThanOrEqual(fair)
      expect(fair - px).toBeLessThanOrEqual(Math.ceil(1_000_000 / rb) + 1)
    }
  })

  test('דטרמיניזם: אותם-קלטים → אותו-פלט; דחייה-כנה לקלט-פסול (A5/A6-רוח)', () => {
    expect(seedQuoteAtFairMu(900_000, 120_000)).toBe(seedQuoteAtFairMu(900_000, 120_000))
    expect(() => seedQuoteAtFairMu(0, 120_000)).toThrow()
    expect(() => seedQuoteAtFairMu(-5, 120_000)).toThrow()
    expect(() => seedQuoteAtFairMu(100.5, 120_000)).toThrow() // µ-שלמים-בלבד
    expect(() => seedQuoteAtFairMu(900_000, 0)).toThrow()
    expect(() => seedQuoteAtFairMu(900_000, -1)).toThrow()
    expect(() => seedQuoteAtFairMu(900_000, 10.5)).toThrow()
  })
})

// ── Task-141-b: תרחיש-ההפעלה-המלא בטהור — זריעה-על-ה-fair → סטייה-מדודה → לכידת-
// מיקרו-פרשים יורה → המכפלה-צומחת. זהו-מראת-ההרצה-החיה (ערכי-הזריעה זהים לחי). ──
describe('AMM — תרחיש-הפעלה (Task-141-b): זריעה→סטייה→לכידה→צמיחת-מכפלה', () => {
  test('זריעה על fair 120_000; סוחר-פרובוקטור מוכר 12_000µ לבריכה; הלכידה קונה-חזרה ברווח-אחרי-עמלה', () => {
    // זריעה בדיוק-כמו-בחיים: rb=900_000, rq=108_000 → px = 120_000 = fair
    const seedRq = seedQuoteAtFairMu(900_000, 120_000)
    let pool = seedPool('WSTEEM', 'USDS', 900_000, seedRq, 30)
    expect(Math.floor((pool.reserveQuoteMu * 1_000_000) / pool.reserveBaseMu)).toBe(120_000)
    const k0 = BigInt(pool.reserveBaseMu) * BigInt(pool.reserveQuoteMu)

    // פרובוקטור (כמו-הפרובה-החיה): baseToQuote 12_000µ — מוריד את מחיר-הבריכה מתחת-ל-fair
    const probe = applySwap(pool, 'baseToQuote', 12_000, 0)
    expect(probe.feeMu).toBe(36) // 12_000×30/10_000
    pool = probe.pool
    const pxAfterProbe = Math.floor((pool.reserveQuoteMu * 1_000_000) / pool.reserveBaseMu)
    expect(pxAfterProbe).toBeLessThan(120_000)
    expect(pxAfterProbe).toBeGreaterThan(114_000) // מתחת-לתקרת-השלמות (5_000bps מהעוגן)

    // לכידת-המיקרו-פרשים: היד מחזיקה USDS בלבד → quoteToBase, רווח-אמת-אחרי-עמלה
    const hand = { freeQuoteMu: 130_000, freeBaseMu: 0 }
    const dec = captureStep(pool, 120_000, hand)
    expect(dec.action).toBe('quoteToBase')
    expect(dec.expectedFeeMu).toBeGreaterThanOrEqual(1) // S1: עמלה-אמת
    expect(dec.expectedProfitMu).toBeGreaterThanOrEqual(1) // S2: רווח-אמת

    // ביצוע-הלכידה: minOut מוגן, והמכפלה-צומחת-מעל-הזריעה (A1 — העמלות-נשארות-בבריכה)
    const r = applySwap(pool, dec.action, dec.amountInMu, dec.expectedOutMu)
    const k1 = BigInt(r.pool.reserveBaseMu) * BigInt(r.pool.reserveQuoteMu)
    expect(k1).toBeGreaterThan(k0)
    const pxAfterCapture = Math.floor((r.pool.reserveQuoteMu * 1_000_000) / r.pool.reserveBaseMu)
    expect(pxAfterCapture).toBeGreaterThan(pxAfterProbe) // הבריכה נמשכה-חזרה אל-ה-fair
  })
})

describe('poolMidMu — Task-142: מחיר-אמצע-הבריכה-כנזילות-דו-צדדית', () => {
  test('סקאלת-הספר: floor(rq×1e6/rb)', () => {
    // 100_000µ quote על 1_000_000µ בסיס → 100µ? לא: 100_000×1e6/1_000_000 = 100_000
    expect(poolMidMu(1_000_000, 100_000)).toBe(100_000)
    // זריעה-על-fair: seedQuoteAtFairMu(1_000_000, 120_000) → rq → px ≤ 120_000
    const rq = seedQuoteAtFairMu(1_000_000, 120_000)
    expect(poolMidMu(1_000_000, rq)).toBeLessThanOrEqual(120_000)
    expect(poolMidMu(1_000_000, rq)).toBeGreaterThanOrEqual(119_999) // אובדן-עיגול ≤ 1µ ליחידת-בסיס-שלמה
  })
  test('רצפת-עיגול: px ≤ fairMu תמיד (לטובת-הבריכה, אין-רווח-פיקטיבי)', () => {
    for (const fair of [10040, 100400, 1004000]) {
      const rq = seedQuoteAtFairMu(903_533, fair)
      const px = poolMidMu(903_533, rq)
      expect(px).not.toBeNull()
      expect(px!).toBeLessThanOrEqual(fair)
    }
  })
  test('קצה-היסט: fair-זעיר עד-כדי-ריקון-rq→0 → אמצע-null-כנה (fail-closed, לא-0)', () => {
    const rq = seedQuoteAtFairMu(903_533, 1) // floor(903533µ×1/1e6)=0 — אין-בריכה-אפשרית
    expect(rq).toBe(0)
    expect(poolMidMu(903_533, rq)).toBe(null)
  })
  test('fail-closed: קלט-פסול/אפס → null (לא-0-מזויף)', () => {
    expect(poolMidMu(0, 100)).toBe(null)
    expect(poolMidMu(100, 0)).toBe(null)
    expect(poolMidMu(-5, 100)).toBe(null)
    expect(poolMidMu(1.5, 100)).toBe(null)
    expect(poolMidMu(NaN, 100)).toBe(null)
  })
})
