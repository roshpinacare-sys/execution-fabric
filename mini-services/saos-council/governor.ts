// ===== מנהל-הסיכון הקשיח — פסק-דין-מכני-לפני-כל-מועצה =====
// דפוס-AutoHedge (MarketMakingConfig: max_inventory_exposure, rebalance_threshold,
// min_profit_threshold) מותאם-לריבונות: הגבולות מקודדים-קשיח, הפסק-מכני וקודם-ל-LLM,
// וה-LLM-מייעץ-בלבד — אף-החלטת-סיכון-לא-מופקדת-על-שפה.

import type { EvidenceBundle } from './evidence'

export type GovernorVerdict = 'flowing' | 'warn' | 'danger'

export type GovernorRuling = {
  verdict: GovernorVerdict
  findings: string[]
  actions: string[]
  thresholds: typeof THRESHOLDS
}

// סף-הדקס-של-AutoHedge: אף-צד-אחד-לא-יותר-מ-80% מהמלאי-הפתוח (מקביל-
// max_inventory_exposure=20% מהצד-השני); סטייה-מעל-65% = אזהרת-איזון
const THRESHOLDS = {
  maxSideSkewPct: 80, // danger — חשיפה-צדית-קיצונית (AutoHedge: max_inventory_exposure)
  rebalanceSkewPct: 65, // warn — סף-איזון-מחדש (AutoHedge: rebalance_threshold)
  gridErrorStreak: 3, // danger — כשלים-רצופים-במנוע-הגריד
  staleCycleSec: 240, // warn — המנוע-לא-נושם-4-דק'
  dexDeadWhileArbTrades: true, // danger — סוחרים-על-שוק-מת (עצירה-מכנית)
} as const

export type RulingAction = { kind: 'halt-arb' | 'note'; detail: string }

export function rule(e: EvidenceBundle, dexFailStreak: number, arbHaltedNow: boolean): { ruling: GovernorRuling; actions: RulingAction[] } {
  const findings: string[] = []
  const actions: RulingAction[] = []
  let verdict: GovernorVerdict = 'flowing'

  const danger = (msg: string): void => {
    verdict = 'danger'
    findings.push(`DANGER: ${msg}`)
  }
  const warn = (msg: string): void => {
    if (verdict !== 'danger') verdict = 'warn'
    findings.push(`WARN: ${msg}`)
  }

  // 1) חשיפה-צדית (AutoHedge: max_inventory_exposure / rebalance_threshold)
  const skew = e.quant.exposureSkewPct
  if (skew !== null) {
    const abs = Math.abs(skew)
    const side = skew > 0 ? 'קניות (SBD)' : 'מכירות (STEEM)'
    if (abs >= THRESHOLDS.maxSideSkewPct) danger(`חשיפה-צדית-קיצונית: ${abs}% ${side} מהמלאי-הפתוח (סף-${THRESHOLDS.maxSideSkewPct}%) — נדרש-איזון`)
    else if (abs >= THRESHOLDS.rebalanceSkewPct) warn(`חשיפה-צדית ${abs}% ${side} (סף-איזון ${THRESHOLDS.rebalanceSkewPct}%)`)
    else findings.push(`חשיפה-מאוזנת: סטייה ${abs}% בלבד בין-הצדדים`)
  }

  // 2) בריאות-הגריד
  const g = e.grid
  if (!g) danger('מנוע-הגריד לא-נקרא — היד-הסוחרת-של-הגוף עיוורת')
  else {
    if (g.halted) findings.push(`הגריד-מושהה: ${g.haltReason ?? 'סיבה-לא-דווחה'}`)
    if ((g.consecutiveErrors ?? 0) >= THRESHOLDS.gridErrorStreak) danger(`מנוע-הגריד ${g.consecutiveErrors}-כשלים-רצופים: ${g.lastError ?? ''}`)
    if (g.lastCycleAt) {
      const ageSec = (Date.now() - new Date(g.lastCycleAt).getTime()) / 1000
      if (ageSec > THRESHOLDS.staleCycleSec && !g.halted) warn(`המחזור-האחרון לפני ${Math.round(ageSec)}ש' (סף-${THRESHOLDS.staleCycleSec}ש')`)
    }
  }

  // 2b) בריאות-הארב-ורוחב-השוק (Task 108 — הראיות-שהמועצה-עצמה-ביקשה)
  const a = e.arb
  if (!a && e.sources.arb.ok) warn('איבר-הארב-נגיש אך ראיותיו-ריקות — חילוץ-נכשל')
  if (a) {
    if (a.halted) findings.push('איבר-הארב-מושהה (halt-flag חי)')
    if (a.feedStale === true) warn('פיד-אמת-החוץ של-הארב מיושן — הפאריטי-שעליו-סוחרים עלול-להיות-רענון-שקר')
    if (a.expansion && a.expansion.total) {
      findings.push(`רוחב-הספר: ${a.expansion.twoSided ?? '?'}/${a.expansion.total} שווקים-דו-צדדיים; בוני-עומק-על: ${(a.expansion.depthMarkets ?? []).join(', ') || '—'}; ידיים-פעילות: ${a.expansion.handsActive ?? '?'}`)
    }
    if (a.mtmPnlMu !== null) findings.push(`MTM-הארב (sim-µ מתויג): ${a.mtmPnlMu}µ; מימושים-אחרונים: ${Object.entries(a.fillsByHand).map(([h, k]) => `${h}×${k}`).join(', ') || '0'}`)
  }

  // 3) סוחרים-על-שוק-מת? (החלטה-מכנית-בלבד: השתקה-מונעת-של-הארב)
  if (THRESHOLDS.dexDeadWhileArbTrades) {
    if (!e.sources.dex.ok && e.sources.arb.ok && !arbHaltedNow && dexFailStreak >= 3) {
      danger(`הדקס-מת-${dexFailStreak}-סבבים-והארב-סוחר — עצירה-מכנית-של-הארב`)
      actions.push({ kind: 'halt-arb', detail: `dex dead ×${dexFailStreak} + arb alive` })
    } else if (!e.sources.dex.ok) {
      warn(`הדקס-לא-נגיש (סבב-${dexFailStreak})`)
    }
  }

  // 4) זרימת-האורגניזם
  const fv = e.flow?.verdict
  if (fv === 'blocked') danger(`זרימת-האורגניזם-חסומה: ${e.flow?.detail ?? ''}`)
  else if (fv === 'degraded') warn(`זרימה-נגוסה: ${e.flow?.detail ?? ''}`)

  if (findings.length === 0) findings.push('כל-הגבולות-בתוך-הסף — אין-חריגות')

  return {
    ruling: { verdict, findings, actions: actions.map((a) => a.detail), thresholds: THRESHOLDS },
    actions,
  }
}
