// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/spread.test — לכידת-מיקרו-פרשים דטרמיניסטית (Task-141-b — הנחיה §2/§4, TDD)
// ═════════════════════════════════════════════════════════════════════════════
// החוק: היד (amm-loop) מחליפה סביב ה-fair רק-כשהעסקה רווחית-אחרי-עמלה-אמת
// (feeMu ≥ 1µ ורווח ≥ 1µ — אפס-מסחר-מזויף, אפס-תרומת-עמלות-נסתרת).
// כל-החלטה טהורה, שלמה-ב-µ, ודטרמיניסטית — אותם-קלטים → אותה-החלטה.
// תרחיש-החי-נעול-כבדיקה: בריכה-בזרע-המתועד (100_000) מול-ספר-חי (100_400) = 40bps
// → פסוק-רווח שלילי בגרנולריות-ה-µ → המתנה-כנה (אין-ירי-מזויף).
// הרצה: bun test mini-services/saos-dex/spread.test.ts
import { describe, expect, test } from 'bun:test'
import { quoteSwap, seedPool, type Pool } from './amm'
import {
  DEFAULT_SPREAD,
  FEE_FLOOR_INPUT_MU,
  captureDueMs,
  captureStep,
  minInputForFeeMu,
  poolPriceMuOf,
  swapFillPriceMu,
  type HandFunds,
} from './spread'

const HAND_FULL: HandFunds = { freeQuoteMu: 530_000, freeBaseMu: 5_000_000 }

// בריכה-חיה-בקנה-מידה של-הלדגר: SAOS בזרע 100_000 (µ-quote ליחידת-בסיס-שלמה)
function saosSeedPool(): Pool {
  return seedPool('SAOS', 'USDS', 900_000, 90_000, 30) // px = 100_000
}

describe('spread — עזרי-יחידות (fee-floor, מחיר-בריכה, מחיר-מילוי)', () => {
  test('minInputForFeeMu: קלט-מזער לעמלה ≥1µ ב-30bps = 334µ (ceil(10_000/30))', () => {
    expect(minInputForFeeMu(30, 1)).toBe(334)
    expect(FEE_FLOOR_INPUT_MU).toBe(334) // הקבוע-החתום לברירת-המחדל
    expect(minInputForFeeMu(30, 2)).toBe(667)
    expect(minInputForFeeMu(0, 1)).toBe(Number.POSITIVE_INFINITY) // בריכת-אפס-עמלה = אין-לכידה
  })
  test('poolPriceMuOf: סקאלת-הספר (µ-quote ליחידת-בסיס-שלמה) — זהה-ל-fair של-הספר', () => {
    expect(poolPriceMuOf(saosSeedPool())).toBe(100_000)
    expect(poolPriceMuOf(seedPool('WSBD', 'USDS', 450_000, 450_000, 30))).toBe(1_000_000)
  })
  test('swapFillPriceMu: baseToQuote — הנוסחה-הקיימת (out×1e6/in)', () => {
    expect(swapFillPriceMu('baseToQuote', 10_000, 987_158)).toBe(98_715_800)
  })
  test('swapFillPriceMu: quoteToBase — תיקון-יחידות (היה out/in → מחיר-זבל; עתה in/out×1e6)', () => {
    // קנייה: שילם 1_000_000 µ-quote, קיבל 9_871 µ-base → מחיר ליחידה-שלמה = 101_306_858
    expect(swapFillPriceMu('quoteToBase', 1_000_000, 9_871)).toBe(101_306_858)
    // הישן היה מחזיר floor(9_871×1e6/1_000_000)=9 — פי-מיליון-שקר
  })
  test('swapFillPriceMu: קלט-לא-תקין → 0 (fail-closed, לא-זריקה)', () => {
    expect(swapFillPriceMu('baseToQuote', 0, 100)).toBe(0)
    expect(swapFillPriceMu('quoteToBase', 100, 0)).toBe(0)
    expect(swapFillPriceMu('quoteToBase', -5, 100)).toBe(0)
  })
})

