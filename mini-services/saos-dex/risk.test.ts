// ═════════════════════════════════════════════════════════════════════════════
// risk.test.ts — ארון-הסיכונים (saos-desk gate, הנחיית-בעלים §7.3/§2) — TDD
// החוק: כל-מוטציית-כסף עוברת-את-השער-לפני-החיוב; דחייה = אפס-שינוי-מצב.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RISK,
  driftBps,
  kellyFraction,
  kellySizeMu,
  preTradeGate,
  type GateInput,
  type RiskConfig,
  type RiskWindow,
} from './risk'

const CFG: RiskConfig = { windowCapMu: 250_000, windowMs: 60_000, maxSingleSwapMu: 100_000, maxDriftBps: 500 }

function freshWindow(startMs = 1_000_000): RiskWindow {
  return { startMs, usedMu: 0 }
}

describe('kellyFraction — מינוף-קלי דטרמיניסטי', () => {
  test('f*=(p(b+1)-1)/b — המתמטיקה המדויקת', () => {
    expect(kellyFraction(0.4, 2)).toBeCloseTo(0.1) // (0.4*3-1)/2
    expect(kellyFraction(0.6, 1)).toBeCloseTo(0.2) // (0.6*2-1)/1
    expect(kellyFraction(0.5, 1)).toBe(0) // אפס-קצה: אין-יתרון → אפס
  })
  test('תקרה (cap) נאכפת — השוק-אינו-קזינו', () => {
    expect(kellyFraction(0.9, 5, 0.25)).toBe(0.25) // f* גולמי=1.06 → מוגבל-ל-0.25
    expect(kellyFraction(0.6, 2, 0.15)).toBe(0.15) // f* גולמי=0.4 → מוגבל-ל-0.15
  })
  test('קלט-פסול → 0 (fail-closed, לא-זריקה)', () => {
    expect(kellyFraction(-0.1, 2)).toBe(0)
    expect(kellyFraction(1.1, 2)).toBe(0)
    expect(kellyFraction(NaN, 2)).toBe(0)
    expect(kellyFraction(0.5, 0)).toBe(0)
    expect(kellyFraction(0.5, -1)).toBe(0)
    expect(kellyFraction(0.5, Infinity)).toBe(0)
  })
})

describe('kellySizeMu — גודל-פוזיציה ב-µ שלמים', () => {
  test('רצפה-תמיד-לטובת-השולחן: אף-פעם לא מעגלים-מעלה', () => {
    expect(kellySizeMu(0.4, 2, 1_000)).toBe(100) // 1000×0.1
    expect(kellySizeMu(0.4, 2, 999)).toBe(99) // 99.9 → 99 (floor)
    expect(kellySizeMu(0.6, 1, 333)).toBe(66) // f(0.6,b=1)=0.2 → 66.6 → 66
  })
  test('קלט-פסול/יתרה-ריקה → 0', () => {
    expect(kellySizeMu(0.4, 2, 0)).toBe(0)
    expect(kellySizeMu(0.4, 2, -5)).toBe(0)
    expect(kellySizeMu(NaN, 2, 1_000)).toBe(0)
    expect(kellySizeMu(0.4, 2, NaN)).toBe(0)
  })
  test('הגודל לעולם אינו חורג מהיתרה-הפנויה', () => {
    const s = kellySizeMu(0.9, 5, 10_000, 0.25)
    expect(s).toBeLessThanOrEqual(10_000)
    expect(s).toBe(2_500) // cap 0.25 → 2500
  })
})

