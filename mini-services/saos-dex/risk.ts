// ═════════════════════════════════════════════════════════════════════════════
// risk.ts — ארון-הסיכונים האדפטיבי של השולחן (saos-desk pre-trade gate)
// Task-135 §2/§7.3: "Route all order payloads through saos-desk pre-trade risk
// checks — deterministic position sizing, zero slippage stalls, fail-closed."
// Task-136 §1 (דירקטיבת-הבעלים): "PURGE artificial execution stalls and
// hardcoded risk limits that freeze trading" — השער מתפקח-מעצורים:
//
//   ישן (קפיאה):  תקרה-בודדת קבועה · חלון-קשיח-דקתי · סטייה → halt-מלא
//   חדש (אדפטיבי): תקרה=%-מעומק (צומחת-עם-הבריכה) · דלי-טוקנים-רציף (HF חי)
//                   סטייה-רכה → עיגון-עצמי-חתום · halt רק-על-אירוע-שלמות
//
// השלמות-הכשלונית נשארת: חתימות, אימות-שרשרת, minOut (מגן-חלקה), auth —
// אלו לא "מגבלות-סיכון", אלו עצם-היות-הכסף-אמיתי. מה-שהוסר: הקפאות.
//
// טהור, דטרמיניסטי, µ-שלמים בלבד. אין-I/O, אין-שעון-פנימי (nowMs מוזרק),
// אין-מצב-גלובלי — כל-החלטה נבדקת-בדיקות (risk.test.ts).
// ═════════════════════════════════════════════════════════════════════════════

export interface RiskConfig {
  /** קיבולת-דלי-החלון (µ) — גג-פיצוץ-נפחי פתאומי */
  windowCapMu: number
  /** אורך-החלון (ms) — קצב-המילוי = windowCapMu/windowMs (רציף, לא-קיר) */
  windowMs: number
  /** תקרת-החלפה-בודדת ב-ppm מעומק-צד-הכניסה (100_000 = 10%) — צומחת-עם-הנזילות */
  singleCapPpm: number
  /** סטייה-רכה (bps) — מעבר = המשך-מסחר + עיגון-עצמי-חתום (לא halt) */
  maxDriftBps: number
  /** תקרת-שלמות (bps) — מעבר = אירוע-ניקוז-אמת → 423 (הגנה-יחידה-שנשארת) */
  integrityCeilingBps: number
}

// גדרות-ברירת-מחדל (Task-136): דלי 250kµ/דקה (4,166µ/s רציף); תקרה-בודדת 10%-עומק;
// עיגון-עצמי מעל 1500bps; שלמות מעל 5000bps (50% בחלון-אחד = ניקוז, לא-גילוי-מחיר).
export const DEFAULT_RISK: RiskConfig = {
  windowCapMu: 250_000,
  windowMs: 60_000,
  singleCapPpm: 100_000,
  maxDriftBps: 1_500,
  integrityCeilingBps: 5_000,
}

/** תקרת-השלמות הגלובלית — מעבר-50%-בחלון-אחד הוא אירוע-שרשרתי, לא-שוק. */
export const INTEGRITY_CEILING_BPS = 5_000

/**
 * תקרת-החלפה-הבודדת האדפטיבית: floor(עומק-צד-הכניסה × ppm/1e6),
 * גג-שלמות 25% מהעתודה גם אם ppm מבקש-יותר (ניקוז-במחצית אסור בוודאות).
 * קלט-פסול → 0 (השער לא זורק — הוא פשוט לא מאשר).
 */
export function depthSingleCapMu(reserveInMu: number, singleCapPpm: number): number {
  if (
    !Number.isSafeInteger(reserveInMu) || reserveInMu <= 0 ||
    !Number.isFinite(singleCapPpm) || singleCapPpm <= 0
  ) {
    return 0
  }
  const raw = Math.floor((reserveInMu * singleCapPpm) / 1_000_000)
  const hardCap = Math.floor(reserveInMu / 4) // גג-שלמות: 25% מהעתודה במחצית
  return Math.min(raw, hardCap)
}

/** דלי-טוקנים: availMu מתמלא בקצב windowCapMu/windowMs עד-הגג. */
export interface RiskWindow {
  lastMs: number
  availMu: number
}

export function windowRefill(win: RiskWindow, cfg: RiskConfig, nowMs: number): RiskWindow {
  if (!Number.isFinite(nowMs) || nowMs <= win.lastMs) return { lastMs: win.lastMs, availMu: win.availMu }
  const gained = Math.floor(((nowMs - win.lastMs) * cfg.windowCapMu) / cfg.windowMs)
  const avail = Math.min(cfg.windowCapMu, win.availMu + gained)
  return { lastMs: nowMs, availMu: avail }
}

export interface GateInput {
  amountInMu: number
  /** סטיית-המחיר-המדודה מהעוגן (bps); null = אין-מדידה-כנה (העוגן ייקבע בחיבור) */
  driftBps: number | null
  /** עומק-צד-הכניסה בבריכה (µ) — ממנו נגזרת התקרה-הבודדת */
  reserveInMu: number
  halted: boolean
  nowMs: number
}

