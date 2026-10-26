// ═════════════════════════════════════════════════════════════════════════════
// rc-rebalance.test.ts — איזון-RC-בין-חיילים (דירקטיבת-141 §2 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים §2: "Rebalance Resource Credits (RC) dynamically across
// soldier accounts". הליבה-כאן-טהורה-ודטרמיניסטית — הקריאה-החיה-מהשרשרת
// (get_accounts + rc_api.find_rc_accounts) והשידור (delegate_vesting_shares
// אבסולוטי-ואידמפוטנטי) חיים-ב-index.ts, כמו-דפוס- soldier-drip/fleet-growth.
//
// חוקי-הבית:
//  · רצפת-האוצר-קודשת — האוצר-משאיר-לעצמו-לפחות- treasuryKeepPct% מה-vests-האפקטיביים.
//  · אין-גריעה-מחיילים — איזון-חד-כיווני: עודף→גרעון בלבד (delegate הוא-עזרה, לא-מס).
//  · כל-קלט-פגום → תוכנית-ריקה-עם-סיבה-כנה (דחייה-כברירת-מחדל).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { rcRebalancePlan, type RcAccountState } from './rc-rebalance'

const FLOOR = 2_000_000_000 // 2.000 VESTS — רצפת-הלידה (fleet-growth DELEGATE_VESTS_FALLBACK_RAW)

const acct = (name: string, effectiveVestsRaw: number, rcMana = effectiveVestsRaw, rcMax = rcMana): RcAccountState => ({
  name,
  effectiveVestsRaw,
  rcMana,
  rcMax,
})

