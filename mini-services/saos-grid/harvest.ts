// ═════════════════════════════════════════════════════════════════════════════
// harvest.ts — מדיניות-קציר-וקיורציה (Task-136 §1 — מימון-עצמי)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים: "High-yield automated curation and reward harvesting across
// Steem/Hive" — המדיניות-טהורה-ודטרמיניסטית; החתימה-ב-steem-tx; השידור-במסלול-ה-mesh.
//
// חוקי-הבית:
//  · אין-קציר-אבק (dust) — עסקה-על-אפס-היא-רעש, לא-הכנסה.
//  · ה-VP הוא המנוע-של-הקיורציה — מתחת-לשער: אפס-הצבעות (שימור-המנוע-עצמו).
//  · בחירת-מועמדים דטרמיניסטית לחלוטין — אף-המצאת-תוכן, אף-הצבעת-עצמי.
// ═════════════════════════════════════════════════════════════════════════════

export interface PendingRewards {
  /** יחידות-גלם: 5.000 STEEM = 5000 */
  steem: number
  sbd: number
  vests: number
}

export interface ClaimOpData {
  account: string
  rewardSteem: number
  rewardSbd: number
  rewardVests: number
}

/** האבק-נמדד-על-סה"כ-היחידות-הגלמות (STEEM+SBD+VESTS/1e2) — עסקה-מתחת-לו = רעש-שרשרת. */
export function claimDecision(account: string, rewards: PendingRewards, dustRawUnits: number): ClaimOpData | null {
  const total = rewards.steem + rewards.sbd + Math.floor(rewards.vests / 100)
  if (!Number.isFinite(total) || total <= dustRawUnits) return null
  return { account, rewardSteem: rewards.steem, rewardSbd: rewards.sbd, rewardVests: rewards.vests }
}

/** משקל-הצבעה ב-bps: מתחת-לשער → 0 (שימור-ה-VP); אחרת — min(cap, 10000). */
export function voteWeightBps(votingPowerPercent: number, minVpPercent: number, capBps: number): number {
  if (!Number.isFinite(votingPowerPercent) || votingPowerPercent < minVpPercent) return 0
  if (!Number.isFinite(capBps) || capBps <= 0) return 0
  return Math.min(capBps, 10_000)
}

export interface Discussion {
  author: string
  permlink: string
  createdEpochMs: number
  /** מיקרו-דולר (1e6 = $1) — פוטנציאל-התשלום-הנוכחי */
  pendingPayout: number
  authorReputation: number
  alreadyVoted: boolean
}

export interface CurationPolicy {
  nowEpochMs: number
  minAgeMin: number
  maxAgeMin: number
  minRep: number
  minPendingMicros: number
  limit: number
}

/** בחירה-דטרמיניסטית: חלון-גיל → סינון-איכות → פוטנציאל-תשלום-גדול-ראשון (שוויון → שם-עולה). */
export function curationCandidates(discussions: Discussion[], p: CurationPolicy): Discussion[] {
  const minAgeMs = p.minAgeMin * 60_000
  const maxAgeMs = p.maxAgeMin * 60_000
  return discussions
    .filter((d) => !d.alreadyVoted)
    .filter((d) => {
      const age = p.nowEpochMs - d.createdEpochMs
      return age >= minAgeMs && age <= maxAgeMs
    })
    .filter((d) => d.authorReputation >= p.minRep)
    .filter((d) => d.pendingPayout >= p.minPendingMicros)
    .sort((a, b) => (b.pendingPayout - a.pendingPayout) || (a.author < b.author ? -1 : 1))
    .slice(0, Math.max(0, p.limit))
}

// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-141 §2 — סבב-קיורציה-פר-חייל + שער-RC-מדיד (ליבה-טהורה)
// ═════════════════════════════════════════════════════════════════════════════

/** סבב-הקיורציה: פעימה-k → החשבון-ה-k בסדר-הכספת (האוצר-ראשון). דטרמיניסטי-לחלוטין. */
export function rotationAccount(order: string[], pulseIndex: number): string | null {
  if (!Array.isArray(order) || order.length === 0) return null
  const i = Number.isSafeInteger(pulseIndex) && pulseIndex > 0 ? pulseIndex : 0
  return order[i % order.length]!
}

/** שער-RC-מדיד להצבעה: mana חייב-להיות-נמדד (לא-null) ומעל-המינימום.
 *  לא-נמדד = fail-closed — אין-שידור-על-מצב-לא-מאומת (אפס-סערת-שידורים-נכשלים). */
export function rcVoteGate(rcMana: number | null, minMana: number): boolean {
  if (rcMana === null || !Number.isFinite(rcMana)) return false
  return rcMana >= minMana
}