export type GateVerdict =
  | { allow: true; window: RiskWindow; reAnchor: boolean; driftBps: number | null }
  | { allow: false; reason: string; httpStatus: number; window: RiskWindow }

// ── קלי-קריטריון — מינוף-גודל-דטרמיניסטי ────────────────────────────────────
// f* = (p·(b+1) − 1) / b, נקשר-ל-[0, cap]. קלט-פסול → 0 (לא-זריקה: השולחן
// לעולם לא מסרב לחשב — הוא פשוט מצווה על אפס).
export function kellyFraction(p: number, b: number, cap = 0.25): number {
  if (
    !Number.isFinite(p) || !Number.isFinite(b) || !Number.isFinite(cap) ||
    p < 0 || p > 1 || b <= 0 || cap <= 0
  ) {
    return 0
  }
  const f = (p * (b + 1) - 1) / b
  if (!Number.isFinite(f) || f <= 0) return 0
  return Math.min(f, cap)
}

/** גודל-פוזיציה ב-µ שלמים: floor(free×f*) — הרצפה-תמיד-לטובת-השולחן.
 * ה-epsilon (1e-9) מרפא ארטיפקט-float בלבד: f*=(0.6·2−1)=0.19999999999999996
 * במקום 0.2 המתמטי — בלי-הריפוי floor(1e6·f*) גונב 1µ מהסוחר. דטרמיניסטי. */
export function kellySizeMu(p: number, b: number, freeMu: number, capFrac = 0.25): number {
  if (!Number.isFinite(freeMu) || freeMu <= 0) return 0
  const f = kellyFraction(p, b, capFrac)
  if (f <= 0) return 0
  return Math.floor(freeMu * f + 1e-9)
}

// ── השער-המקדים האדפטיבי ─────────────────────────────────────────────────────
// סדר-החומרה: halt(שלמות) → קלט-פסול → תקרת-עומק → סטייה(עיגון-עצמי) → דלי.
// דחייה = תשובה-מובנית + הדלי-שלא-נגעו-בו. הדוחף מחויב-לאמץ את-הדלי-המוחזר
// רק-אחרי-ביצוע-בפועל. reAnchor=true ⇒ החיבור מעגן-מחדש-למחיר-הנמדד
// ורושם-קבלת-שולחן-חתומה-על-השרשרת (העיגון-עוקב-אחרי-האמת, המסחר-לא-נעצר).
export function preTradeGate(input: GateInput, cfg: RiskConfig, win: RiskWindow): GateVerdict {
  if (input.halted) return { allow: false, reason: 'halted', httpStatus: 423, window: win }
  const a = input.amountInMu
  if (!Number.isFinite(a) || a <= 0 || !Number.isInteger(a)) {
    return { allow: false, reason: 'bad-amount', httpStatus: 400, window: win }
  }
  const singleCap = depthSingleCapMu(input.reserveInMu, cfg.singleCapPpm)
  if (singleCap <= 0 || a > singleCap) {
    return {
      allow: false,
      reason: `depth-cap: ${a}µ-over-singleCap-${singleCap}µ`,
      httpStatus: 429,
      window: win,
    }
  }
  if (input.driftBps !== null) {
    if (input.driftBps > cfg.integrityCeilingBps) {
      return {
        allow: false,
        reason: `integrity-drift: ${input.driftBps}bps-מעל-תקרת-השלמות-${cfg.integrityCeilingBps}bps`,
        httpStatus: 423,
        window: win,
      }
    }
    if (input.driftBps > cfg.maxDriftBps) {
      // עיגון-עצמי: המסחר-ממשיך; העוגן-יעודכן-למחיר-האמת-בחיבור-עם-קבלה-חתומה
      const w = windowRefill(win, cfg, input.nowMs)
      if (w.availMu < a) {
        return { allow: false, reason: 'bucket-empty', httpStatus: 429, window: w }
      }
      return { allow: true, window: { lastMs: w.lastMs, availMu: w.availMu - a }, reAnchor: true, driftBps: input.driftBps }
    }
  }
  const w = windowRefill(win, cfg, input.nowMs)
  if (w.availMu < a) {
    return { allow: false, reason: 'bucket-empty', httpStatus: 429, window: w }
  }
  return { allow: true, window: { lastMs: w.lastMs, availMu: w.availMu - a }, reAnchor: false, driftBps: input.driftBps }
}

// ── מדידת-סטייה ──────────────────────────────────────────────────────────────
/** סטיית-המחיר-החי מהעוגן ב-bps (בשני-הכיוונים — |ערך|). אין-מדידה → null. */
export function driftBps(currentPriceMu: number, anchorPriceMu: number): number | null {
  if (
    !Number.isFinite(currentPriceMu) || !Number.isFinite(anchorPriceMu) ||
    currentPriceMu <= 0 || anchorPriceMu <= 0
  ) {
    return null
  }
  return Math.round(Math.abs((currentPriceMu - anchorPriceMu) / anchorPriceMu) * 10_000)
}
