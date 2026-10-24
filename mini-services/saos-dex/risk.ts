// ═════════════════════════════════════════════════════════════════════════════
// risk.ts — ארון-הסיכונים של השולחן (saos-desk pre-trade gate)
// הנחיית-בעלים §2/§7.3: "Route all order payloads through saos-desk pre-trade
// risk checks — deterministic position sizing, zero slippage stalls, fail-closed."
//
// טהור, דטרמיניסטי, µ-שלמים בלבד. אין-I/O, אין-שעון-פנימי (nowMs מוזרק),
// אין-מצב-גלובלי (החלון מוחזר-בתשובה) — כל-החלטה נבדקת-בדיקות (risk.test.ts).
//
// החוק-המרכזי: השער-קודם-לחיוב. דחייה = תשובה-מובנית + אפס-שינוי-מצב.
// סדר-הבדיקות = סדר-החומרה: halt → קלט-פסול → תקרה-בודדת → סטיית-עתודות → תקרת-חלון.
// ═════════════════════════════════════════════════════════════════════════════

export interface RiskConfig {
  /** תקרת-החלפות-מצטברת לחלון (µ של נכס-הכניסה) */
  windowCapMu: number
  /** אורך-החלון (ms) — חלון-מתגלגל נקבע-בתחילת-השימוש */
  windowMs: number
  /** תקרת-החלפה-בודדת (µ) */
  maxSingleSwapMu: number
  /** סטיית-מחיר-מרבית-מול-עוגן-הזריעה (bps) — מעבר = עצירה-כנה */
  maxDriftBps: number
}

// גדרות-ברירת-מחדל: חלון-דקה 250kµ; החלפה-בודדת עד 50kµ; סטייה-קריטית 5%.
// מאוזנים-מול-הבריכה-החיה (Task-134: 16k/1.92Mµ — תקרת-חלון 250kµ ≈ 13% מצד-ה-quote).
export const DEFAULT_RISK: RiskConfig = {
  windowCapMu: 250_000,
  windowMs: 60_000,
  maxSingleSwapMu: 50_000,
  maxDriftBps: 500,
}

export interface RiskWindow {
  startMs: number
  usedMu: number
}

export interface GateInput {
  amountInMu: number
  /** סטיית-המחיר-המדודה מעוגן-הזריעה (bps); null = אין-מדידה-כנה (מותר — נקבע-בחיבור) */
  driftBps: number | null
  halted: boolean
  nowMs: number
}

export type GateVerdict =
  | { allow: true; window: RiskWindow }
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

/** גודל-פוזיציה ב-µ שלמים: floor(free×f*) — הרצפה-תמיד-לטובת-השולחן. */
export function kellySizeMu(p: number, b: number, freeMu: number, capFrac = 0.25): number {
  if (!Number.isFinite(freeMu) || freeMu <= 0) return 0
  const f = kellyFraction(p, b, capFrac)
  if (f <= 0) return 0
  return Math.floor(freeMu * f)
}

// ── השער-המקדים ──────────────────────────────────────────────────────────────
// טהור לחלוטין: מקבל-חלון, מחזיר-פסק-דין + החלון-הבא. הדוחף מחויב-לאמץ
// את-החלון-המוחזר רק-אחרי-ביצוע-בפועל (הדחייה מחזירה-את-החלון-שלא-נגעו-בו).
export function preTradeGate(input: GateInput, cfg: RiskConfig, win: RiskWindow): GateVerdict {
  if (input.halted) return { allow: false, reason: 'halted', httpStatus: 423, window: win }
  const a = input.amountInMu
  if (!Number.isFinite(a) || a <= 0 || !Number.isInteger(a)) {
    return { allow: false, reason: 'bad-amount', httpStatus: 400, window: win }
  }
  if (a > cfg.maxSingleSwapMu) {
    return { allow: false, reason: 'single-swap-cap', httpStatus: 429, window: win }
  }
  if (input.driftBps !== null && input.driftBps > cfg.maxDriftBps) {
    return {
      allow: false,
      reason: `reserve-drift-${input.driftBps}bps-over-max-${cfg.maxDriftBps}bps`,
      httpStatus: 423,
      window: win,
    }
  }
  // רוטציית-חלון מתגלגלת: חלוף-האורך פותח-חלון-חדש-ריק
  const w: RiskWindow =
    input.nowMs - win.startMs >= cfg.windowMs
      ? { startMs: input.nowMs, usedMu: 0 }
      : win
  if (w.usedMu + a > cfg.windowCapMu) {
    return { allow: false, reason: 'window-cap', httpStatus: 429, window: w }
  }
  return { allow: true, window: { startMs: w.startMs, usedMu: w.usedMu + a } }
}

// ── מדידת-סטייה ──────────────────────────────────────────────────────────────
/** סטיית-המחיר-החי מעוגן-הזריעה ב-bps (בשני-הכיוונים — |ערך|). אין-מדידה → null. */
export function driftBps(currentPriceMu: number, anchorPriceMu: number): number | null {
  if (
    !Number.isFinite(currentPriceMu) || !Number.isFinite(anchorPriceMu) ||
    currentPriceMu <= 0 || anchorPriceMu <= 0
  ) {
    return null
  }
  return Math.round(Math.abs((currentPriceMu - anchorPriceMu) / anchorPriceMu) * 10_000)
}
