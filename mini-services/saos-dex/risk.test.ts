// ═════════════════════════════════════════════════════════════════════════════
// risk.test.ts — ארון-הסיכונים האדפטיבי (Task-136 §1 — דירקטיבת-הבעלים) — TDD
// החוק-הישן: כל-מוטציית-כסף עוברת-את-השער לפני-החיוב; דחייה = אפס-שינוי-מצב.
// החוק-החדש (Task-136): אין-עצירות-מלאכותיות — השער אדפטיבי:
//   • תקרה-בודדת = אחוז-מעומק-הבריכה (צומחת-אוטומטית עם-הנזילות, לא מספר-קבוע)
//   • חלון = דלי-טוקנים מתמלא-רציף (HF לעולם לא נחנק על-ידי קיר-דקה)
//   • סטייה = עיגון-עצמי-חתום (עיגון-עוקב-מחיר-אמת), halt רק-על-אירוע-שלמות
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RISK,
  INTEGRITY_CEILING_BPS,
  depthSingleCapMu,
  driftBps,
  kellyFraction,
  kellySizeMu,
  preTradeGate,
  windowRefill,
  type GateInput,
  type RiskConfig,
  type RiskWindow,
} from './risk'

const CFG: RiskConfig = {
  windowCapMu: 250_000,
  windowMs: 60_000,
  singleCapPpm: 100_000, // 10% מעומק-צד-הכניסה
  maxDriftBps: 1_500,
  integrityCeilingBps: INTEGRITY_CEILING_BPS,
}

function freshBucket(lastMs = 1_000_000, availMu = CFG.windowCapMu): RiskWindow {
  return { lastMs, availMu }
}

// ── קלי (נשמר-מ-Tash-135: החוזה לא-השתנה) ────────────────────────────────────
describe('kellyFraction/kellySizeMu — מינוף-קלי דטרמיניסטי', () => {
  test('f*=(p(b+1)-1)/b — המתמטיקה המדויקת', () => {
    expect(kellyFraction(0.4, 2)).toBeCloseTo(0.1)
    expect(kellyFraction(0.6, 1)).toBeCloseTo(0.2)
    expect(kellyFraction(0.5, 1)).toBe(0)
  })
  test('תקרה (cap) נאכפת', () => {
    expect(kellyFraction(0.9, 5, 0.25)).toBe(0.25)
  })
  test('קלט-פסול → 0 (השולחן-לא-זורק, הוא-מצווה-אפס)', () => {
    expect(kellyFraction(NaN, 2)).toBe(0)
    expect(kellyFraction(0.5, -1)).toBe(0)
    expect(kellyFraction(1.5, 2)).toBe(0)
    expect(kellySizeMu(0.5, 1, 0)).toBe(0)
    expect(kellySizeMu(0.5, 1, -100)).toBe(0)
  })
  test('kellySizeMu — רצפה-לטובת-השולחן', () => {
    expect(kellySizeMu(0.6, 1, 1_000_000, 0.25)).toBe(200_000)
    expect(kellySizeMu(0.6, 1, 999_999, 0.25)).toBe(199_999) // floor
  })
})

describe('driftBps — מדידת-סטייה', () => {
  test('שני-הכיוונים |ערך|', () => {
    expect(driftBps(1_100, 1_000)).toBe(1_000)
    expect(driftBps(900, 1_000)).toBe(1_000)
  })
  test('קלט-לא-מדיד → null', () => {
    expect(driftBps(0, 1_000)).toBeNull()
    expect(driftBps(1_000, NaN)).toBeNull()
  })
})

