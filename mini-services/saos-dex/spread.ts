// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/spread — לכידת-מיקרו-פרשים (Task-141-b — הנחיה §2/§4, TDD)
// ═════════════════════════════════════════════════════════════════════════════
// שלב-החלטה-בודד, טהור ודטרמיניסטי: כשמחיר-הבריכה סוטה מה-fair של הספר
// (מחצי-הספר / הצעד-הטוב / הזרע-המתועד), היד (amm-loop) בוחנת החלפה שמושכת
// את הבריכה חזרה אל ה-fair — ויורה רק-אם העסקה רווחית-אחרי-עמלה-אמת:
//
//  S1 feeMu ≥ feeFloorMu (ברירת-מחדל 1µ) — לכידת-עמלה-אמת, לא-אבק-עיגול
//  S2 רווח-צף ≥ minProfitMu (ברירת-מחדל 1µ) — רווח נמדד ב-µ שלמים מול-שווי-fair
//  S3 גודל-מדרגה עולה (334µ×2^k) — פגיעה-מזערית-בבריכה; המדרגה-הקטנה-הרווחית-ראשונה
//  S4 תקרות: יתרת-היד · maxFractionPpm מעתודת-הכניסה · maxSlipBps (החלקה≈קלט/עתודה)
//  S5 אפס-מוטציה: ההחלטה מצטטת quoteSwap טהור; הביצוע-בידי-הקורא (runAmmSwap)
//  S6 כנות: idle תמיד עם סיבה-מדודה (אין-ירי-מזויף, אין-המצאת-רווח)
//
// סקאלות (מיושרות-לספר-החי): מחיר-בריכה = floor(rq×1e6/rb) = µ-quote ליחידת-בסיס-
// שלמה — בדיוק-סקאלת priceMu של פקודות-הספר (need=amount×price) ושל fair ב-marketView.
import { quoteSwap, type Pool } from './amm'

export interface SpreadConfig {
  /** רווח-מזערי מחייב לירי (µ) — קפדן: 1µ */
  minProfitMu: number
  /** עמלת-מזער לכידה אמת (µ) — מתחת לזה אין-לכידה, רק-אבק-עיגול */
  feeFloorMu: number
  /** תקרת-החלקה לטרייד-בודד (bps) — גודל ≤ עתודת-כניסה×bps/10_000 */
  maxSlipBps: number
  /** גודל-מקס כשבר-מעומק-צד-הכניסה (ppm; 100_000 = 10% — זהה-לשער-הסיכונים) */
  maxFractionPpm: number
  /** מספר-מדרגות-הגודל העולות (334µ×2^k) */
  ladderSteps: number
}

export const DEFAULT_SPREAD: SpreadConfig = {
  minProfitMu: 1,
  feeFloorMu: 1,
  maxSlipBps: 100,
  maxFractionPpm: 100_000,
  ladderSteps: 10,
}

/** הקבוע-החתום: קלט-מזער לעמלה ≥1µ ב-30bps = ceil(10_000/30) = 334µ */
export const FEE_FLOOR_INPUT_MU = 334

/** שער-הפעימה-העצלה (Task-141-b): האם מגיעה-פעימת-לכידה עתה?
 * טהור-ודטרמיניסטי: נכון-רק-כשחלפו ≥ everyMs מאז-הפעימה-הקודמת. קלט-פסול → לא-מגיעה
 * (fail-closed: לעולם לא מוסיפים-פעימה על-קלט-לא-מדוד). רקע-המדידה: bun --hot 1.3.14
 * אינו-מניח-ל-setInterval לנקם-כלל (נמדד-חי 26/10: ticks=0 למשך-שעות) → הפעימה
 * נורת-עצלות-מכל-בקשת-HTTP דרך-השער-הזה. */
export function captureDueMs(nowMs: number, lastTickMs: number, everyMs: number): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastTickMs) || !Number.isFinite(everyMs) || everyMs <= 0)
    return false
  return nowMs - lastTickMs >= everyMs
}

/** קלט-המזער שעבורו feeMu ≥ feeFloorMu; בריכת-אפס-עמלה → ∞ (אין-לכידה). */
export function minInputForFeeMu(feeBps: number, feeFloorMu: number): number {
  if (!Number.isSafeInteger(feeBps) || feeBps <= 0 || !Number.isSafeInteger(feeFloorMu) || feeFloorMu <= 0)
    return Number.POSITIVE_INFINITY
  return Math.ceil((feeFloorMu * 10_000) / feeBps)
}

/** מחיר-הבריכה בסקאלת-הספר: µ-quote ליחידת-בסיס-שלמה; אין-מדידה → null. */
export function poolPriceMuOf(pool: Pool): number | null {
  return pool.reserveBaseMu > 0 ? Math.floor((pool.reserveQuoteMu * 1_000_000) / pool.reserveBaseMu) : null
}

/** סטיית-המחיר-המדודה מה-fair ב-bps (|ערך|, יחסית-ל-fair — כמו driftBps של risk.ts). */
export function driftFromFairBps(px: number, fairMu: number): number | null {
  if (!Number.isFinite(px) || !Number.isFinite(fairMu) || px <= 0 || fairMu <= 0) return null
  return Math.round(Math.abs((px - fairMu) / fairMu) * 10_000)
}

