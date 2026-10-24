// ═════════════════════════════════════════════════════════════════════════════
// amm-rail.ts — מסילת-ה-quote-AMM של השוק-החריף (הנחיית-בעלים §2/§7.1)
// Issue-ה-TDD של Task-134: "saos-arb מקריא רק את ספר-הפקודות; מנוע-ה-AMM
// לא נצרך על-ידי אף-מסילת-מחיר" — עתה נצרך: פער-גלוי-ב-bps + הכרעה-כנה.
//
// טהור ודטרמיניסטי: אין-I/O, אין-שעון. הגודל = קלי-מנוטרל (p/b קבועים-מדודים
// ושמרניים — הארביטראז-פנימי כמעט-נטול-סיכון-שוק אך לא-חסין-מפני-ריצה-עצמית).
// fail-closed: אין-מדידה → hold; אין-מלאי → hold; קצה-נטו-מתחת-לסף → hold.
// ═════════════════════════════════════════════════════════════════════════════

export interface AmmRailInput {
  /** מחצי-הספר/ה-fair של הספר-הפנימי (µ-quote ל-µ-בסיס) */
  bookMidMu: number | null
  /** מחיר-הבריכה (µ-quote ל-µ-בסיס) מ-amm/state */
  ammPriceMu: number | null
  /** עמלת-הבריכה (bps) — נספרת-פעמיים (כניסה+יציאה) לפני-סף-ההכרעה */
  feeBps: number
  /** סף-הפעולה על-הקצה-הנטו (bps) */
  minEdgeBps: number
  /** יתרה-פנויה של ה-quote (USDS µ) — לקנייה-מהבריכה */
  freeQuoteMu: number
  /** מלאי-בסיס-פנוי (µ) — למכירה-לבריכה */
  freeBaseMu: number
  /** פרמטרי-קלי המדודים (קבועים-שמרניים-ברירת-מחדל) */
  kellyWinProb: number
  kellyRatio: number
  kellyCapFrac: number
  /** תקרת-מסחר-להכרעה בודדת (µ) */
  maxNotionalMu: number
}

export type AmmRailDecision =
  | {
      action: 'swap'
      direction: 'baseToQuote' | 'quoteToBase'
      amountInMu: number
      edgeBps: number
      sizeSource: 'quote' | 'base'
      reason: string
    }
  | { action: 'hold'; reason: string; edgeBps: number | null }

/** פער-הספר מהבריכה ב-bps — חתום: חיוב = הספר-יקר. אין-מדידה → null. */
export function ammEdgeBps(bookMidMu: number | null, ammPriceMu: number | null): number | null {
  if (
    bookMidMu === null || ammPriceMu === null ||
    !Number.isFinite(bookMidMu) || !Number.isFinite(ammPriceMu) ||
    bookMidMu <= 0 || ammPriceMu <= 0
  ) {
    return null
  }
  return Math.round(((bookMidMu - ammPriceMu) / ammPriceMu) * 10_000)
}

// קלי-מנוטרל — אותה-מתמטיקה כמו ארון-הסיכונים של הדקס (risk.ts) — מקור-אמת יחיד
function kellyFrac(p: number, b: number, cap: number): number {
  if (!Number.isFinite(p) || !Number.isFinite(b) || !Number.isFinite(cap) || p < 0 || p > 1 || b <= 0 || cap <= 0) return 0
  const f = (p * (b + 1) - 1) / b
  if (!Number.isFinite(f) || f <= 0) return 0
  return Math.min(f, cap)
}

/**
 * ההכרעה: הספר-יקר-מהבריכה → קניית-בסיס-מהבריכה (quoteToBase);
 * הספר-זול → מכירת-המלאי-לבריכה (baseToQuote). הגודל = קלי על-הצד-הרלוונטי,
 * מוגבל-תקרת-מסחר. העמלה נספרת-פעמיים (הכניסה-לבריכה; היציאה-אל-הספר-היא-הפרמיה-עצמה).
 */
export function ammRailDecision(inp: AmmRailInput): AmmRailDecision {
  const edge = ammEdgeBps(inp.bookMidMu, inp.ammPriceMu)
  if (edge === null) return { action: 'hold', reason: 'no-measurable-edge', edgeBps: null }
  const netEdge = Math.abs(edge) - 2 * inp.feeBps // עמלה-בכניסה; היציאה-מובעת-בפער-עצמו
  if (netEdge < inp.minEdgeBps) {
    return { action: 'hold', reason: 'edge-below-min-after-fees', edgeBps: edge }
  }
  const buyingBase = edge > 0 // הספר-יקר → הבריכה-זולה → קונים-ממנה
  const freeMu = buyingBase ? inp.freeQuoteMu : inp.freeBaseMu
  if (!Number.isFinite(freeMu) || freeMu <= 0) {
    return { action: 'hold', reason: 'no-free-funds', edgeBps: edge }
  }
  const f = kellyFrac(inp.kellyWinProb, inp.kellyRatio, inp.kellyCapFrac)
  const sizeMu = Math.min(inp.maxNotionalMu, Math.floor(freeMu * f))
  if (sizeMu <= 0) {
    return { action: 'hold', reason: 'kelly-zero-size', edgeBps: edge }
  }
  return {
    action: 'swap',
    direction: buyingBase ? 'quoteToBase' : 'baseToQuote',
    amountInMu: sizeMu,
    edgeBps: edge,
    sizeSource: buyingBase ? 'quote' : 'base',
    reason: `book-vs-amm-${edge > 0 ? 'premium' : 'discount'}-${Math.abs(edge)}bps-net-${netEdge}bps`,
  }
}