// ── Task-136: תקרה-בודדת אדפטיבית לעומק ─────────────────────────────────────
describe('depthSingleCapMu — תקרה-צומחת-עם-הנזילות (לא-מספר-קבוע)', () => {
  test('10% מעומק-צד-הכניסה — רצפה-לטובת-הבריכה', () => {
    expect(depthSingleCapMu(15_613, 100_000)).toBe(1_561) // הבריכה-החיה של-Task-135
    expect(depthSingleCapMu(1_000_000, 100_000)).toBe(100_000)
    expect(depthSingleCapMu(999_999, 100_000)).toBe(99_999) // floor
  })
  test('התקרה-צומחת-אוטומטית כשהבריכה-מעמיקה — זהו-הלב-של-האדפטיביות', () => {
    const thin = depthSingleCapMu(15_000, 100_000)
    const deep = depthSingleCapMu(150_000, 100_000)
    expect(thin).toBe(1_500)
    expect(deep).toBe(15_000) // ×10 בדיוק — התקרה רודפת את העומק
  })
  test('קלט-פסול → 0 (אפס-זריקה; השער פשוט לא מאשר)', () => {
    expect(depthSingleCapMu(0, 100_000)).toBe(0)
    expect(depthSingleCapMu(-5, 100_000)).toBe(0)
    expect(depthSingleCapMu(1_000, NaN)).toBe(0)
    expect(depthSingleCapMu(1_000, 0)).toBe(0)
  })
  test('ברירת-מחדל: אין-מעבר-למחצה-מהעתודה גם ב-ppm גבוה (גג-שלמות)', () => {
    // גם אם ppm מוגדר 500k (50%), הפונקציה חוסמת מעל 250k (25%) — ניקוז-בהחלט-אחד-אסור
    expect(depthSingleCapMu(1_000, 500_000)).toBe(250)
  })
})

// ── Task-136: דלי-טוקנים — מילוי-רציף, HF לעולם לא נחנק ────────────────────
describe('windowRefill — דלי-טוקנים מתמלא-רציף', () => {
  test('מילוי-ליניארי: חצי-חלון → חצי-קיבולת', () => {
    const w = windowRefill({ lastMs: 0, availMu: 0 }, CFG, 30_000)
    expect(w.availMu).toBe(125_000)
    expect(w.lastMs).toBe(30_000)
  })
  test('מוגבל-לקיבולת — אין-צבירה-על-הגג', () => {
    const w = windowRefill({ lastMs: 0, availMu: 200_000 }, CFG, 60_000)
    expect(w.availMu).toBe(250_000)
  })
  test('זמן-נסוג (now<last) → אפס-מילוי, לא-חיובי', () => {
    const w = windowRefill({ lastMs: 10_000, availMu: 5 }, CFG, 5_000)
    expect(w.availMu).toBe(5)
    expect(w.lastMs).toBe(10_000)
  })
  test('קצב-קבוע: 250kµ/60s = 4,166µ/s — ספירת-עצימות-מדויקת', () => {
    const w = windowRefill({ lastMs: 0, availMu: 0 }, CFG, 1_000)
    expect(w.availMu).toBe(4_166) // floor(250000*1000/60000)
  })
})

