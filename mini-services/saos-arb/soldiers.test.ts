// ═════════════════════════════════════════════════════════════════════════════
// soldiers.test.ts — רשת-החיילים (Task-136 §2 — דירקטיבת-הבעלים) — TDD
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  MIN_ORDER_MU,
  askSizeMu,
  bidSizeMu,
  floatPolicy,
  streamPlan,
  type SoldierBalance,
} from './soldiers'

// ── מדיניות-צף ──────────────────────────────────────────────────────────────
describe('floatPolicy — חוק-הצף המינימלי', () => {
  test('חייל-רזה → צריך-הזרמה בדיוק-עד-המינימום', () => {
    const p = floatPolicy('grid-mm', { name: 'grid-mm', balances: { USDS: 1_150_000, WSTEEM: 0 } }, 'WSTEEM', 100_000)
    expect(p.stream).toBe(true)
    expect(p.needMu).toBe(100_000)
    expect(p.freeMu).toBe(0)
  })
  test('חייל-מתחת-למינימום-חלקית → רק-הפער', () => {
    const p = floatPolicy('mm-wsbd', { name: 'mm-wsbd', balances: { USDS: 1_100_000, WSBD: 30_000 } }, 'WSBD', 50_000)
    expect(p.stream).toBe(true)
    expect(p.needMu).toBe(20_000)
  })
  test('חייל-שומן → לא-מוזרם', () => {
    const p = floatPolicy('arb-peg', { name: 'arb-peg', balances: { USDS: 1_100_000, WSTEEM: 162_401 } }, 'WSTEEM', 100_000)
    expect(p.stream).toBe(false)
    expect(p.needMu).toBe(0)
  })
  test('נכס-חסר-לגמרי-מנוהל-כאפס (לא-NaN)', () => {
    const p = floatPolicy('x', { name: 'x', balances: {} }, 'WSTEEM', 10)
    expect(p.freeMu).toBe(0)
    expect(p.needMu).toBe(10)
  })
})

// ── תוכנית-הזרמות ────────────────────────────────────────────────────────────
describe('streamPlan — זרימת-נזילות בין-חשבונית אמת', () => {
  const treasury: SoldierBalance = { name: 'treasury', balances: { WSTEEM: 1_000_000, WSBD: 500_000 } }

  test('מזרים-לפי-גירעון גדול-ראשון (דטרמיניסטי)', () => {
    const deficits = [
      floatPolicy('a', { name: 'a', balances: { WSTEEM: 0 } }, 'WSTEEM', 50_000),
      floatPolicy('b', { name: 'b', balances: { WSTEEM: 45_000 } }, 'WSTEEM', 50_000),
    ]
    const plan = streamPlan(treasury, deficits, 'WSTEEM', 200_000)
    expect(plan).toEqual([
      { from: 'treasury', to: 'a', asset: 'WSTEEM', amountMu: 50_000 },
      { from: 'treasury', to: 'b', asset: 'WSTEEM', amountMu: 5_000 },
    ])
  })

  test('תקרת-מחזור-לחייל-בודד נאכפת', () => {
    const deficits = [floatPolicy('a', { name: 'a', balances: {} }, 'WSTEEM', 1_000_000)]
    const plan = streamPlan(treasury, deficits, 'WSTEEM', 100_000)
    expect(plan).toEqual([{ from: 'treasury', to: 'a', asset: 'WSTEEM', amountMu: 100_000 }])
  })

  test('האוצר-לעולם-לא-נשאב-מעבר-ליתרה — מימון-חלקי-כנה', () => {
    const poor: SoldierBalance = { name: 'treasury', balances: { WSTEEM: 30_000 } }
    const deficits = [
      floatPolicy('a', { name: 'a', balances: {} }, 'WSTEEM', 50_000),
      floatPolicy('b', { name: 'b', balances: {} }, 'WSTEEM', 50_000),
    ]
    const plan = streamPlan(poor, deficits, 'WSTEEM', 200_000)
    expect(plan).toEqual([{ from: 'treasury', to: 'a', asset: 'WSTEEM', amountMu: 30_000 }])
  })

  test('אוצר-ריק → אפס-הזרמות (אפס-כסף-מאין)', () => {
    const empty: SoldierBalance = { name: 'treasury', balances: {} }
    const plan = streamPlan(empty, [floatPolicy('a', { name: 'a', balances: {} }, 'WSTEEM', 50_000)], 'WSTEEM', 100_000)
    expect(plan).toEqual([])
  })

  test('שוויון-גירעונות → סדר-שמות-עולה (דטרמיניזם מלא)', () => {
    const deficits = [
      floatPolicy('zeta', { name: 'zeta', balances: {} }, 'WSBD', 20_000),
      floatPolicy('alpha', { name: 'alpha', balances: {} }, 'WSBD', 20_000),
    ]
    const plan = streamPlan(treasury, deficits, 'WSBD', 200_000)
    expect(plan.map((t) => t.to)).toEqual(['alpha', 'zeta'])
  })

  test('מסנן-נכסים-אחרים: גירעונות-בנכס-שונה-לא-נכללים', () => {
    const deficits = [
      floatPolicy('a', { name: 'a', balances: {} }, 'PHIVE', 50_000),
      floatPolicy('b', { name: 'b', balances: {} }, 'WSTEEM', 50_000),
    ]
    const plan = streamPlan(treasury, deficits, 'WSTEEM', 200_000)
    expect(plan).toEqual([{ from: 'treasury', to: 'b', asset: 'WSTEEM', amountMu: 50_000 }])
  })
})

