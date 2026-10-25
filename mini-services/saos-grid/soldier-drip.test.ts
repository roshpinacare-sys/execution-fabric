// ═════════════════════════════════════════════════════════════════════════════
// soldier-drip.test.ts — טפטוף-הון-מהאוצר-אל-החיילים (דירקטיבת-בעלים 25/10 §3):
// "למה-ריבוי-חיילים-לא-מסחרר? כי-למפתחות-יש-ידיים-אך-אין-דלק" — המדידה-החיה
// (16:00Z): ל-saos-0001..3 יש-מפתחות-ACTIVE-טעונים (4 ידיים live) אך 0.000 STEEM/SBD
// → המנוע-מדלג-בכנות ("מתחת-לגודל-המינימלי"). התיקון: טפטוף-מדוד-מהאוצר.
//
// חוקים-טהורים (אפס-I/O, אפס-שעון, שלמים-בלבד):
//  1. רזרבת-אוצר-קודש: לעולם-לא-נוגעים ב-reservePct% — מימון-חלקי-כנה-עדיף-על-שריפת-רזרבה.
//  2. SBD-קודם (צד-קנייה — הפתיחה-הזולה-ביותר: כל-חייל-קונה-כבר-מ-0.056 SBD).
//  3. STEEM-שני (צד-מכירה — נדרש ≥0.5+רווח-ביטחון).
//  4. דטרמיניזם: גירעון-גדול-ראשון; שוויון → שם-עולה.
//  5. תקרת-העברות-לפעימה (אפס-סערת-ברודקאסט).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { dripPlan, type DripPlanInput } from './soldier-drip'

function input(over: Partial<DripPlanInput> = {}): DripPlanInput {
  return {
    treasury: { steemMu: 1127, sbdMu: 479 }, // המצב-החי-המדוד 16:00Z
    soldiers: [
      { name: 'saos-0001', steemMu: 0, sbdMu: 0 },
      { name: 'saos-0002', steemMu: 0, sbdMu: 0 },
      { name: 'saos-0003', steemMu: 0, sbdMu: 0 },
    ],
    reservePct: 10,
    buySideTargetSbdMu: 150,  // 0.150 SBD → קנייה-חיה (0.135 זמין ≥ 0.05 מינימום-מנוע)
    sellSideTargetSteemMu: 600, // 0.600 STEEM → מכירה-חיה (≥ 0.5 מינימום-מנוע + רווח)
    maxTransfersPerPulse: 6,
    ...over,
  }
}

describe('dripPlan — טפטוף-אוצר→חיילים', () => {
  test('SBD-קודם: שניים-מלאים + שלישי-חלקי-כנה (האוצר-החי-מדוד)', () => {
    const r = dripPlan(input({ maxTransfersPerPulse: 3 }))
    const sbd = r.transfers.filter((t) => t.asset === 'SBD')
    expect(sbd.length).toBe(3)
    expect(sbd[0].amountMu).toBe(150)
    expect(sbd[1].amountMu).toBe(150)
    expect(sbd[2].amountMu).toBe(Math.floor(479 * 0.9) - 300) // 131 — השארית-הזמינה
    expect(sbd[2].reason).toBe('partial-treasury')
  })

  test('רזרבת-אוצר-קודש: הזמין-הוא-90% בלבד — טפטוף-חלקי-כנה', () => {
    const r = dripPlan(input({ maxTransfersPerPulse: 6 }))
    const sbd = r.transfers.filter((t) => t.asset === 'SBD')
    const totalSbd = sbd.reduce((s, t) => s + t.amountMu, 0)
    expect(totalSbd).toBe(Math.floor(479 * 0.9)) // 431 — כל-מה-שאפשר, לא-יותר
    expect(totalSbd).toBeLessThanOrEqual(431)
  })

  test('STEEM-שני: רק-אם-נשאר-זמין-אחרי-SBD', () => {
    const r = dripPlan(input())
    const steem = r.transfers.filter((t) => t.asset === 'STEEM')
    const totalSteem = steem.reduce((s, t) => s + t.amountMu, 0)
    expect(totalSteem).toBe(Math.floor(1127 * 0.9)) // 1014 — כל-הזמין-למכירות-חיות
    if (steem.length > 0) {
      // כל-העברה-שלמה (לא-שבר-מתחת-ליעד-המלא-אלא-אם-נגמר-האוצר)
      const full = steem.filter((t) => t.reason === 'sell-side')
      for (const t of full) expect(t.amountMu).toBe(600)
    }
  })

  test('חייל-ממומן-כבר-מעל-היעד → skipped deficit-zero', () => {
    const r = dripPlan(
      input({
        soldiers: [
          { name: 'saos-0001', steemMu: 700, sbdMu: 200 },
          { name: 'saos-0002', steemMu: 0, sbdMu: 0 },
        ],
      }),
    )
    expect(r.transfers.some((t) => t.to === 'saos-0001')).toBe(false)
    expect(r.skipped.some((s) => s.startsWith('saos-0001:') && s.includes('deficit-zero'))).toBe(true)
  })

  test('אוצר-ריק → אפס-העברות + skipped treasury-empty (כנות, לא-פקודות-אוויר)', () => {
    const r = dripPlan(input({ treasury: { steemMu: 0, sbdMu: 0 } }))
    expect(r.transfers.length).toBe(0)
    // כל-חייל-מקבל-סיבת-שקט-בכל-פאזה (SBD+STEEM) — אפס-הסתרה
    expect(r.skipped.filter((s) => s.includes('treasury-empty')).length).toBe(6)
  })

  test('דטרמיניזם: גירעון-גדול-ראשון; שוויון → שם-עולה', () => {
    const r1 = dripPlan(
      input({
        treasury: { steemMu: 100000, sbdMu: 1000 },
        soldiers: [
          { name: 'b-soldier', steemMu: 0, sbdMu: 0 },
          { name: 'a-soldier', steemMu: 0, sbdMu: 0 },
          { name: 'c-soldier', steemMu: 0, sbdMu: 50 },
        ],
        maxTransfersPerPulse: 3,
      }),
    )
    const order = r1.transfers.map((t) => t.to)
    expect(order[0]).toBe('a-soldier') // 150 גירעון
    expect(order[1]).toBe('b-soldier') // 150 גירעון, שם-עולה-אחרי-a
    expect(order[2]).toBe('c-soldier') // 100 גירעון
  })

  test('תקרת-העברות-לפעימה נאכפת (אפס-סערת-ברודקאסט)', () => {
    const r = dripPlan(input({ maxTransfersPerPulse: 2 }))
    expect(r.transfers.length).toBe(2)
    expect(r.skipped.filter((s) => s.includes('cap-reached')).length).toBeGreaterThan(0)
  })

  test('שלמים-בלבד: כל-סכום-מספר-שלם ≥ 1 (אפס-אבק-צף)', () => {
    const r = dripPlan(input())
    for (const t of r.transfers) {
      expect(Number.isInteger(t.amountMu)).toBe(true)
      expect(t.amountMu).toBeGreaterThanOrEqual(1)
    }
  })

  test('רזרבה-100% → אפס-זמין → כנות-מלאה', () => {
    const r = dripPlan(input({ reservePct: 100 }))
    expect(r.transfers.length).toBe(0)
  })
})