describe('spread — captureStep: ירי-רק-על-רווח-אמת-אחרי-עמלה', () => {
  test('יורה quoteToBase כשהבריכה מתחת-ל-fair בסטייה-שעוברת-עמלה+החלקה (148bps יחסית-ל-fair)', () => {
    const pool = saosSeedPool()
    const d = captureStep(pool, 101_500, HAND_FULL)
    expect(d.action).toBe('quoteToBase')
    expect(d.amountInMu).toBe(334) // מדרגה-ראשונה = מינימום-עמלה — פגיעה-מזערית-בבריכה
    expect(d.expectedOutMu).toBe(3_317) // floor(900_000×333/90_333)
    expect(d.expectedFeeMu).toBe(1)
    expect(d.expectedProfitMu).toBe(2) // floor(3317×101_500/1e6)=336 − 334
    expect(d.driftBps).toBe(148) // |101_500−100_000|/101_500 ≈ 1.478% → 148bps
  })
  test('יורה baseToQuote כשהבריכה מעל-ה-fair והיד מחזיקה-בסיס (513bps)', () => {
    const pool = seedPool('SAOS', 'USDS', 900_000, 95_000, 30) // px=105_555
    const d = captureStep(pool, 100_400, HAND_FULL)
    expect(d.action).toBe('baseToQuote')
    expect(d.amountInMu).toBe(334)
    expect(d.expectedOutMu).toBe(35) // floor(95_000×333/900_333)
    expect(d.expectedFeeMu).toBe(1)
    expect(d.expectedProfitMu).toBe(2) // 35 − floor(334×100_400/1e6)=33
  })
  test('תרחיש-החי-נעול: סטיית-40bps (זרע 100_000 מול-ספר 100_400) = הפסד-גרנולריות → המתנה-כנה', () => {
    const pool = saosSeedPool()
    const d = captureStep(pool, 100_400, HAND_FULL)
    expect(d.action).toBe('idle')
    expect(d.reason).toMatch(/edge-below-costs/)
    expect(d.amountInMu).toBe(0)
    expect(d.driftBps).toBe(40)
  })
  test('רווח-אפס-אינו-ירי (minProfitMu מחייב-קפדן): drift שבו value=in בדיוק', () => {
    const pool = saosSeedPool()
    // fair=100_800: floor(3317×0.1008)=334 = הקלט → רווח 0 → אין-ירי
    const d = captureStep(pool, 100_800, HAND_FULL)
    expect(d.action).toBe('idle')
    expect(d.reason).toMatch(/edge-below-costs/)
  })
  test('בריכה-על-ה-fair בדיוק → idle at-fair (אפס-מסחר-סרק)', () => {
    const d = captureStep(saosSeedPool(), 100_000, HAND_FULL)
    expect(d.action).toBe('idle')
    expect(d.reason).toBe('at-fair')
  })
  test('אין-מחיר-fair (ספר-ריק ואין-זרע) → idle no-measurable-price', () => {
    expect(captureStep(saosSeedPool(), null, HAND_FULL).reason).toBe('no-measurable-price')
  })
  test('יד-יבשה (אפס-יתרה-חופשית) → idle hand-dry בשני-הכיוונים', () => {
    const dry = { freeQuoteMu: 0, freeBaseMu: 0 }
    expect(captureStep(saosSeedPool(), 101_500, dry).reason).toBe('hand-dry')
    const dearPool = seedPool('SAOS', 'USDS', 900_000, 95_000, 30)
    expect(captureStep(dearPool, 100_400, dry).reason).toBe('hand-dry')
  })
  test('היד-מחזיקה-בסיס-אפס → baseToQuote נפסל-כן (hand-dry), לא-ממציאים-מלאי', () => {
    const dearPool = seedPool('SAOS', 'USDS', 900_000, 95_000, 30)
    const noBase: HandFunds = { freeQuoteMu: 530_000, freeBaseMu: 0 }
    expect(captureStep(dearPool, 100_400, noBase).reason).toBe('hand-dry')
  })
  test('בריכה-רזה-מדי לעמלת-מזער (PHIVE בן-4_500µ-quote): slip-cap < 334µ → idle too-thin', () => {
    const thin = seedPool('PHIVE', 'USDS', 450_000, 4_500, 30)
    const d = captureStep(thin, 10_300, HAND_FULL) // סטייה-300bps — ועדיין אין-ירי
    expect(d.action).toBe('idle')
    expect(d.reason).toMatch(/too-thin/)
  })
  test('בריכת-אפס-עמלה → idle fee-zero (אין-מה-ללכוד — כנות)', () => {
    const free = seedPool('SAOS', 'USDS', 900_000, 90_000, 0)
    expect(captureStep(free, 101_500, HAND_FULL).reason).toBe('fee-zero-no-capture')
  })
  test('התקרות נאכפות: גודל-הירי ≤ slip-cap ו-≤ יתרת-היד', () => {
    const pool = saosSeedPool()
    const poorHand: HandFunds = { freeQuoteMu: 400, freeBaseMu: 0 }
    const d = captureStep(pool, 101_500, poorHand)
    expect(d.action).toBe('quoteToBase')
    expect(d.amountInMu).toBe(334) // ≤ 400 — היתרה-כן
    expect(d.amountInMu).toBeLessThanOrEqual(Math.floor((pool.reserveQuoteMu * DEFAULT_SPREAD.maxSlipBps) / 10_000))
  })
  test('דטרמיניזם: אותם-קלטים → אותה-החלטה-מילה-במילה; הבריכה-לא-נפגעת (טהור)', () => {
    const pool = saosSeedPool()
    const before = { ...pool }
    const a = captureStep(pool, 101_500, HAND_FULL)
    const b = captureStep(pool, 101_500, HAND_FULL)
    expect(a).toEqual(b)
    expect(pool).toEqual(before) // אפס-מוטציה — ההחלטה-לא-מבצעת
  })
  test('עקביות-פנימית: expectedOut זהה-ל-quoteSwap על אותו-מצב-בריכה', () => {
    const pool = saosSeedPool()
    const d = captureStep(pool, 101_500, HAND_FULL)
    const q = quoteSwap(pool, 'quoteToBase', d.amountInMu)
    expect(d.expectedOutMu).toBe(q.outMu)
    expect(d.expectedFeeMu).toBe(q.feeMu)
  })
})

