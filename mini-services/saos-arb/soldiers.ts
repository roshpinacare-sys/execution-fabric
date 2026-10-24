// ═════════════════════════════════════════════════════════════════════════════
// soldiers.ts — רשת-החיילים (Task-136 §2 — דירקטיבת-הבעלים)
// ═════════════════════════════════════════════════════════════════════════════
// "ELIMINATE SINGLE-ACCOUNT BOTTLENECK… ALL soldier accounts activated at
// 100% capacity simultaneously… automated inter-account liquidity streaming
// to feed under-resourced soldier nodes instantly."
//
// הבעיה-המבנית-שנמדדה (Task-136): ידי-ה-µ הישנות מידו-פקודות-בנוסחה שהתעלמה
// ממוסכמת-העלות של הדקס (need = amount×price) — על-שווקי-זרע-יקרים (SAOS/WSBD/
// PHIVE/ENERGY) כל-פקודה-נדחית-בשקט (insufficient-free-funds), והמלאי-הבסיסי
// יושב-באוצר-בלי-שום-זרימה-לחיילים. התוצאה: רק-שוק-אחד-חי; ארבעה-חיילים-אילמים.
//
// ארבעה-חוקים טהורים (כולם-נבדקים-בדיקות, אפס-I/O, אפס-שעון, µ-שלמים):
//  1. floatPolicy — מי-מהחיילים-רזה-בנכס-העבודה-שלו-וכמה-חסר-לו-בדיוק.
//  2. streamPlan — זרימת-מלאי-אמת מהאוצר: גירעון-גדול-ראשון (דטרמיניסטי),
//     תקרת-מחזור-לחייל, אוצר-שלעולם-לא-נשאב-מעבר-ליתרה (מימון-חלקי-כנה).
//  3. bidSizeMu — גודל-קנייה-אמת: floor(freeQuote/price) — עלות=amount×price
//     מכוסה-תמיד; מתחת-לסף-החיים → 0 (שתיקה-כנה, לא-פקודת-אוויר-נדחית-בשקט).
//  4. askSizeMu — גודל-מכירה-אמת: ממלאי-אמת-בלבד (אף-מכירה-באוויר).
// ═════════════════════════════════════════════════════════════════════════════

export interface SoldierBalance {
  name: string
  balances: Record<string, number>
}

/** גודל-פקודה-מינימלי-חי (הסף שבו פקודה ראויה-לספר — כמו-הידיים-הקיימות). */
export const MIN_ORDER_MU = 500

// ── 1. מדיניות-צף ────────────────────────────────────────────────────────────
export interface FloatPolicy {
  soldier: string
  asset: string
  freeMu: number
  needMu: number
  stream: boolean
}

export function floatPolicy(soldier: string, bal: SoldierBalance, asset: string, minFloatMu: number): FloatPolicy {
  const freeMu = bal.balances[asset] ?? 0
  const needMu = Math.max(0, minFloatMu - freeMu)
  return { soldier, asset, freeMu, needMu, stream: needMu > 0 }
}

// ── 2. תוכנית-הזרמות ────────────────────────────────────────────────────────
export interface StreamTransfer {
  from: string
  to: string
  asset: string
  amountMu: number
}

export function streamPlan(
  treasury: SoldierBalance,
  deficits: FloatPolicy[],
  asset: string,
  perSoldierCapMu: number,
): StreamTransfer[] {
  // דטרמיניזם: גירעון-גדול-ראשון; שוויון → שם-עולה
  const sorted = [...deficits]
    .filter((d) => d.asset === asset && d.needMu > 0)
    .sort((a, b) => (b.needMu - a.needMu) || (a.soldier < b.soldier ? -1 : 1))
  let remaining = treasury.balances[asset] ?? 0
  const plan: StreamTransfer[] = []
  for (const d of sorted) {
    if (remaining <= 0) break
    const amountMu = Math.min(d.needMu, perSoldierCapMu, remaining)
    if (amountMu <= 0) continue
    plan.push({ from: treasury.name, to: d.soldier, asset, amountMu })
    remaining -= amountMu
  }
  return plan
}

// ── 3. גודל-קנייה-אמת (מוסכמת-העלות: need = amount×price) ───────────────────
export function bidSizeMu(freeQuoteMu: number, priceMu: number, capMu: number): number {
  if (
    !Number.isFinite(freeQuoteMu) || freeQuoteMu <= 0 ||
    !Number.isFinite(priceMu) || priceMu <= 0 ||
    !Number.isFinite(capMu) || capMu <= 0
  ) {
    return 0
  }
  const affordable = Math.floor(freeQuoteMu / priceMu) // amount×price ≤ freeQuote תמיד
  const size = Math.min(capMu, affordable)
  return size >= MIN_ORDER_MU ? size : 0 // מתחת-לסף-החיים → 0 (כנות, לא-דחייה-שקטה)
}

// ── 4. גודל-מכירה-אמת (מלאי-בלבד) ───────────────────────────────────────────
export function askSizeMu(freeBaseMu: number, capMu: number): number {
  if (
    !Number.isFinite(freeBaseMu) || freeBaseMu <= 0 ||
    !Number.isFinite(capMu) || capMu <= 0
  ) {
    return 0
  }
  const size = Math.min(capMu, Math.floor(freeBaseMu))
  return size >= MIN_ORDER_MU ? size : 0
}