describe('rcRebalancePlan — גרעונות-ועודפים (ליבה-טהורה)', () => {
  test('אין-גרעון-מעל-הרצפה → no-op מתועד-עם-סיבה (השער-הכנה — אפס-שידורים)', () => {
    const r = rcRebalancePlan({
      accounts: [acct('headcorner', 5_900_000_000_000), acct('saos-0001', FLOOR), acct('saos-0002', FLOOR + 1)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations).toHaveLength(0)
    expect(r.noOpReason).toBe('no-deficit-above-floor')
  })

  test('חייל-מתחת-לרצפה → הקצאה-אחת-מדויקת מהאוצר עד-הרצפה (לא-יותר)', () => {
    const r = rcRebalancePlan({
      accounts: [acct('headcorner', 5_900_000_000_000), acct('saos-0001', 500_000_000)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations).toEqual([
      { from: 'headcorner', to: 'saos-0001', vestsRaw: FLOOR - 500_000_000, reason: 'rc-deficit-topup' },
    ])
    expect(r.noOpReason).toBeNull()
  })

  test('ההקצאה-מוגבלת-לתקרה-הפר-חייל (נשק-מדוד — לא-מקלעת)', () => {
    const r = rcRebalancePlan({
      accounts: [acct('headcorner', 5_900_000_000_000), acct('saos-0001', 0)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: 1_000_000_000,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations[0]!.vestsRaw).toBe(1_000_000_000)
    expect(r.skipped.some((s) => s.includes('saos-0001') && s.includes('floor-unreached'))).toBe(true)
  })

  test('רצפת-האוצר-קודשת: עודף-מחושב-אחרי-שמירת- treasuryKeepPct% — אין-שריפת-רזרבה', () => {
    // אוצר-צנוע: 2.2e9 אפקטיבי; שמירה-90% → עודף 0.22e9 בלבד — התוכנית-חייבת-לכבד-אותו
    const r = rcRebalancePlan({
      accounts: [acct('headcorner', 2_200_000_000), acct('saos-0001', 0)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations[0]!.vestsRaw).toBe(220_000_000) // 10% מהאפקטיבי — הרזרבה-לא-נוגעת
    expect(r.skipped.some((s) => s.includes('floor-unreached'))).toBe(true)
  })

  test('אוצר-בלי-עודף-אמת (אבק-בלבד-מעל-הרצפה-הקודשת) → no-op כנה (אף-שידור, אף-גריעה)', () => {
    // אוצר-שבור: 0.05 VESTS — עודף-ה-10% שלו (5M) מתחת-לאבק-ההקצאה → אין-הקצאות-אבק
    const r = rcRebalancePlan({
      accounts: [acct('headcorner', 50_000_000), acct('saos-0001', 0)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations).toHaveLength(0)
    expect(r.noOpReason).toBe('treasury-surplus-empty')
  })

  test('הגרעון-הגדול-ראשון (דטרמיניזם), שוויון → שם-עולה; תקרת-פעימה-נאכפת', () => {
    const r = rcRebalancePlan({
      accounts: [
        acct('headcorner', 5_900_000_000_000),
        acct('saos-0003', 1_500_000_000), // גרעון 0.5e9
        acct('saos-0001', 1_000_000_000), // גרעון 1.0e9
        acct('saos-0002', 1_000_000_000), // גרעון 1.0e9 — שוויון-עם-0001 → 0001-קודם
        acct('saos-0004', FLOOR), // בריא — לא-נוגעים
      ],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 2,
    })
    expect(r.delegations.map((d) => d.to)).toEqual(['saos-0001', 'saos-0002']) // 0001-לפני-0002 (שם-עולה), 0003-נקטע-בתקרה
    expect(r.skipped.some((s) => s.includes('saos-0003') && s.includes('pulse-cap'))).toBe(true)
  })

  test('כנות-מלאה: מה-נשאר-מהגרעון אחרי-עודף-חלקי-מתועד-בסקיפים', () => {
    // עודף-אוצר 0.3e9 (אפקטיבי 3e9 × 10%); שני-גרעונות של 1e9 → הראשון-מקבל 0.3e9, השני-נשאר-בלי-כלום
    const r = rcRebalancePlan({
      accounts: [
        acct('headcorner', 3_000_000_000),
        acct('saos-0001', 1_000_000_000),
        acct('saos-0002', 1_000_000_000),
      ],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations).toEqual([
      { from: 'headcorner', to: 'saos-0001', vestsRaw: 300_000_000, reason: 'rc-deficit-topup' },
    ])
    expect(r.skipped.some((s) => s.includes('saos-0002') && s.includes('surplus-exhausted'))).toBe(true)
  })

  test('קלט-פגום: אוצר-לא-קיים-ברשימה / אין-חיילים / ערכים-לא-שלמים → דחייה-כנה-מיידית', () => {
    const bad1 = rcRebalancePlan({
      accounts: [acct('saos-0001', 0)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(bad1.noOpReason).toBe('treasury-missing')
    expect(bad1.delegations).toHaveLength(0)

    const bad2 = rcRebalancePlan({
      accounts: [acct('headcorner', 5_900_000_000_000)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(bad2.noOpReason).toBe('no-soldiers')

    const bad3 = rcRebalancePlan({
      accounts: [acct('headcorner', 5_900_000_000_000), acct('saos-0001', Number.NaN)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    })
    expect(bad3.noOpReason).toBe('invalid-account-data')
    expect(bad3.delegations).toHaveLength(0)
  })

  test('תקרה-הפר-חייל 0 או פעימה 0 → no-op (אפס-פעולה-מוגדר)', () => {
    const r = rcRebalancePlan({
      accounts: [acct('headcorner', 5_900_000_000_000), acct('saos-0001', 0)],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: 0,
      maxDelegationsPerPulse: 3,
    })
    expect(r.delegations).toHaveLength(0)
    expect(r.noOpReason).toBe('policy-allows-nothing')
  })

  test('דטרמיניזם: אותו-קלט → אותה-תוכנית-בדיוק (פעמיים)', () => {
    const inp = {
      accounts: [
        acct('headcorner', 5_900_000_000_000),
        acct('saos-0002', 100_000_000),
        acct('saos-0001', 100_000_000),
      ],
      treasury: 'headcorner',
      soldierFloorVestsRaw: FLOOR,
      treasuryKeepPct: 90,
      maxDelegatePerSoldierRaw: FLOOR,
      maxDelegationsPerPulse: 3,
    }
    expect(rcRebalancePlan(inp)).toEqual(rcRebalancePlan({ ...inp }))
  })
})