// ── Task-141-b: שער-הפעימה-העצלה — רקע: bun --hot 1.3.14 אינו-מניח-ל-setInterval
// לנקום (נמדד-חי 26/10 15:43–15:53: ticks=0 למשך-שעות-למרות-טיימר-חד-טרי-בכל-טעינה).
// הפעימה עתה נורת-עצלות-מכל-בקשת-HTTP; השער-הזה הוא-החוק-הדטרמיניסטי-שלה. ──
describe('spread — captureDueMs: שער-פעימה-עצלה (Task-141-b, דטרמיניסטי)', () => {
  test('מגיעה-פעימה כשחלפו ≥ everyMs; לא-מגיעה כשחלפו פחות', () => {
    expect(captureDueMs(15_000, 0, 15_000)).toBe(true) // הפעימה-הראשונה: lastTick=0
    expect(captureDueMs(14_999, 0, 15_000)).toBe(false)
    expect(captureDueMs(30_000, 15_000, 15_000)).toBe(true)
    expect(captureDueMs(29_999, 15_000, 15_000)).toBe(false)
    expect(captureDueMs(1_000_000, 999_999, 15_000)).toBe(false)
  })
  test('קלט-פסול → לא-מגיעה-פעימה (fail-closed: אין-פעימה על-קלט-לא-מדוד)', () => {
    expect(captureDueMs(Number.NaN, 0, 15_000)).toBe(false)
    expect(captureDueMs(15_000, Number.NaN, 15_000)).toBe(false)
    expect(captureDueMs(15_000, 0, 0)).toBe(false)
    expect(captureDueMs(15_000, 0, -1)).toBe(false)
    expect(captureDueMs(Number.POSITIVE_INFINITY, 0, 15_000)).toBe(false)
  })
  test('דטרמיניזם: אותם-קלטים → אותה-החלטה; אפס-מצב-פנימי (טהור)', () => {
    expect(captureDueMs(45_000, 30_000, 15_000)).toBe(captureDueMs(45_000, 30_000, 15_000))
    expect(captureDueMs(45_000, 30_000, 15_000)).toBe(true)
  })
})
