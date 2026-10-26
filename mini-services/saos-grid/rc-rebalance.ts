// ═════════════════════════════════════════════════════════════════════════════
// rc-rebalance.ts — איזון-RC-דינמי-בין-חשבונות-הצי (דירקטיבת-141 §2 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים §2: "Rebalance Resource Credits (RC) dynamically across
// soldier accounts". ה-RC על-Steem נגזר-מה-vests-האפקטיביים (נמדד-חי 26/10:
// saos-0002 — 2.000 VESTS → max_rc 6.83G = creation-adj 4.83G + vests×1.0),
// ולכן האיזון-האמיתי = הקצאת-vests (delegate_vesting_shares — ניתנת-לשחזור,
// אבסולוטית-בשרשרת — אידמפוטנטית, דפוס-backfillDelegations מ-Task-137-b).
//
// חוקי-הבית:
//  · איזון-חד-כיווני: עודף→גרעון בלבד. אף-גריעה-מחיילים, אף-מגע-ברזרבת-האוצר.
//  · רצפת-האוצר-קודשת: האוצר-שומר-לעצמו- treasuryKeepPct% מה-vests-האפקטיביים
//    (חוק-"לא-שורפים-את-הרזרבה" — Task-107/137/138).
//  · נשק-מדוד: תקרה-הפר-חייל + תקרת-הקצאות-לפעימה.
//  · אין-גרעון-מעל-הרצפה → no-op-מתועד-עם-סיבה (כנות, לא-פעולה-סמלית).
// הליבה-כאן-טהורה; ה-I/O-החי (get_accounts/rc_api.find_rc_accounts/שידור/קריאה-חוזרת)
// חי-ב-index.ts, כמו-דפוס- soldier-drip.
// ═════════════════════════════════════════════════════════════════════════════

export interface RcAccountState {
  name: string
  /** vests-אפקטיביים-גולמיים = vesting_shares + received_vesting_shares − delegated_vesting_shares (יחידות-גלם ×1e6) */
  effectiveVestsRaw: number
  /** rc_manabar.current_mana — נמדד-חי (rc_api.find_rc_accounts) */
  rcMana: number
  /** rc_manabar-מקסימלי (max_rc) */
  rcMax: number
}

export interface RcRebalanceInput {
  accounts: RcAccountState[]
  treasury: string
  /** רצפת-vests-לחייל — רצפת-הלידה של fleet-growth (2.000 VESTS ≈ 1.026 SP) */
  soldierFloorVestsRaw: number
  /** אחוז-האוצר-שנשמר-לעצמו מה-vests-האפקטיביים (90 = רזרבה-קודשת-גדולה) */
  treasuryKeepPct: number
  maxDelegatePerSoldierRaw: number
  maxDelegationsPerPulse: number
}

export interface RcDelegation {
  from: string
  to: string
  vestsRaw: number
  reason: 'rc-deficit-topup'
}

export interface RcRebalanceResult {
  delegations: RcDelegation[]
  /** כנות-מלאה: מה-נשמט-ולמה (floor-unreached / surplus-exhausted / surplus-dust / pulse-cap / invalid) */
  skipped: string[]
  /** אין-פעולה-וזו-הסיבה-הכנה (no-deficit-above-floor / treasury-surplus-empty / …) */
  noOpReason: string | null
}

/** אבק-הקצאה: מתחת-לזה (0.01 VESTS) ההקצאה-היא-רעש-שרשרת-שלא-מקדם-אף-גרעון-אמת —
 *  מדוד-חי: 0.01 VESTS ≈ 0.034G RC (ק' = 1.0 על-החיילים, 26/10) — פעוט-מול-שער-ההצבעה. */
export const DUST_GRANT_RAW = 10_000_000

/** ליבה-דטרמיניסטית: גרעונות-החיילים-מטופלים-מהגדול-לקטן (שוויון → שם-עולה);
 *  מקור-ההקצאה-הוא-העודף-של-האוצר-מעל-הרצפה-הקודשת-שלו-בלבד. */