/**
 * מחיר-המילוי-החתום-בפנקס-המילויים — µ-quote ליחידת-בסיס-שלמה, בשני-הכיוונים.
 * תיקון-יחידות (Task-141-b): quoteToBase (קניית-בסיס-מהבריכה) הישן רשם out/in —
 * מחיר-הפוך-משמעותית (פי-מיליון); עתה in/out×1e6 — מחיר-אמת ליחידה-שלמה.
 */
export function swapFillPriceMu(direction: 'baseToQuote' | 'quoteToBase', amountInMu: number, outMu: number): number {
  if (!Number.isSafeInteger(amountInMu) || amountInMu <= 0 || !Number.isSafeInteger(outMu) || outMu <= 0) return 0
  return direction === 'baseToQuote'
    ? Math.floor((outMu * 1_000_000) / amountInMu) // µ-quote-החוצה ל-µ-בסיס-הנכנס → ×1e6
    : Math.floor((amountInMu * 1_000_000) / outMu) // µ-quote-הנכנס ל-µ-בסיס-היוצא → ×1e6
}

export interface HandFunds {
  freeQuoteMu: number
  freeBaseMu: number
}

export interface CaptureDecision {
  action: 'quoteToBase' | 'baseToQuote' | 'idle'
  reason: string // כנות: מדוע ירי/המתנה — נחתם-בלוג וב-/health
  driftBps: number | null
  amountInMu: number
  expectedOutMu: number
  expectedFeeMu: number
  expectedProfitMu: number
}

const idle = (reason: string, driftBps: number | null = null): CaptureDecision => ({
  action: 'idle',
  reason,
  driftBps,
  amountInMu: 0,
  expectedOutMu: 0,
  expectedFeeMu: 0,
  expectedProfitMu: 0,
})

/**
 * שלב-הלכידה: החלטה-אחת על בריכה-אחת. טהור, שלם-ב-µ, דטרמיניסטי (S6).
 * ירי רק כשקיימת מדרגה (S3) שבה הרווח-מול-שווי-fair חיובי-אחרי-עמלה (S1/S2)
 * ובתוך-כל-התקרות (S4). אחרת — idle עם המדידה-הכנה שסותרת-את-הירי.
 */
export function captureStep(
  pool: Pool,
  fairMu: number | null,
  hand: HandFunds,
  cfg: SpreadConfig = DEFAULT_SPREAD,
): CaptureDecision {
  const px = poolPriceMuOf(pool)
  if (px === null || fairMu === null || !Number.isSafeInteger(fairMu) || fairMu <= 0)
    return idle('no-measurable-price')
  const drift = driftFromFairBps(px, fairMu)
  if (pool.feeBps <= 0) return idle('fee-zero-no-capture', drift) // S1: אין-עמלה = אין-מה-ללכוד
  if (px === fairMu) return idle('at-fair', 0)
  const toBase = px < fairMu // בסיס-זול-בבריכה → קונים-בסיס; יקר → מוכרים
  const direction: 'quoteToBase' | 'baseToQuote' = toBase ? 'quoteToBase' : 'baseToQuote'
  const reserveInMu = toBase ? pool.reserveQuoteMu : pool.reserveBaseMu
  const balanceInMu = toBase ? hand.freeQuoteMu : hand.freeBaseMu
  if (!Number.isSafeInteger(balanceInMu) || balanceInMu <= 0) return idle('hand-dry', drift)
  const minInput = minInputForFeeMu(pool.feeBps, cfg.feeFloorMu)
  const fractionCap = Math.floor((reserveInMu * cfg.maxFractionPpm) / 1_000_000)
  const slipCap = Math.floor((reserveInMu * cfg.maxSlipBps) / 10_000)
  const capMu = Math.min(balanceInMu, fractionCap, slipCap)
  if (!Number.isFinite(minInput) || minInput > capMu)
    return idle(minInput > balanceInMu ? 'hand-dry-below-fee-floor' : 'too-thin-for-fee-floor', drift)
  // מדרגות-עולות (S3): 334µ×2^k — הרווחית-הקטנה-הראשונה יורית; best נשמר-לכנות-ה-idle
  let best: { s: number; profit: number } | null = null
  for (let k = 0, s = minInput; k < cfg.ladderSteps; k++, s *= 2) {
    if (s > capMu) break
    const q = quoteSwap(pool, direction, s) // טהור; s ≤ 10%-עתודה → לעולם לא מנקז
    const valueMu = toBase ? Math.floor((q.outMu * fairMu) / 1_000_000) : q.outMu
    const costMu = toBase ? s : Math.floor((s * fairMu) / 1_000_000)
    const profit = valueMu - costMu
    if (best === null || profit > best.profit) best = { s, profit }
    if (q.feeMu >= cfg.feeFloorMu && profit >= cfg.minProfitMu) {
      return {
        action: direction,
        reason: `capture: drift=${drift}bps size=${s}µ profit=${profit}µ`,
        driftBps: drift,
        amountInMu: s,
        expectedOutMu: q.outMu,
        expectedFeeMu: q.feeMu,
        expectedProfitMu: profit,
      }
    }
  }
  return idle(
    `edge-below-costs: drift=${drift}bps fee=${pool.feeBps}bps best=${best ? `${best.profit}µ@${best.s}µ` : 'none'}`,
    drift,
  )
}