// ── השער-המקדים האדפטיבי ─────────────────────────────────────────────────────
describe('preTradeGate v2 — סדר-חומרה: halt → קלט → תקרת-עומק → סטייה → דלי', () => {
  test('halt → 423, אפס-צריכה (דגל-שלמות נשאר)', () => {
    const v = preTradeGate({ amountInMu: 100, driftBps: null, reserveInMu: 1_000_000, halted: true, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(false)
    if (!v.allow) expect(v.httpStatus).toBe(423)
  })
  test('קלט-פסול → 400 אפס-צריכה', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      const v = preTradeGate({ amountInMu: bad as number, driftBps: null, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket())
      expect(v.allow).toBe(false)
      if (!v.allow) expect(v.httpStatus).toBe(400)
    }
  })
  test('תקרת-עומק: 10% מהעתודה — מעל-זה נדחה 429 עם-המדידה-בתשובה', () => {
    const v = preTradeGate({ amountInMu: 1_562, driftBps: null, reserveInMu: 15_613, halted: false, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(false)
    if (!v.allow) {
      expect(v.httpStatus).toBe(429)
      expect(v.reason).toContain('depth-cap')
      expect(v.reason).toContain('1561')
    }
  })
  test('תקרת-עומק אקטואלית על הבריכה-החיה: 1,561µ עובר', () => {
    const v = preTradeGate({ amountInMu: 1_561, driftBps: null, reserveInMu: 15_613, halted: false, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(true)
  })
  test('סטייה-רכה (≤maxDrift) → allow, reAnchor=false', () => {
    const v = preTradeGate({ amountInMu: 100, driftBps: 1_499, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(true)
    if (v.allow) expect(v.reAnchor).toBe(false)
  })
  test('סטייה-בינונית (maxDrift<drift≤integrity) → allow + reAnchor=true — עיגון-עצמי, אין-עצירה', () => {
    // ההנחיה: השוק ממשיך-לסחור; העוגן-עוקב-אחרי-מחיר-האמת-והריפוי-חתום-על-השרשרת
    const v = preTradeGate({ amountInMu: 100, driftBps: 3_000, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(true)
    if (v.allow) {
      expect(v.reAnchor).toBe(true)
      expect(v.driftBps).toBe(3_000)
    }
  })
  test('סטיית-שלמות (>integrityCeiling) → 423 — זהו-ניקוז, לא-גילוי-מחיר', () => {
    const v = preTradeGate({ amountInMu: 100, driftBps: INTEGRITY_CEILING_BPS + 1, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(false)
    if (!v.allow) {
      expect(v.httpStatus).toBe(423)
      expect(v.reason).toContain('integrity-drift')
    }
  })
  test('drift null (אין-מדידה) → allow, reAnchor=false (העוגן-ייקבע-בחיבור)', () => {
    const v = preTradeGate({ amountInMu: 100, driftBps: null, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(true)
    if (v.allow) expect(v.reAnchor).toBe(false)
  })
  test('דלי: צריכה מדויקת + דחיית-רוקן בלי-צריכה', () => {
    const v1 = preTradeGate({ amountInMu: 100, driftBps: null, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket(1_000, 150))
    expect(v1.allow).toBe(true)
    if (v1.allow) expect(v1.window.availMu).toBe(50)
    const v2 = preTradeGate({ amountInMu: 51, driftBps: null, reserveInMu: 1_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket(1_000, 50))
    expect(v2.allow).toBe(false)
    if (!v2.allow) expect(v2.httpStatus).toBe(429)
    if (!v2.allow) expect(v2.window.availMu).toBe(50) // אפס-צריכה בדחייה
  })
  test('HF לעולם לא נחנק: 20 החלפות-1kµ כל-250ms — כולן עוברות על דלי-ריק-בהתחלה', () => {
    // קצב-מילוי: 4,166µ/s; צריכה: 4×1kµ/s → נשארים-חיים לנצח
    let win = freshBucket(0, 0)
    for (let i = 0; i < 20; i++) {
      const now = (i + 1) * 250 // המדידה-הראשונה אחרי-250ms — לא על-ציר-האפס
      win = windowRefill(win, CFG, now)
      const v = preTradeGate({ amountInMu: 1_000, driftBps: null, reserveInMu: 1_000_000, halted: false, nowMs: now }, CFG, win)
      expect(v.allow).toBe(true)
      if (v.allow) win = v.window
    }
  })
  test('פיצוץ-פתאומי נשאר-חסום: 300kµ בבת-אחת > קיבולת-הדלי → 429 (מניעת-ניקוז-נפחי)', () => {
    const v = preTradeGate({ amountInMu: 300_000, driftBps: null, reserveInMu: 5_000_000, halted: false, nowMs: 1_000 }, CFG, freshBucket(1_000, 250_000))
    expect(v.allow).toBe(false)
    if (!v.allow) expect(v.httpStatus).toBe(429)
  })
  test('סדר-החומרה: halt קודם לקלט-פסול', () => {
    const v = preTradeGate({ amountInMu: -1, driftBps: null, reserveInMu: 1_000_000, halted: true, nowMs: 1_000 }, CFG, freshBucket())
    expect(v.allow).toBe(false)
    if (!v.allow) expect(v.reason).toBe('halted')
  })
  test('דטרמיניזם — אותם-קלטים → אותו-פסק-דין', () => {
    const a = preTradeGate({ amountInMu: 500, driftBps: 2_000, reserveInMu: 50_000, halted: false, nowMs: 7_777 }, CFG, freshBucket(1_000, 10_000))
    const b = preTradeGate({ amountInMu: 500, driftBps: 2_000, reserveInMu: 50_000, halted: false, nowMs: 7_777 }, CFG, freshBucket(1_000, 10_000))
    expect(a).toEqual(b)
  })
})

describe('DEFAULT_RISK — ברירות-המחדל-האדפטיביות', () => {
  test('התצורה-החדשה: ppm עומק + עיגון-רך + תקרת-שלמות; אין-עוד maxSingleSwapMu קבוע', () => {
    expect(DEFAULT_RISK.singleCapPpm).toBe(100_000) // 10%
    expect(DEFAULT_RISK.maxDriftBps).toBe(1_500)
    expect(DEFAULT_RISK.integrityCeilingBps).toBe(5_000)
    expect((DEFAULT_RISK as unknown as Record<string, unknown>).maxSingleSwapMu).toBeUndefined()
  })
  test('INTEGRITY_CEILING_BPS = 5,000bps (50%) — אירוע-שלמות בלבד', () => {
    expect(INTEGRITY_CEILING_BPS).toBe(5_000)
  })
})
