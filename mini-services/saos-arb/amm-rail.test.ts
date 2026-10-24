// ═════════════════════════════════════════════════════════════════════════════
// amm-rail.test.ts — מסילת-ה-quote-AMM (Issue: feat(saos-arb) §7.1) — TDD
// ההכרעה-הטהורה: פער-ספר-מול-בריכה ב-bps → כיוון + גודל-קלי, fail-closed.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { ammEdgeBps, ammRailDecision, type AmmRailInput } from './amm-rail'

function input(over: Partial<AmmRailInput> = {}): AmmRailInput {
  return {
    bookMidMu: 120_000,
    ammPriceMu: 120_000,
    feeBps: 30,
    minEdgeBps: 80,
    freeQuoteMu: 50_000,
    freeBaseMu: 20_000,
    kellyWinProb: 0.55,
    kellyRatio: 1.2,
    kellyCapFrac: 0.1,
    maxNotionalMu: 20_000,
    ...over,
  }
}

describe('ammEdgeBps — פער-ספר-מול-בריכה (מדידה-גלויה)', () => {
  test('ספר-יקר-מהבריכה ב-1% → +100bps', () => {
    expect(ammEdgeBps(121_200, 120_000)).toBe(100)
  })
  test('ספר-זול-מהבריכה ב-0.5% → −50bps', () => {
    expect(ammEdgeBps(119_400, 120_000)).toBe(-50)
  })
  test('אין-מדידה (null/0/שלילי) → null — אין-המצאת-קצה', () => {
    expect(ammEdgeBps(null, 120_000)).toBeNull()
    expect(ammEdgeBps(120_000, null)).toBeNull()
    expect(ammEdgeBps(0, 120_000)).toBeNull()
    expect(ammEdgeBps(120_000, -5)).toBeNull()
    expect(ammEdgeBps(NaN, 120_000)).toBeNull()
  })
})

describe('ammRailDecision — ההכרעה (כיוון+גודל-קלי, fail-closed)', () => {
  test('ספר-יקר (edge>+סף) → קניית-בסיס-מהבריכה (quoteToBase) בגודל-קלי', () => {
    // edge = +166.7bps > 80 — הבריכה-זולה: קונים-בסיס-ממנה עם-quote
    const d = ammRailDecision(input({ bookMidMu: 122_000, ammPriceMu: 120_000 }))
    expect(d.action).toBe('swap')
    if (d.action === 'swap') {
      expect(d.direction).toBe('quoteToBase')
      expect(d.edgeBps).toBe(167)
      // קלי: f=(0.55×2.2−1)/1.2=0.175 → cap 0.1 → 50,000×0.1=5,000 → תקרה 20,000 → 5,000
      expect(d.amountInMu).toBe(5_000)
    }
  })
  test('ספר-זול (edge<−סף) → מכירת-בסיס-לבריכה (baseToQuote) מהמלאי', () => {
    // edge = −166.7bps — הבריכה-יקרה: מוכרים-לה-בסיס
    const d = ammRailDecision(input({ bookMidMu: 118_000, ammPriceMu: 120_000 }))
    expect(d.action).toBe('swap')
    if (d.action === 'swap') {
      expect(d.direction).toBe('baseToQuote')
      // קלי על-המלאי-הבסיסי: 20,000×0.1=2,000
      expect(d.amountInMu).toBe(2_000)
    }
  })
  test('קצה-בתוך-הסף (|edge|<minEdge) → hold כנה', () => {
    // 4bps גולמי — נטו אחרי-2×30bps שלילי → מתחת-לסף
    const d = ammRailDecision(input({ bookMidMu: 120_050, ammPriceMu: 120_000 }))
    expect(d.action).toBe('hold')
    if (d.action === 'hold') expect(d.reason).toBe('edge-below-min-after-fees')
  })
  test('העמלה-נספרת: קצה-גולמי-גדול-אבל-נטו-מתחת-לסף → hold', () => {
    // גולמי 60bps, נטו אחרי-2×30bps = 0 → מתחת-לסף
    const d = ammRailDecision(input({ bookMidMu: 120_072, ammPriceMu: 120_000, minEdgeBps: 10 }))
    expect(d.action).toBe('hold')
    if (d.action === 'hold') expect(d.reason).toBe('edge-below-min-after-fees')
  })
  test('אין-מדידה → hold מפורש (fail-closed, לא-השערה)', () => {
    expect(ammRailDecision(input({ bookMidMu: null })).action).toBe('hold')
    expect(ammRailDecision(input({ ammPriceMu: null })).action).toBe('hold')
  })
  test('אין-מלאי-פנוי-בצד-הרלוונטי → hold no-free-funds', () => {
    const d = ammRailDecision(input({ bookMidMu: 122_000, freeQuoteMu: 0 }))
    expect(d.action).toBe('hold')
    if (d.action === 'hold') expect(d.reason).toBe('no-free-funds')
  })
  test('תקרת-מסחר נאכפת — הגודל לעולם לא מעל maxNotionalMu', () => {
    const d = ammRailDecision(input({ bookMidMu: 122_000, maxNotionalMu: 3_000 }))
    expect(d.action).toBe('swap')
    if (d.action === 'swap') expect(d.amountInMu).toBe(3_000)
  })
  test('תקרת-קלי נאכפת — הגודל לעולם לא מעל free×capFrac', () => {
    const d = ammRailDecision(input({ bookMidMu: 122_000, freeQuoteMu: 100_000, maxNotionalMu: 50_000 }))
    expect(d.action).toBe('swap')
    if (d.action === 'swap') expect(d.amountInMu).toBe(10_000) // 100,000×0.1
  })
  test('דטרמיניזם: אותו-קלט → אותה-הכרעה', () => {
    const a = ammRailDecision(input({ bookMidMu: 122_000 }))
    const b = ammRailDecision(input({ bookMidMu: 122_000 }))
    expect(a).toEqual(b)
  })
})
