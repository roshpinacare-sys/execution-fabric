// ═════════════════════════════════════════════════════════════════════════════
// saos-dex/amm — מנוע-ההחלפות-המיידיות הפנימי (Task-134 — הנחיה §3/§7.1, TDD)
// ═════════════════════════════════════════════════════════════════════════════
// constant-product AMM על µ-שלמים-בלבד: אפס-RPC-חיצוני, אפס-גז, אפס-צפים,
// דטרמיניזם-מלא. העמלה (30bps) נשארת-בעתודות-הבריכה — מכפלת-העתודות אינה-
// יורדת-לעולם (A1). כל-החלוקות ברצפה-לטובת-הבריכה (A3). fail-closed על כל
// קלט-לא-תקין (A5). לוגיקה טהורה-לגמרי — הזרקת-אחסון כמו engine.ts.
//
// אינווריאנטים חתומים (מוכחים ב-amm.test.ts):
//  A1 k'=(rb+Δb)(rq−Δq) ≥ k=rb·rq  — הבריכה אינה-מאבדת-לעולם
//  A2 out ≤ reserveOut — אין-הטבעת-כסף-מאין
//  A3 רצפה-לטובת-הבריכה בכל-חלוקה (out = floor(ideal))
//  A4 minOut (מגן-חלקה) — חריגה → זריקה, אפס-שינוי-מצב
//  A5 קלט-לא-תקין (0/שלילי/שבר/מעל-עתודה/עמלה-פסולה) → זריקה-כנה
//  A6 דטרמיניזם — אותם-קלטים → אותן-תוצאות
//  A7 round-trip תמיד-נגד-הסוחר (עמלה+מחיק)
//  A8/A9 נזילות: מניות-רצפה-לטובת-בריכה; MIN_LIQUIDITY-נעול-לשריפה

export interface Pool {
  id?: number
  base: string
  quote: string
  reserveBaseMu: number
  reserveQuoteMu: number
  feeBps: number
  lpSharesMu: number
  walletName?: string
}

export const MIN_LIQUIDITY = 1_000
const BPS_DEN = 10_000

// שורש-שלם דטרמיניסטי (בלי-float): ניוטון-על-BigInt — מטופל-עד MAX_SAFE_INTEGER
// (בריכות-ענק: rb·rq חורג-מ-2^53 — כל-החשבון-על-BigInt, התוצאה-מהודקת-לשלם-בטוח)
export function isqrtBig(bn: bigint): bigint {
  if (bn < 0n) throw new Error('isqrtBig: negative')
  if (bn < 2n) return bn
  // ניוטון לוגריתמי: x_{k+1}=(x_k + bn/x_k)/2 מתכנס-מעל-השורש; כיוון-רצפה סופי ±1
  let x = 1n << BigInt(Math.ceil(bn.toString(2).length / 2))
  for (;;) {
    const y = (x + bn / x) >> 1n
    if (y >= x) break
    x = y
  }
  while (x > 0n && x * x > bn) x--
  while ((x + 1n) * (x + 1n) <= bn) x++
  return x
}
export function isqrt(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`isqrt: non-safe-integer ${n}`)
  const r = isqrtBig(BigInt(n))
  return r > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(r)
}

function assertMu(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`AMM: ${label} חייב-µ-שלם-חיובי (קיבל ${n})`)
  return n
}

// ── זריעת-בריכה (§3: הזרמת-נזילות-עצמאית) ─────────────────────────────────
export function seedPool(base: string, quote: string, reserveBaseMu: number, reserveQuoteMu: number, feeBps = 30): Pool {
  const rb = assertMu(reserveBaseMu, 'reserveBaseMu')
  const rq = assertMu(reserveQuoteMu, 'reserveQuoteMu')
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps >= BPS_DEN) throw new Error(`AMM: feeBps פסול (${feeBps})`)
  const sharesBig = isqrtBig(BigInt(rb) * BigInt(rq))
  const shares = Math.max(MIN_LIQUIDITY, sharesBig > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(sharesBig))
  return { base, quote, reserveBaseMu: rb, reserveQuoteMu: rq, feeBps, lpSharesMu: shares }
}

// ── זריעה-על-מחיר-ה-fair (Task-141-b — הפעלת-הבריכות) ────────────────────────
// חוזה-הזריעה-הכן: צד-ה-quote מחושב-כך-שמחיר-הבריכה ברגע-היוולדה יהיה-בדיוק
// מחיר-ה-fair של הספר (µ-quote ליחידת-בסיס-שלמה — סקאלת-refSeedMu/book):
//   rq = floor(rb × fairMu / 1_000_000)  ⟹  px = floor(rq×1e6/rb) ≤ fairMu
// הרצפה-תמיד-לטובת-הבריכה: אם המנה-אינה-מתחלקת, העיגול-למטה מציב-את-המחיר
// מעט-מתחת-ל-fair (בריכה-זולה-ב-µ-בודדים אינה-מציעה-רווח-פיקטיבי-מול-הספר;
// אובדן-העיגול ≤ ceil(1e6/rb)+1 µ — מוכח-בamm.test.ts). אפס-צפים, דטרמיניזם.
export function seedQuoteAtFairMu(reserveBaseMu: number, fairMu: number): number {
  assertMu(reserveBaseMu, 'reserveBaseMu')
  if (!Number.isSafeInteger(fairMu) || fairMu <= 0)
    throw new Error(`AMM: fairMu חייב-µ-שלם-חיובי (קיבל ${fairMu})`)
  return Math.floor((reserveBaseMu * fairMu) / 1_000_000)
}

