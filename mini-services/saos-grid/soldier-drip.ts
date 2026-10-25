// ═════════════════════════════════════════════════════════════════════════════
// soldier-drip.ts — טפטוף-הון-מהאוצר-אל-החיילים (דירקטיבת-בעלים 25/10 §3)
// ═════════════════════════════════════════════════════════════════════════════
// השורש-הנמדד-חי (16:00Z): לכל-חיילי-השרשרת (saos-0001..3) יש מפתחות-ACTIVE
// טעונים-במנוע (4-ידיים live) אך יתרות-נזילות 0.000 STEEM/SBD → המנוע-מדלג
// עליהם-בכנות ("מתחת-לגודל-המינימלי"). זו-איננה-באג-טעינת-מפתחות — זה-מחסור-דלק.
//
// התיקון: מנוע-טפטוף-כנה — האוצר (החשבון-הראשון-ב-GRID_ACCOUNTS) מזרים
// סכומי-עבודה-מינימליים-שמאפשרים-הזמנות-חיות, מעולם-לא-נוגע-ברזרבה-שלו,
// SBD-קודם (צד-קנייה-הזול), STEEM-שני (צד-מכירה), תקרת-העברות-לפעימה.
//
// כל-היחידות-שלמות-במילי (1 STEEM = 1000mu) — דיוק-השרשרת (3-ספרות).
// הטהור-כאן (dripPlan) — נבדק-דטרמיניסטית; ה-I/O-חי (קריאה/חתימה/שידור/קריאה-חוזרת)
// חי-ב-index.ts-ובהרצה-החיה-בלבד, כמו-דפוס- fleet-growth.
// ═════════════════════════════════════════════════════════════════════════════

export interface TreasuryFunds {
  steemMu: number
  sbdMu: number
}

export interface SoldierFunds {
  name: string
  steemMu: number
  sbdMu: number
}

export interface DripPlanInput {
  treasury: TreasuryFunds
  soldiers: SoldierFunds[]
  /** אחוז-רזרבת-אוצר-שאינו-נוגע-לעולם (Task-107/137: "לא-שורפים-את-הרזרבה") */
  reservePct: number
  /** יעד-SBD-לחייל — מעליו-המנוע-מציב-קנייה-חיה (MIN_ORDER_SBD × (1+reserve)) */
  buySideTargetSbdMu: number
  /** יעד-STEEM-לחייל — מעליו-המנוע-מציב-מכירה-חיה (MIN_ORDER_STEEM + רווח) */
  sellSideTargetSteemMu: number
  /** תקרת-העברות-לפעימה — אפס-סערת-ברודקאסט */
  maxTransfersPerPulse: number
}

export interface DripTransfer {
  to: string
  asset: 'STEEM' | 'SBD'
  amountMu: number
  reason: 'buy-side' | 'sell-side' | 'partial-treasury'
}

export interface DripPlanResult {
  transfers: DripTransfer[]
  /** כנות-מלאה: מה-נשמט-ולמה (deficit-zero / treasury-empty / cap-reached) */
  skipped: string[]
}

/** כל-הכמויות-שלמות; דטרמיניסטי; אפס-I/O; דחייה-כברירת-מחדל-על-כל-קלט-פגום. */
export function dripPlan(inp: DripPlanInput): DripPlanResult {
  const transfers: DripTransfer[] = []
  const skipped: string[] = []
  const reserveFactor = (100 - inp.reservePct) / 100
  let availSbd = Math.floor(Math.max(0, inp.treasury.sbdMu) * reserveFactor)
  let availSteem = Math.floor(Math.max(0, inp.treasury.steemMu) * reserveFactor)
  const cap = Math.max(0, Math.floor(inp.maxTransfersPerPulse))

  // דטרמיניזם: גירעון-גדול-ראשון (= סך-מימון-נוכחי-הקטן-ראשון); שוויון → שם-עולה
  const order = [...inp.soldiers].sort(
    (a, b) =>
      a.sbdMu + a.steemMu - (b.sbdMu + b.steemMu) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )

  const soldierName = new Set(inp.soldiers.map((s) => s.name))

  // ── פאזה 1: SBD (צד-קנייה — הפתיחה-הזולה) ────────────────────────────────
  for (const s of order) {
    if (!soldierName.has(s.name)) continue
    const need = Math.max(0, inp.buySideTargetSbdMu - s.sbdMu)
    if (need <= 0) {
      skipped.push(`${s.name}:SBD deficit-zero (יש ${s.sbdMu}mu ≥ יעד ${inp.buySideTargetSbdMu}mu)`)
      continue
    }
    if (availSbd <= 0) {
      skipped.push(`${s.name}:SBD treasury-empty (זמין 0mu אחרי-רזרבה ${inp.reservePct}%)`)
      continue
    }
    if (transfers.length >= cap) {
      skipped.push(`${s.name}:SBD cap-reached (תקרת-פעימה ${cap})`)
      continue
    }
    const amt = Math.min(need, availSbd)
    if (amt < 1) {
      skipped.push(`${s.name}:SBD dust (הזמין/הצורך < 0.001 SBD)`)
      continue
    }
    transfers.push({
      to: s.name,
      asset: 'SBD',
      amountMu: amt,
      reason: amt < need ? 'partial-treasury' : 'buy-side',
    })
    availSbd -= amt
  }

  // ── פאזה 2: STEEM (צד-מכירה — אחרי-שהקניות-ערוכות) ────────────────────────
  for (const s of order) {
    const need = Math.max(0, inp.sellSideTargetSteemMu - s.steemMu)
    if (need <= 0) {
      skipped.push(`${s.name}:STEEM deficit-zero (יש ${s.steemMu}mu ≥ יעד ${inp.sellSideTargetSteemMu}mu)`)
      continue
    }
    if (availSteem <= 0) {
      skipped.push(`${s.name}:STEEM treasury-empty (זמין 0mu אחרי-רזרבה ${inp.reservePct}%)`)
      continue
    }
    if (transfers.length >= cap) {
      skipped.push(`${s.name}:STEEM cap-reached (תקרת-פעימה ${cap})`)
      continue
    }
    const amt = Math.min(need, availSteem)
    if (amt < 1) {
      skipped.push(`${s.name}:STEEM dust (הזמין/הצורך < 0.001 STEEM)`)
      continue
    }
    transfers.push({
      to: s.name,
      asset: 'STEEM',
      amountMu: amt,
      reason: amt < need ? 'partial-treasury' : 'sell-side',
    })
    availSteem -= amt
  }

  return { transfers, skipped }
}