// ── גודל-קנייה-אמת ───────────────────────────────────────────────────────────
describe('bidSizeMu — מוסכמת-העלות של הדקס (need = amount×price)', () => {
  test('המתמטיקה האמת: floor(free/px) עם-תקרה', () => {
    expect(bidSizeMu(1_150_000, 124, 4_000)).toBe(4_000) // affordable 9274 > cap
    expect(bidSizeMu(150_000, 124, 4_000)).toBe(1_209) // floor(150000/124)
    expect(bidSizeMu(150_000, 124, 100)).toBe(0) // תקרה-מתחת-סף-החיים → אין-פקודה-זעירה
  })
  test('המקרה-המבני-שנמדד: SAOS-זרע-100k — אין-כסף-אמת לפקודה → 0 כנה (לא-דחייה-שקטה-בשק)', () => {
    // הבאג-ההיסטורי: הנוסחה-הישנה floor(usds*1000/px/2)=750 "עברה" מקומית-אך-הדקס
    // דחה-75M-עלות-מול-150k-יתרה — כל-מחזור. החוק-החדש מכריז-אפס-מראש.
    expect(bidSizeMu(150_000, 100_000, 4_000)).toBe(0)
  })
  test('סף-החיים: מעל-500 חי, מתחת-אפס', () => {
    expect(bidSizeMu(MIN_ORDER_MU * 124, 124, 4_000)).toBe(MIN_ORDER_MU)
    expect(bidSizeMu(MIN_ORDER_MU * 124 - 1, 124, 4_000)).toBe(0)
  })
  test('קלט-פסול → 0 (אף-זריקה)', () => {
    expect(bidSizeMu(0, 124, 4_000)).toBe(0)
    expect(bidSizeMu(-5, 124, 4_000)).toBe(0)
    expect(bidSizeMu(1_000, 0, 4_000)).toBe(0)
    expect(bidSizeMu(1_000, NaN, 4_000)).toBe(0)
    expect(bidSizeMu(1_000, 124, 0)).toBe(0)
    expect(bidSizeMu(NaN, 124, 4_000)).toBe(0)
  })
})

// ── גודל-מכירה-אמת ───────────────────────────────────────────────────────────
describe('askSizeMu — מלאי-אמת-בלבד (אף-מכירה-באוויר)', () => {
  test('min(cap, מלאי-אמת)', () => {
    expect(askSizeMu(50_000, 4_000)).toBe(4_000)
    expect(askSizeMu(3_000, 4_000)).toBe(3_000)
  })
  test('מלאי-מתחת-לסף-החיים → 0 (כנות)', () => {
    expect(askSizeMu(499, 4_000)).toBe(0)
    expect(askSizeMu(0, 4_000)).toBe(0)
  })
  test('קלט-פסול → 0 (אף-זריקה)', () => {
    expect(askSizeMu(NaN, 4_000)).toBe(0)
    expect(askSizeMu(-1, 4_000)).toBe(0)
    expect(askSizeMu(1_000, NaN)).toBe(0)
    expect(askSizeMu(1_000, -3)).toBe(0)
  })
})