// ── ציטוט-טהור (מסילת-ה-arb: GET /amm/quote) ────────────────────────────────
// Task-141-b (הכנות-מסוג-התקשרות): quoteSwap מחזיר-את-תוצאת-applySwap המלאה —
// כולל `pool`: הבריכה-המדומה-אחרי-ההחלפה (תצוגה-מקדימה-טהורה; אפס-כתיבה-למסד,
// נמדד-ואומת-חי 26/10: ה-pools-ב-db נשארים-בדיוק-על-עתודות-הזריעה). ה-HTTP מפיץ
// את-התצוגה-לצרכן (שדה pool בתשובת-/amm/quote) — עתה-הוא-חתום-בטיפוס.
export interface SwapQuote {
  outMu: number
  feeMu: number
  priceAfterMu: number // µ-quote ל-µ-base אחרי-ההחלפה
  /** הבריכה-אחרי-ההחלפה-המדומה (תצוגה-מקדימה-טהורה — אפס-שינוי-מצב-אמת) */
  pool: Pool
}
export function quoteSwap(pool: Pool, direction: 'baseToQuote' | 'quoteToBase', amountInMu: number): SwapQuote {
  return applySwap(pool, direction, amountInMu, 0)
}

// ── ביצוע-החלפה (טהור: מקבל-בריכה, מחזיר-בריכה-חדשה+פלט) ────────────────────
export function applySwap(
  pool: Pool,
  direction: 'baseToQuote' | 'quoteToBase',
  amountInMu: number,
  minOutMu: number,
): { pool: Pool; outMu: number; feeMu: number; priceAfterMu: number } {
  const inMu = assertMu(amountInMu, 'amountInMu')
  if (!Number.isSafeInteger(minOutMu) || minOutMu < 0) throw new Error('AMM: minOutMu חייב-שלם-אי-שלילי')
  const rb = pool.reserveBaseMu
  const rq = pool.reserveQuoteMu
  if (rb <= 0 || rq <= 0) throw new Error('AMM: עתודות-בריכה-ריקות — fail-closed')
  const feeMu = Math.floor((inMu * pool.feeBps) / BPS_DEN)
  const inAfterFee = inMu - feeMu
  if (inAfterFee <= 0) throw new Error(`AMM: עמלה בולעת את הקלט (feeBps=${pool.feeBps}) — fail-closed`)
  let outMu: number
  if (direction === 'baseToQuote') {
    if (inMu >= rb) throw new Error(`AMM: קלט ${inMu} מנקז-את-עתודת-הבסיס ${rb} — fail-closed`)
    outMu = Math.floor((rq * inAfterFee) / (rb + inAfterFee))
  } else {
    if (inMu >= rq) throw new Error(`AMM: קלט ${inMu} מנקז-את-עתודת-ה-quote ${rq} — fail-closed`)
    outMu = Math.floor((rb * inAfterFee) / (rq + inAfterFee))
  }
  if (outMu <= 0) throw new Error('AMM: פלט-אפטר-רצפה ≤ 0 — fail-closed')
  if (outMu > (direction === 'baseToQuote' ? rq : rb)) throw new Error('AMM: פלט מעל עתודה — אסור-להטביע (A2)')
  if (outMu < minOutMu) throw new Error(`AMM: minOut (מגן-חלקה) — מבוקש ≥${minOutMu}, אמת ${outMu}`)
  const newPool: Pool =
    direction === 'baseToQuote'
      ? { ...pool, reserveBaseMu: rb + inMu, reserveQuoteMu: rq - outMu }
      : { ...pool, reserveBaseMu: rb - outMu, reserveQuoteMu: rq + inMu }
  const priceAfterMu =
    newPool.reserveBaseMu > 0 ? Math.floor((newPool.reserveQuoteMu * 1_000_000) / newPool.reserveBaseMu) / 1000 : 0
  return { pool: newPool, outMu, feeMu, priceAfterMu }
}

// ── נזילות: הוספה (מניות-רצפה; עודף-יחס נשאר-בבריכה) ───────────────────────
export function addLiquidityShares(pool: Pool, amountBaseMu: number, amountQuoteMu: number): number {
  const ab = assertMu(amountBaseMu, 'amountBaseMu')
  const aq = assertMu(amountQuoteMu, 'amountQuoteMu')
  const mint = Math.min(
    Math.floor((ab * pool.lpSharesMu) / pool.reserveBaseMu),
    Math.floor((aq * pool.lpSharesMu) / pool.reserveQuoteMu),
  )
  if (mint <= 0) throw new Error('AMM: הזרמה-זעירה-מדי — מניות-רצפה 0 — fail-closed')
  return mint
}

// ── נזילות: משיכה (פרופורציה-רצפה; חוק-מינימום-השריפה) ─────────────────────
export function withdrawLiquidityShares(
  pool: Pool,
  sharesBurnMu: number,
): { baseMu: number; quoteMu: number; pool: Pool } {
  const burn = assertMu(sharesBurnMu, 'sharesBurnMu')
  if (pool.lpSharesMu - burn < MIN_LIQUIDITY)
    throw new Error(`AMM: משיכה משאירה מתחת ל-MIN_LIQUIDITY (${MIN_LIQUIDITY}) — fail-closed`)
  const baseMu = Math.floor((pool.reserveBaseMu * burn) / pool.lpSharesMu)
  const quoteMu = Math.floor((pool.reserveQuoteMu * burn) / pool.lpSharesMu)
  if (baseMu <= 0 || quoteMu <= 0) throw new Error('AMM: משיכה-מרוקנת-צד — fail-closed')
  return {
    baseMu,
    quoteMu,
    pool: {
      ...pool,
      reserveBaseMu: pool.reserveBaseMu - baseMu,
      reserveQuoteMu: pool.reserveQuoteMu - quoteMu,
      lpSharesMu: pool.lpSharesMu - burn,
    },
  }
}