describe('preTradeGate — השער לפני-החיוב (fail-closed)', () => {
  const base = (over: Partial<GateInput> = {}): GateInput => ({
    amountInMu: 10_000,
    driftBps: null,
    halted: false,
    nowMs: 1_000_500,
    ...over,
  })

  test('halt → 423 ואפס-שינוי-חלון', () => {
    const win = freshWindow()
    const v = preTradeGate(base({ halted: true }), CFG, win)
    expect(v.allow).toBe(false)
    if (!v.allow) {
      expect(v.httpStatus).toBe(423)
      expect(v.reason).toBe('halted')
      expect(v.window).toBe(win) // אותו-אובייקט — לא נגענו
    }
  })

  test('סכום-פסול (0/שלילי/שבר/NaN) → 400', () => {
    for (const amountInMu of [0, -1, 1.5, NaN, Infinity]) {
      const v = preTradeGate(base({ amountInMu }), CFG, freshWindow())
      expect(v.allow).toBe(false)
      if (!v.allow) expect(v.httpStatus).toBe(400)
    }
  })

  test('תקרת-החלפה-בודדת → 429', () => {
    const v = preTradeGate(base({ amountInMu: 100_001 }), CFG, freshWindow())
    expect(v.allow).toBe(false)
    if (!v.allow) expect(v.reason).toBe('single-swap-cap')
  })

  test('סטיית-עתודות-מעבר-לסף → 423; סטייה-בתוך-הסף עוברת; null (אין-מדידה) עובר', () => {
    const over = preTradeGate(base({ driftBps: 501 }), CFG, freshWindow())
    expect(over.allow).toBe(false)
    if (!over.allow) expect(over.httpStatus).toBe(423)
    const under = preTradeGate(base({ driftBps: 500 }), CFG, freshWindow())
    expect(under.allow).toBe(true)
    const unmeasured = preTradeGate(base({ driftBps: null }), CFG, freshWindow())
    expect(unmeasured.allow).toBe(true)
  })

  test('תקרת-החלון: חריגה → 429 window-cap בלי-שינוי-מצב', () => {
    const win: RiskWindow = { startMs: 1_000_000, usedMu: 200_000 }
    const v = preTradeGate(base({ amountInMu: 50_001 }), CFG, win)
    expect(v.allow).toBe(false)
    if (!v.allow) {
      expect(v.reason).toBe('window-cap')
      expect(v.httpStatus).toBe(429)
      expect(v.window.usedMu).toBe(200_000) // לא נגענו
    }
  })

  test('היתר: חלון-מתמלא במדויק (usedMu += amount) — שלושה-צעדים-עד-התקרה', () => {
    const win = freshWindow()
    const v1 = preTradeGate(base({ amountInMu: 100_000 }), CFG, win)
    expect(v1.allow).toBe(true)
    if (!v1.allow) throw new Error('v1 חייב-לעבור')
    expect(v1.window.usedMu).toBe(100_000)
    const v2 = preTradeGate(base({ amountInMu: 100_000 }), CFG, v1.window)
    expect(v2.allow).toBe(true)
    if (!v2.allow) throw new Error('v2 חייב-לעבור')
    expect(v2.window.usedMu).toBe(200_000)
    const v3 = preTradeGate(base({ amountInMu: 50_000 }), CFG, v2.window)
    expect(v3.allow).toBe(true)
    if (!v3.allow) throw new Error('v3 חייב-לעבור')
    expect(v3.window.usedMu).toBe(250_000) // בדיוק-התקרה — עדיין-עובר
  })

  test('רוטציית-חלון: חלוף-windowMs מאפס את-התקרה', () => {
    const win: RiskWindow = { startMs: 1_000_000, usedMu: 250_000 }
    const v = preTradeGate(base({ amountInMu: 10_000, nowMs: 1_000_000 + CFG.windowMs }), CFG, win)
    expect(v.allow).toBe(true)
    if (v.allow) {
      expect(v.window.usedMu).toBe(10_000)
      expect(v.window.startMs).toBe(1_000_000 + CFG.windowMs)
    }
  })

  test('אינווריאנט-השער-קודם-לחיוב: דחיות-חוזרות לא משנות-שום-דבר', () => {
    const win = freshWindow()
    for (let i = 0; i < 5; i++) {
      const v = preTradeGate(base({ amountInMu: CFG.windowCapMu + 1 }), CFG, win)
      expect(v.allow).toBe(false)
    }
    expect(win.usedMu).toBe(0)
    expect(win.startMs).toBe(1_000_000)
  })
})

describe('driftBps — מדידת-סטיית-המחיר מעוגן-הזריעה', () => {
  test('+20% מחיר → 2000bps', () => {
    expect(driftBps(120_000, 100_000)).toBe(2_000)
  })
  test('-10% מחיר → 1000bps (סטייה-בכיוון-השני נמדדת באותה-מידה)', () => {
    expect(driftBps(90_000, 100_000)).toBe(1_000)
  })
  test('אותו-מחיר → 0', () => {
    expect(driftBps(120_000, 120_000)).toBe(0)
  })
  test('אין-מדידה (0/שלילי/NaN) → null — הקורא מחליט-כנה', () => {
    expect(driftBps(0, 100_000)).toBeNull()
    expect(driftBps(100_000, 0)).toBeNull()
    expect(driftBps(NaN, 100_000)).toBeNull()
    expect(driftBps(100_000, Infinity)).toBeNull()
  })
})

describe('DEFAULT_RISK — גדרות-ברירת-מחדל סניטיות', () => {
  test('הגדרות-ברירת-המחדל קיימות והגיוניות (µ-שלמים, חלון-חיובי)', () => {
    expect(DEFAULT_RISK.windowCapMu).toBeGreaterThan(0)
    expect(DEFAULT_RISK.windowMs).toBeGreaterThanOrEqual(1_000)
    expect(DEFAULT_RISK.maxSingleSwapMu).toBeGreaterThan(0)
    expect(DEFAULT_RISK.maxSingleSwapMu).toBeLessThanOrEqual(DEFAULT_RISK.windowCapMu)
    expect(DEFAULT_RISK.maxDriftBps).toBeGreaterThan(0)
  })
})