export function rcRebalancePlan(inp: RcRebalanceInput): RcRebalanceResult {
  const delegations: RcDelegation[] = []
  const skipped: string[] = []
  const floor = Math.max(0, Math.floor(inp.soldierFloorVestsRaw))
  const capPerSoldier = Math.max(0, Math.floor(inp.maxDelegatePerSoldierRaw))
  const capPerPulse = Math.max(0, Math.floor(inp.maxDelegationsPerPulse))

  if (!Array.isArray(inp.accounts) || inp.accounts.length === 0) {
    return { delegations, skipped, noOpReason: 'no-accounts' }
  }
  // כל-המדידות-חייבות-להיות-שלמות-ושלמות-מתמטית — מדידה-חסרה = עצירה-כנה (fail-closed)
  for (const a of inp.accounts) {
    if (
      !a ||
      typeof a.name !== 'string' ||
      !Number.isSafeInteger(a.effectiveVestsRaw) ||
      a.effectiveVestsRaw < 0 ||
      !Number.isSafeInteger(a.rcMana) ||
      a.rcMana < 0 ||
      !Number.isSafeInteger(a.rcMax) ||
      a.rcMax < 0
    ) {
      return { delegations, skipped, noOpReason: 'invalid-account-data' }
    }
  }
  const treasury = inp.accounts.find((a) => a.name === inp.treasury)
  if (!treasury) return { delegations, skipped, noOpReason: 'treasury-missing' }

  const soldiers = inp.accounts.filter((a) => a.name !== inp.treasury)
  if (soldiers.length === 0) return { delegations, skipped, noOpReason: 'no-soldiers' }
  if (capPerSoldier === 0 || capPerPulse === 0) {
    return { delegations, skipped, noOpReason: 'policy-allows-nothing' }
  }

  // רצפת-האוצר-הקודשת: treasuryKeepPct% מהאפקטיבי-נשאר-בבית — העודף-הוא-רק-מה-שמעליה
  const keepPct = Math.min(100, Math.max(0, Math.floor(inp.treasuryKeepPct)))
  const treasuryFloor = Math.floor((treasury.effectiveVestsRaw * keepPct) / 100)
  let surplus = Math.max(0, treasury.effectiveVestsRaw - treasuryFloor)

  // דטרמיניזם: גרעון-גדול-ראשון; שוויון → שם-עולה
  const deficits = soldiers
    .map((s) => ({ name: s.name, deficit: Math.max(0, floor - s.effectiveVestsRaw) }))
    .filter((s) => s.deficit > 0)
    .sort(
      (a, b) => b.deficit - a.deficit || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )

  if (deficits.length === 0) {
    return { delegations, skipped, noOpReason: 'no-deficit-above-floor' }
  }

  for (const d of deficits) {
    if (delegations.length >= capPerPulse) {
      skipped.push(`${d.name}:pulse-cap (תקרת-פעימה ${capPerPulse} — נשאר-בתור לפעימה-הבאה)`)
      continue
    }
    if (surplus <= 0) {
      skipped.push(`${d.name}:surplus-exhausted (עודף-האוצר-אפס-אחרי-רצפת-קודשת ${keepPct}%)`)
      continue
    }
    const grant = Math.min(d.deficit, capPerSoldier, surplus)
    if (grant < DUST_GRANT_RAW) {
      skipped.push(`${d.name}:surplus-dust (העודף-הנותר ${surplus} מתחת-לאבק-ההקצאה ${DUST_GRANT_RAW} — האוצר-בלי-עודף-אמת)`)
      surplus = 0
      continue
    }
    delegations.push({ from: inp.treasury, to: d.name, vestsRaw: grant, reason: 'rc-deficit-topup' })
    surplus -= grant
    if (grant < d.deficit) {
      skipped.push(`${d.name}:floor-unreached (הוקצה ${grant} מתוך-גרעון ${d.deficit} — תקרה-הפר-חייל או עודף-חלקי; יושלם-בפעימות-הבאות)`)
    }
  }

  if (delegations.length === 0) {
    return { delegations, skipped, noOpReason: 'treasury-surplus-empty' }
  }
  return { delegations, skipped, noOpReason: null }
}
