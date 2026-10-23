// fabric-heartbeat — עורק-החיים של רשת-הביצוע (Task 25 + Task 26)
//
// שלושה עורקים, שלושתם עצמאיים-לגמרי בדפדפן:
//   עורק-א: לולאת-tick כל 5 שניות → POST /api/worker/tick — הרשת קולטת-ומבצעת
//            משימות-QUEUED לבד (claim אטומי הוא קו-ההגנה מול עובד-הדפדפן).
//   עורק-ב: פעימת-גיט כל 15 דק' (וגם 90 שניות אחרי-הזנקה) — לפי RUNBOOK ריפו-האם:
//            pull-rebase → אם-יש-שינויים → leak-scan (חסם-כנה) → commit → push.
//            "הגיט-הוא-הקיום; הסנדבוקס-הוא-רק-זוג-ידיים."
//   עורק-ג (Task 26 + Task 28 + Task 29): פעימת-התפתחות כל 5 דק' → POST /api/evolution (auto) — הרשת מחליטה
//            בעצמה: ממצא-HIGH לא-מטופל מביקורת-עצמית → למידה; אחרת → הצעה-עצמית. ירי-LLM אמיתי.
//            תקציב-שעתי 12/שעה נאכף שרת-צד (429 = דילוג-כן) — הקצב-קושר בדיוק.
//   עורק-ד (Task 32): פעימת-בנייה כל 10 דק' → POST /api/sovereign/build — הרשת לא רק בודקת:
//            היא **בונה** את המוצר עצמו (תוכן/נתונים/הצעות — ארטיפקטים ב-sovereign/site/,
//            נדחפים-לגיט ע"י עורק-ב). תקציב 6/שעה נאכף שרת-צד.
//   עורק-ו (Task 44): פעימת-ריבונות כל 10 דק' → POST /api/sovereign/ops/tick — הלב לא רק מייצר:
//            הוא **מסיים** — סריקה → פסק-דין (חוק review-policy) → מסירה אמיתית → חתימת-שרשרת.
//            האוטונומיה מרוקנת את המלאי של עצמה (עד 22 פריטים תלויים יצאו מהתור לבד, לפי תקציב).
//   עורק-ז (Task 45): פעימת-אמת-עצמית כל 30 דק' → POST /api/sovereign/ops/selftest — הלב לא רק
//            משתמש בכלים: הוא **מוכיח** ברציפות שהוא יודע להשתמש בהם (8 כלים, קריאות-אמת),
//            ומדווח כנות — כשל-כלי נראה מיידית, לא מתגלה רק כשמנסים להשתמש בו.
//   עורק-0 (Task 26): שומר-האפליקציה — בדיקת-בריאות כל 15 שניות; 3 כשלים-רצופים
//            = הזנקת-האפליקציה מחדש מבן-עץ-הלב (העץ-המתמיד). הרשת מרפאת-את-עצמה.
//   עורק-ב שדרוג (Task 27): קונפליקט-db ב-pull-rebase — פתרון-עצמי מוכח-שרשרת:
//            אם-db/custom.db בלבד-בקונפליקט והשרשרת-המקומית על-קבוצה של הרחוקה
//            (ראש-הרחוק ∈ שרשרת-מקומית && ספירה-מקומית ≥ רחוקה) → קח-מקומי והמשך.
//            אחרת — abort כנה. אף-פתרון-אוטומטי על קבצי-קוד — רק על ה-db עם-הוכחת-הכלה.
//   עורק-ב שדרוג (Task 87 — הלקח-החי מאירוע-הסנדבוקס 2026-10-20): ריפוי-מצב-גיט עצמי.
//            rebase/merge תקועים מריצה-קודמת-שמתה השאירו את-הלב תקוע-לנצח (הזקיפה מחיה את
//            התהליך — אף-איבר לא ריפא את-מצב-הגיט). השער-בראש-כל-פעימה: גילוי → abort →
//            התכנסות-מול-origin בשימור-בייטים של db-החי (reset-ממוזג + checkout-סלקטיבי —
//            reset --hard עם-נתיבים אסור-על-ידי-גיט; הרצף הוכח-בייטית בריפו-ניסוי מבודד).
//
// דיסציפלינה: אף סוד לא נוגע/נדפס כאן (ה-credential-helper קורא את קובץ-הסמכות
// בזמן-ריצה); אין-force-push; כשל-סריקת-דליפות = אין-push (כנות); כל-כשל נרשם-וממשיך.

import { existsSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'

const APP_URL = process.env.FABRIC_APP_URL ?? 'http://127.0.0.1:3000'
const PORT = Number(process.env.FABRIC_HEARTBEAT_PORT ?? 3031)
// נגזרת-מיקום-עצמי (mini-services/fabric-heartbeat → שורש-הפרויקט) — אפס-נתיב-מילולי (חסם-הדליפות)
const PROJECT_DIR = process.env.FABRIC_PROJECT_DIR ?? path.resolve(import.meta.dir, '../..')
const TICK_MS = 5_000
const GIT_PULSE_MS = 15 * 60_000
const GIT_PULSE_FIRST_MS = 20_000 // Task 103: צמצום-חלון-החסימה — אחרי-כל-הפעלה-מחדש התכנסות/ריפוי-עצמי תוך 20ש' (לקח-חי: rebase-יתום חסם-זרימה עד-הפעימה-הראשונה)
const EVOLUTION_PULSE_MS = 5 * 60_000 // Task 29: 10→5 דק' — "טפל בפתוחים בצורה הטובה ביותר" (התקציב השעתי 12 קושר בדיוק)
const EVOLUTION_PULSE_FIRST_MS = 120_000
const BUILD_PULSE_MS = 10 * 60_000 // Task 32: עורק-הבנייה — 6 פעימות/שעה = התקציב השעתי בדיוק
const BUILD_PULSE_FIRST_MS = 4 * 60_000
const OPS_PULSE_MS = 10 * 60_000 // Task 44: עורק-הריבונות — הלב מריץ את הטיק העצמי ומרוקן מלאי
const OPS_PULSE_FIRST_MS = 90_000
const SELFTEST_PULSE_MS = 30 * 60_000 // Task 45: עורק-ז — הלב מוכיח את סרט-הכלים שלו ברציפות
const CLAIMS_PULSE_MS = 30 * 60_000 // Task 90: עורק-ט"ו — בודק-הטענות: כל-הצהרה נשפטת-חי
const CLAIMS_PULSE_FIRST_MS = 90_000
const SOVEREIGNTY_PULSE_MS = 30 * 60_000 // Task 92: עורק-י"ז — מד-הריבונות: הארכיטקטורה מודדת-את-עצמה-כבעלים, בכנות
const SOVEREIGNTY_PULSE_FIRST_MS = 2 * 60_000
const MAGNITUDE_PULSE_MS = 30 * 60_000 // Task 93: עורק-יח — מד-העוצמה: "פי-1000-מהבעלים" נמדד-בכנות, לא-מוצהר
const MAGNITUDE_PULSE_FIRST_MS = 3 * 60_000
const SELFTEST_PULSE_FIRST_MS = 3 * 60_000
// Task 97: עורק-הזדמנות-שנייה — משימות-FAILED-ממחלקות-חולפות (rate-limit/provider/...)
// חוזרות-לתור כל-15דק' (Task 98: קצב-מוגבר — ה-route כופה-צינון-30דק' ותקרה-8; כאן-הקצב-התואם-בלבד).
const RECOVERY_PULSE_MS = 15 * 60_000
const RECOVERY_PULSE_FIRST_MS = 5 * 60_000
// Task 97: עורק-ההשלמה — גשר-סגירת-הלולאה של קיר-הצמיחה: הצעות-PROPOSED הופכות
// למשימות-CODE-אמיתיות (זריעה) ומשימות-יישום-שהושלמו מכתירות-הצעה-APPLIED (קציר).
// Task 98: 15דק' × זריעה-כפולה — איטרציית-מועמדים במקום-רעב-צינון.
const DISPATCH_PULSE_MS = 15 * 60_000
const DISPATCH_PULSE_FIRST_MS = 7 * 60_000
const TREASURY_PULSE_MS = 30 * 60_000 // Task 101: עורק-הקופה — אימות-כספת FixedFloat חי (1 יחידת-משקל לפעימה — ריחוק-בטוח מתקרת-250/דק')
const TREASURY_PULSE_FIRST_MS = 9 * 60_000
const FLOW_PULSE_MS = 60_000 // Task 104: עורק-אבחון-הזרימה — "איפה-הזרימה-חסומה-עכשיו" כל-דקה
const FLOW_PULSE_FIRST_MS = 20_000
const RESTORE_PULSE_MS = 6 * 60 * 60_000 // Task 70: עורק-ח — הוכחה-קבועה שהכפילות-הרחוקה מחזירה-מערכת-שלמה
const RESTORE_PULSE_FIRST_MS = 150_000
// מחזור-חדשנות #12 (Task 79): עורק-ח-bis — תרגיל-התמונה-השעתית (מקור-שני, בלתי-תלוי בגיט).
// פעימת-ניטור כל-5דק' (התרגיל בן-עשרות-מילישניות) — גילוי-תקלה תוך-≤5דק'; הדילוג-הכן-המובנה
// ב-runRestoreDrill (דילוג-אם-תרגיל-טרי-מ-30דק') הוא-שקובע-את-הקצב-האמיתי: ריצה-מאומתת-
// חתומה כל-30דק', וביניהן — פעימות-skipped-כנות שמוכיחות-שהפעימה-חיה. 45ש' אחרי-עליית-הלב.
// הקדמה-מכוונת לדילוג-עם-מנעול-הריצה — שני-התרגילים לעולם לא במקביל.
const SNAPSHOT_RESTORE_PULSE_MS = 5 * 60_000
const SNAPSHOT_RESTORE_PULSE_FIRST_MS = 45_000
// מחזור-חדשנות #13 (Task 80): עורק-ג — המקור-השלישי-מגוון-הפורמט (ייצוא-JSONL-בגיט).
// שתי-פעימות: (א) סנכרון-הייצוא כל-10דק' — append-only-מול-הייצור; פעימת-הדופק-הגיטית
// (כל-15דק') מכניסה-אותו-להיסטוריית-הגיט — הטקסט-החתום-חי-שם-לנצח. (ב) תרגיל-המקור
// כל-30דק' (אותו-מנעול-ריצה-והדילוג-הכן-של-שאר-העורקים) — אימות-הטקסט-בזיכרון-מה-Genesis,
// בלי-SQLite-כלל. 60ש'/120ש' אחרי-עליית-הלב — הסנכרון-מקדים-את-התרגיל.
const EXPORT_SYNC_PULSE_MS = 10 * 60_000
const EXPORT_SYNC_PULSE_FIRST_MS = 60_000
const EXPORT_RESTORE_PULSE_MS = 30 * 60_000
const EXPORT_RESTORE_PULSE_FIRST_MS = 120_000
// Task 95: עורק-ח-tris — תרגיל-המראה-המקומית. המקור-הרביעי: בלי-רשת, בלי-גיט-מרוחק.
// אם-הסנדבוקס-נמחק-והרשת-מתה — זו-ההוכחה-הקבועה-שההישרדות-המקומית-משחזרת-באמת.
const MIRROR_RESTORE_PULSE_MS = 30 * 60_000
const MIRROR_RESTORE_PULSE_FIRST_MS = 180_000
// מחזור-חדשנות #14 (Task 81): עורק-ט — תרגיל-אטימות-ההיסטוריה.
// כל-שעה: POST /api/sovereign/history-drill — הייצוא-מהקומיט-העתיק-ביותר-במראה-ה-bare
// נחשב-מחדש-מה-Genesis-בזיכרון-ומוצלב-כקידומת-ביט-ביט-מול-הייצור. שלושת-התרגילים-
// הקיימים-מוכיחים-את-ההווה; הזה-מוכיח-שהעבר-לא-נשכתה (אף-force-push/שכתוב-שקט-לא-יעבור-בשקט).
// 90ש' אחרי-עליית-הלב; הדילוג-הכן-המובנה (טרי-מ-30דק') קובע-את-הקצב-האמיתי.
const HISTORY_PULSE_MS = 60 * 60_000
const HISTORY_PULSE_FIRST_MS = 90_000
// מחזור-חדשנות #15 (Task 82): עורק-יא — תרגיל-אטימות-המסמכים.
// כל-30דק': POST /api/sovereign/docs-drill — פסיפס-המסמכים שהרשת-בונה-בעצמה
// (sovereign/site/*.md) נבחן-ונחתם-כ-digest-קנוני-בשרשרת: כל-שורה-חייבת-קובץ,
// כל-קובץ-חייב-frontMatter-תקין. פגיעה-שקטה-בקובץ = digest-שונה = חתום.
// 75ש' אחרי-עליית-הלב; הדילוג-הכן-המובנה (טרי-מ-30דק') קובע-את-הקצב-האמיתי.
const DOCS_PULSE_MS = 30 * 60_000
const DOCS_PULSE_FIRST_MS = 75_000
// מחזור-חדשנות #16 (Task 83): עורק-יב — תרגיל-אטימות-היסטוריית-המסמכים.
// כל-שעה: POST /api/sovereign/docs-history-drill — המסמכים-מהקומיט-העתיק-ביותר-במראה-
// ה-bare מוצלבים-ביט-ביט-מול-הדיסק-החי (הפסיפס-append-only). שכתוב-שקט-של-מסמך-ישן
// = docs-history-tampered = חתום. 105ש' אחרי-עליית-הלב; דילוג-כן-אם-טרי-מ-60דק'.
const DOCS_HISTORY_PULSE_MS = 60 * 60_000
const DOCS_HISTORY_PULSE_FIRST_MS = 105_000
const NARRATE_TIMEOUT_MS = 120_000 // Task 39: ירי-TTS אמיתי — מהיר, אך-נותנים-רשת
const APP_GUARD_MS = 15_000
const APP_GUARD_FAILS_TO_RESTART = 3
// מחזור-הרפואה-החיה (2026-10-20): עורק-יג — הלב משגיח על הזקיפה.
// הלקח-החי: הזקיפה מתה 03:40 ואף-שכבה לא שמה-לב ~45 דק׳ — היא-המשגיחה, ואיש-לא-השגיח-עליה.
// מעתה: השגחה-הדדית בתחומי-אחריות מובחנים — הזקיפה מחיה לב+עד; הלב מחיה אפליקציה+זקיפה;
// העד (קריאה-בלבד) מעיד על-השרשרת; ה-selftest חותם-את-מצב-הכל-בשרשרת (status כנה).
const KEEPER_GUARD_MS = 15_000
const KEEPER_GUARD_FAILS_TO_RESTART = 3
const KEEPER_GUARD_BACKOFF_MS = 60_000

interface State {
  startedAt: string
  ticks: number
  tickBusy: boolean
  picked: number
  executed: number
  lastTickAt: string | null
  lastTickError: string | null
  gitPulses: number
  gitPushes: number
  dbConflictsResolved: number
  lastGitPulseAt: string | null
  lastGitPulseResult: string | null
  gitHeals: number
  lastGitHealAt: string | null
  lastGitHealResult: string | null
  evolutionPulses: number
  evolutionQueued: number
  lastEvolutionAt: string | null
  lastEvolutionResult: string | null
  buildPulses: number
  buildApplied: number
  lastBuildAt: string | null
  lastBuildResult: string | null
  opsPulses: number
  opsDelivered: number
  lastOpsAt: string | null
  lastOpsResult: string | null
  selftestPulses: number
  selftestPasses: number
  selftestFails: number
  lastSelftestAt: string | null
  lastSelftestResult: string | null
  claimsPulses: number
  claimsActive: number
  claimsDegraded: number
  lastClaimsAt: string | null
  lastClaimsResult: string | null
  sovereigntyPulses: number
  sovereigntyLevel: number
  sovereigntyOverall: string
  lastSovereigntyAt: string | null
  lastSovereigntyResult: string | null
  magnitudePulses: number
  magnitudeCore: number | null
  lastMagnitudeAt: string | null
  lastMagnitudeResult: string | null
  gapEvolutions: number
  lastGapEvolutionAt: string | null
  lastGapEvolutionResult: string | null
  narrations: number
  narrationFails: number
  lastNarrationAt: string | null
  lastNarrationResult: string | null
  appRestarts: number
  appRssRecycles: number
  lastAppRssMb: number | null
  lastAppGuardAt: string | null
  lastAppGuardResult: string | null
  keeperRestarts: number
  lastKeeperGuardAt: string | null
  lastKeeperGuardResult: string | null
  lastRemoteGateAt: string | null
  lastRemoteGateResult: string | null
  dbFileReplaced: number
  lastReconnectResult: string | null
  restorePulses: number
  restoreOk: boolean | null
  lastRestoreAt: string | null
  lastRestoreResult: string | null
  snapshotRestorePulses: number
  snapshotRestoreOk: boolean | null
  lastSnapshotRestoreAt: string | null
  lastSnapshotRestoreResult: string | null
  exportSyncPulses: number
  exportSyncOk: boolean | null
  lastExportSyncAt: string | null
  lastExportSyncResult: string | null
  exportRestorePulses: number
  exportRestoreOk: boolean | null
  lastExportRestoreAt: string | null
  lastExportRestoreResult: string | null
  mirrorRestorePulses: number
  mirrorRestoreOk: boolean | null
  lastMirrorRestoreAt: string | null
  lastMirrorRestoreResult: string | null
  historyPulses: number
  historyOk: boolean | null
  lastHistoryAt: string | null
  lastHistoryResult: string | null
  docsPulses: number
  docsOk: boolean | null
  lastDocsAt: string | null
  lastDocsResult: string | null
  docsHistoryPulses: number
  docsHistoryOk: boolean | null
  lastDocsHistoryAt: string | null
  lastDocsHistoryResult: string | null
  recoveryPulses: number
  recoveredTasks: number
  lastRecoveryAt: string | null
  lastRecoveryResult: string | null
  dispatchPulses: number
  dispatchSown: number
  dispatchHarvested: number
  lastDispatchAt: string | null
  lastDispatchResult: string | null
  starvedTicks: number // Task 103: ספירת-טיקי-רעב (תור-ריק)
  starveSupplies: number // Task 103: כמה-פעמים-האספקה-המונעת-רעב-ירתה
  lastStarveSupplyAt: string | null
  treasuryPulses: number
  treasuryOk: boolean | null
  treasuryAuth: boolean | null
  lastTreasuryAt: string | null
  lastTreasuryResult: string | null
  flowPulses: number // Task 104: עורק-אבחון-הזרימה
  flowBlocked: number // כמה-אבחנות-מצאו-זרימה-חסומה
  flowDegraded: number // כמה-אבחנות-מצאו-זרימה-נגוסה
  flowActions: number // כמה-פעמים-הזניק-עורקי-ניקוז בעקבות-אבחון
  lastFlowAt: string | null
  lastFlowState: string | null
  lastFlowResult: string | null
}

const state: State = {
  startedAt: new Date().toISOString(),
  ticks: 0,
  tickBusy: false,
  picked: 0,
  executed: 0,
  lastTickAt: null,
  lastTickError: null,
  gitPulses: 0,
  gitPushes: 0,
  dbConflictsResolved: 0,
  lastGitPulseAt: null,
  lastGitPulseResult: null,
  gitHeals: 0,
  lastGitHealAt: null,
  lastGitHealResult: null,
  evolutionPulses: 0,
  evolutionQueued: 0,
  lastEvolutionAt: null,
  lastEvolutionResult: null,
  buildPulses: 0,
  buildApplied: 0,
  lastBuildAt: null,
  lastBuildResult: null,
  opsPulses: 0,
  opsDelivered: 0,
  lastOpsAt: null,
  lastOpsResult: null,
  selftestPulses: 0,
  selftestPasses: 0,
  selftestFails: 0,
  lastSelftestAt: null,
  lastSelftestResult: null,
  claimsPulses: 0,
  claimsActive: 0,
  claimsDegraded: 0,
  lastClaimsAt: null,
  lastClaimsResult: null,
  sovereigntyPulses: 0,
  sovereigntyLevel: 0,
  sovereigntyOverall: 'unmeasured',
  lastSovereigntyAt: null,
  lastSovereigntyResult: null,
  magnitudePulses: 0,
  magnitudeCore: null,
  lastMagnitudeAt: null,
  lastMagnitudeResult: null,
  gapEvolutions: 0,
  lastGapEvolutionAt: null,
  lastGapEvolutionResult: null,
  narrations: 0,
  narrationFails: 0,
  lastNarrationAt: null,
  lastNarrationResult: null,
  appRestarts: 0,
  appRssRecycles: 0,
  lastAppRssMb: null,
  lastAppGuardAt: null,
  lastAppGuardResult: null,
  keeperRestarts: 0,
  lastKeeperGuardAt: null,
  lastKeeperGuardResult: null,
  lastRemoteGateAt: null,
  lastRemoteGateResult: null,
  dbFileReplaced: 0,
  lastReconnectResult: null,
  restorePulses: 0,
  restoreOk: null,
  lastRestoreAt: null,
  lastRestoreResult: null,
  snapshotRestorePulses: 0,
  snapshotRestoreOk: null,
  lastSnapshotRestoreAt: null,
  lastSnapshotRestoreResult: null,
  exportSyncPulses: 0,
  exportSyncOk: null,
  lastExportSyncAt: null,
  lastExportSyncResult: null,
  exportRestorePulses: 0,
  exportRestoreOk: null,
  lastExportRestoreAt: null,
  lastExportRestoreResult: null,
  mirrorRestorePulses: 0,
  mirrorRestoreOk: null,
  lastMirrorRestoreAt: null,
  lastMirrorRestoreResult: null,
  historyPulses: 0,
  historyOk: null,
  lastHistoryAt: null,
  lastHistoryResult: null,
  docsPulses: 0,
  docsOk: null,
  lastDocsAt: null,
  lastDocsResult: null,
  docsHistoryPulses: 0,
  docsHistoryOk: null,
  lastDocsHistoryAt: null,
  lastDocsHistoryResult: null,
  recoveryPulses: 0,
  recoveredTasks: 0,
  lastRecoveryAt: null,
  lastRecoveryResult: null,
  dispatchPulses: 0,
  dispatchSown: 0,
  dispatchHarvested: 0,
  lastDispatchAt: null,
  lastDispatchResult: null,
  starvedTicks: 0,
  starveSupplies: 0,
  lastStarveSupplyAt: null,
  treasuryPulses: 0,
  treasuryOk: null,
  treasuryAuth: null,
  lastTreasuryAt: null,
  lastTreasuryResult: null,
  flowPulses: 0,
  flowBlocked: 0,
  flowDegraded: 0,
  flowActions: 0,
  lastFlowAt: null,
  lastFlowState: null,
  lastFlowResult: null,
}

let lastTickAttemptMs = Date.now()

function log(msg: string): void {
  console.log(`[heartbeat ${new Date().toISOString()}] ${msg}`)
}

// ===== עורק-א: לולאת-tick =====
async function tick(): Promise<void> {
  if (state.tickBusy) return // ירי-קודם עדיין בביצוע — אין ערימת-קריאות
  state.ticks++
  state.tickBusy = true
  state.lastTickAt = new Date().toISOString()
  lastTickAttemptMs = Date.now()
  try {
    // timeout חוזי: ירי-אמת יכול לקחת דקות; אבל לעולם לא תלייה-אינסופית (לקח-10:34)
    // Task 97+98: lanes=3 — תקרת-התור-הנגוס מנוצלת-מלאה; ה-claim-האטומי מוכח.
    const res = await fetch(`${APP_URL}/api/worker/tick?lanes=3`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) {
      state.lastTickError = `HTTP ${res.status}`
      return
    }
    const d = (await res.json()) as { picked?: number; executed?: boolean | number; status?: string }
    state.lastTickError = null
    if (d.picked) {
      state.picked++
      const done = typeof d.executed === 'number' ? d.executed : d.executed ? 1 : 0
      state.executed += done
      log(`tick: נקלטו ${d.picked} (lanes) → בוצעו ${done} (סה"כ בוצעו: ${state.executed})`)
    } else {
      // Task 103 — אספקה-מונעת-רעב: תור-ריק אינו-עוד-מנוחה-עד-הפעימה-המתוכננת-בעוד-עד-15 דק'.
      // רעב-מזוהה-חי (picked=0) → ירי-עורקי-אספקה-מיידי-עם-צינון-5דק' (מנע-סערה-על-עורקים-עם-צינון-עצמי).
      state.starvedTicks++
      void maybeStarveSupply()
    }
  } catch (e) {
    state.lastTickError = e instanceof Error ? e.message : String(e)
    // השרת כבוי/מופעל-מחדש — שקט, הלולאה תנסה שוב; אף שקר לא נאמר כאן
  } finally {
    state.tickBusy = false
  }
}

// ===== עזרי-גיט (spawnSync — פשוט ובטוח) =====
function git(args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(['git', ...args], { cwd: PROJECT_DIR, stdout: 'pipe', stderr: 'pipe' })
  return { ok: p.exitCode === 0, out: `${p.stdout ?? ''}${p.exitCode === 0 ? '' : '\n' + (p.stderr ?? '')}` }
}

// ===== עד-ראש-אמת (Task 130): ls-remote מול-origin עצמו =====
// כש-API-הריצות-הרחוק חסום (api:404 — חסימת-חיוב, סמכות-בעלים בלבד, חוק-אדום),
// השער-הרחוק לא הופך לעד-שקט: ls-remote מול-גיטהאב מוכיח את-עורק-הדחיפה מקצה-לקצה.
function remoteHeadWitness(): string | null {
  try {
    const r = git(['ls-remote', 'origin', 'main'])
    if (!r.ok) return null
    const remoteHead = (r.out.split('\n')[0] ?? '').split('\t')[0]?.trim() ?? ''
    if (!/^[0-9a-f]{40}$/i.test(remoteHead)) return null
    const localHead = git(['rev-parse', 'HEAD']).out.trim()
    if (remoteHead === localHead) return 'ok — origin/main==HEAD (עד-גיטהאב-חי; API-הריצות-חסום-חיוב — סמכות-בעלים)'
    return `origin/main ${remoteHead.slice(0, 7)} != local ${localHead.slice(0, 7)} — ממתין-לפעימת-הדחיפה`
  } catch {
    return null
  }
}

// ===== פתרון-קונפליקט-db עצמי (Task 27) — הוכחת-הכלה מהשרשרת, אפס-שערות =====

// נתיבים-בקונפליקט (unmerged) בזמן-rebase. רשימה-ריקה = אין-קונפליקט-מסומן או-כשל-סטטוס.
function unmergedPaths(): string[] {
  const st = git(['status', '--porcelain'])
  if (!st.ok) return ['__status_failed__']
  return st.out
    .split('\n')
    .filter(Boolean)
    .filter((l) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(l))
    .map((l) => l.slice(3).trim())
}

// האם-השרשרת-המקומית על-קבוצה של הרחוקה? ראש-origin/main חייב-להיות-בשרשרת-המקומית
// (בדיוק-פעם-אחת) וספירה-מקומית ≥ רחוקה. כל-חריגה = false — abort כנה, אף-הימור.
function ledgerSupersetOK(): boolean {
  try {
    const show = Bun.spawnSync(['git', 'show', 'origin/main:db/custom.db'], {
      cwd: PROJECT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (show.exitCode !== 0 || !show.stdout || show.stdout.length === 0) return false
    const tmp = `${PROJECT_DIR}/.git/fabric-remote-db.tmp`
    writeFileSync(tmp, show.stdout)
    const local = new Database(`${PROJECT_DIR}/db/custom.db`, { readonly: true })
    const remote = new Database(tmp, { readonly: true })
    const rHead = remote.query('SELECT hash FROM LedgerEntry ORDER BY id DESC LIMIT 1').get() as
      | { hash: string }
      | null
    const rCount = (remote.query('SELECT COUNT(*) AS c FROM LedgerEntry').get() as { c: number }).c
    const lCount = (local.query('SELECT COUNT(*) AS c FROM LedgerEntry').get() as { c: number }).c
    const headInLocal = rHead
      ? (local
          .query('SELECT COUNT(*) AS c FROM LedgerEntry WHERE hash = ?')
          .get(rHead.hash) as { c: number }).c
      : 0
    local.close()
    remote.close()
    return !!rHead && headInLocal === 1 && lCount >= rCount
  } catch {
    return false
  }
}

// ===== ריפוי-מצב-גיט עצמי (Task 87) — הלקח-החי מאירוע-הסנדבוקס 2026-10-20 =====
// הזקיפה מחיה את-תהליך-הלב — אך-לב-שמוחזר-לחיים אל-תוך rebase/merge תקוע (ריצה-קודמת-שמתה)
// נתקע-שוב-בכל-פעימה. הריפוי: abort → התכנסות-מול-origin בשימור-בייטים של db-החי.
function gitStuckState(): 'rebase' | 'merge' | null {
  if (existsSync(`${PROJECT_DIR}/.git/rebase-merge`) || existsSync(`${PROJECT_DIR}/.git/rebase-apply`)) return 'rebase'
  if (existsSync(`${PROJECT_DIR}/.git/MERGE_HEAD`)) return 'merge'
  return null
}

// התכנסות-מול-origin: הענף והעץ מתיישרים ל-origin/main; db/custom.db לעולם-לא-נוגע
// (האפליקציה-החיה כותבת אליו; WAL שייך-לקובץ-החי). אם-השרשרת-המקומית על-קבוצה של-הרחוקה
// (superset מוכח — אותו-חוק של Task 27) — גם-הייצוא-המקומי נשמר (על-יותר; סנכרון-הייצוא יאמת).
// אם-לא — הייצוא מתכנס-ל-origin (המקור=origin לפי חוק-אי-האמון) ו-db-החי מוחלף-בשלם-הרחוק
// (החלפת-db תחת-אפליקציה-חיה היא-זרימה-מוכחת: עורק-ב מנטר-inode ומחבר-מחדש דרך db-reconnect).
function resyncFromOrigin(reason: string): boolean {
  state.lastGitHealAt = new Date().toISOString()
  const fetch = git(['fetch', 'origin'])
  if (!fetch.ok) {
    state.lastGitHealResult = `heal(${reason}): fetch failed`
    log(`ריפוי-גיט: fetch נכשל — ${fetch.out.split('\n')[0] ?? ''} (כנות; ינסה-בפעימה-הבאה)`)
    return false
  }
  const oldTip = git(['rev-parse', 'HEAD'])
  const oldSha = oldTip.ok ? oldTip.out.trim().split('\n')[0] : null
  const superset = ledgerSupersetOK()
  const reset = git(['reset', '-q', 'origin/main']) // ממוזג: ענף+אינדקס→origin, עץ-לא-נוגע
  if (!reset.ok) {
    state.lastGitHealResult = `heal(${reason}): reset failed`
    log(`ריפוי-גיט: reset נכשל — ${reset.out.split('\n')[0] ?? ''} (כנות)`)
    return false
  }
  // עץ→origin לכל-מה-שאינו-db-החי (ולייצוא-מקומי-כשהוא-על-קבוצה)
  const excludes = superset
    ? [':(exclude)db/custom.db', ':(exclude)sovereign/chain-export/ledger.jsonl']
    : [':(exclude)db/custom.db']
  const checkout = git(['checkout', '--', '.', ...excludes])
  if (!checkout.ok) {
    state.lastGitHealResult = `heal(${reason}): checkout failed`
    log(`ריפוי-גיט: checkout נכשל — ${checkout.out.split('\n')[0] ?? ''} (כנות)`)
    return false
  }
  // קבצים-זומבים: קיימים-בענף-המקומי-הישן, חסרים-ב-origin — מחוץ-ל-db ולארטיפקטים-האפנדים
  let staleRemoved = 0
  if (oldSha) {
    const oldList = git(['ls-tree', '-r', '--name-only', oldSha])
    const newList = git(['ls-tree', '-r', '--name-only', 'origin/main'])
    if (oldList.ok && newList.ok) {
      const oldSet = new Set(oldList.out.split('\n').filter(Boolean))
      const newSet = new Set(newList.out.split('\n').filter(Boolean))
      const stale = [...oldSet].filter(
        (p) => !newSet.has(p) && p !== 'db/custom.db' && !p.startsWith('sovereign/site/')
      )
      if (stale.length > 0) {
        const rm = git(['rm', '-qf', '--', ...stale])
        if (rm.ok) staleRemoved = stale.length
      }
    }
  }
  // מקרה-מזלג: db-החי אינו-על-קבוצה-של-origin → החלפה-בשלם-הרחוק (המקור=origin)
  if (!superset) {
    try {
      const show = Bun.spawnSync(['git', 'show', 'origin/main:db/custom.db'], {
        cwd: PROJECT_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      if (show.exitCode === 0 && show.stdout && show.stdout.length > 0) {
        const tmp = `${PROJECT_DIR}/.git/fabric-heal-db.tmp`
        writeFileSync(tmp, show.stdout)
        renameSync(tmp, `${PROJECT_DIR}/db/custom.db`)
        state.dbFileReplaced++
        log('ריפוי-גיט: שרשרת-מקומית אינה-על-קבוצה — db-החי הוחלף-בשלם-origin (inode-חדש; החיבור-מחדש יבוא-בעקבות-ניטור-ה-inode)')
      }
    } catch {
      log('ריפוי-גיט: החלפת-db-במזלג נכשלה — כנות; סנכרון-הייצוא יחשוף-את-הפער')
    }
  }
  state.gitHeals++
  state.lastGitHealResult = `healed(${reason}): superset=${superset}, staleRemoved=${staleRemoved}`
  log(`ריפוי-גיט: הושלם — ${state.lastGitHealResult} (סה"כ ריפויים: ${state.gitHeals})`)
  return true
}

// שער-הריפוי — רץ-בראש-כל-פעימת-גיט, לפני-הכל
function gitStateGuard(): boolean {
  const stuck = gitStuckState()
  if (!stuck) return true
  log(`ריפוי-גיט: נתגלה ${stuck} תקוע (ריצה-קודמת-שמתה) — abort → התכנסות-מול-origin`)
  state.lastGitHealAt = new Date().toISOString()
  const abort = git(stuck === 'rebase' ? ['rebase', '--abort'] : ['merge', '--abort'])
  if (!abort.ok) {
    state.lastGitHealResult = `heal: ${stuck} --abort failed`
    log(`ריפוי-גיט: abort נכשל — ${abort.out.split('\n')[0] ?? ''} (כנות; לא-נמשך)`)
    return false
  }
  return resyncFromOrigin(`stuck-${stuck}`)
}

// ===== עורק-ב: פעימת-גיט (RUNBOOK: pull → עבודה → סריקה → commit → rebase → push) =====
// Task 28 (ריפוי-עצמי שכבת-האחסון): pull-rebase-שמביא-שינויים מחליף-את-קובץ-ה-db
// (inode-חדש-תחת-האפליקציה) — בריכת-Prisma נשארת-על-הישן-וקוראת-מצב-מיושן-בשקט.
// אחרי-כל-פעימה: השוואת-inode; החלפה-שזוהתה → חיבור-מחדש-מיידי-של-האפליקציה-לקובץ-האמת.
function dbFileIno(): number | null {
  try {
    return statSync(`${PROJECT_DIR}/db/custom.db`).ino
  } catch {
    return null
  }
}

// Task-125: ניסיון-דחיפה-חוזר-מהיר — נמדד-חי: דחיפה-כושלת-10:09 השאירה-את-origin/main מאחור-עד-הפעימה-הבאה
// (הבעלים-ראה-"לא-קרה-כלום"-בגיט). מעתה: לא-ממתינים-15-דק' — מנסים-שוב-אחרי-60/120/240ש׳ (חסם-מקסימום-3 — אפס-עומס).
const PUSH_RETRY_DELAYS_MS = [60_000, 120_000, 240_000]
let pushRetryRound = 0
let pushRetryScheduled = false
function schedulePushRetry(): void {
  if (pushRetryScheduled) return
  if (pushRetryRound >= PUSH_RETRY_DELAYS_MS.length) {
    pushRetryRound = 0 // נגמרו-החוזרים-המהירים — הפעימה-הקבועה-תיקח (כנות, לא-לולאה-אינסופית)
    return
  }
  const delay = PUSH_RETRY_DELAYS_MS[pushRetryRound++]
  pushRetryScheduled = true
  log(`פעימת-גיט: דחיפה-כושלת — ניסיון-חוזר-${pushRetryRound} בעוד ${Math.round(delay / 1000)}ש׳`)
  setTimeout(() => {
    pushRetryScheduled = false
    void gitPulseChecked() // המסלול-המלא (כולל-בדיקת-האינוד) — לא-קיצור-דרך
  }, delay)
}

async function gitPulseChecked(): Promise<void> {
  const inoBefore = dbFileIno()
  gitPulse()
  const inoAfter = dbFileIno()
  if (inoBefore !== null && inoAfter !== null && inoBefore !== inoAfter) {
    state.dbFileReplaced++
    log(`פעימת-גיט: קובץ-ה-db הוחלף (inode ${inoBefore}→${inoAfter}) — מחבר-מחדש-את-האפליקציה`)
    try {
      const res = await fetch(`${APP_URL}/api/admin/db-reconnect`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      })
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; ledgerCount?: number }
      state.lastReconnectResult =
        res.ok && d.ok ? `reconnected (ledger: ${d.ledgerCount ?? '?'})` : `failed: HTTP ${res.status}`
      log(`חיבור-מחדש: ${state.lastReconnectResult}`)
    } catch (e) {
      state.lastReconnectResult = `error: ${e instanceof Error ? e.message : String(e)}`
      log(`חיבור-מחדש: כשל-כן — ${state.lastReconnectResult}`)
    }
  }
}

function gitPulse(): void {
  state.gitPulses++
  state.lastGitPulseAt = new Date().toISOString()

  // אינדקס-נעול (גיט-פעולה אחרת חיה) — דילוג כנה, הפעימה-הבאה תנסה
  // (לקח-חי: Bun.file().exists() מחזיר Promise — אמת-תמידית בתנאי; existsSync בלבד)
  if (existsSync(`${PROJECT_DIR}/.git/index.lock`)) {
    state.lastGitPulseResult = 'skipped: git busy (index.lock)'
    return
  }

  // ריפוי-מצב-גיט (Task 87) — לפני-הכל: rebase/merge תקועים מריצה-קודמת-שמתה
  if (!gitStateGuard()) {
    state.lastGitPulseResult = 'skipped: git-state heal failed — כנות'
    return
  }

  // Task-126: התכנסות-מוקדמת אחרי-אירועי-שחזור (פלטפורמה/מכונה) — נמדד-חי 12:12-12:28:
  // שחזור-פלטפורמה החזיר-ענף+עץ-לאתמול (reflog-מתחיל-מחדש, src/-חסר, dex-מת), הרחוק-המשיך-קדימה,
  // והפעימות-נתקעות-ב-pull-rebase-abort-לנצח. מעתה: אם-הענף-סטה-מהרחוק וכל-הקומיטים-המקומיים-בלבד
  // הם-תמונות-פעימה-מתכלות — מתכנסים-לorigin/main (ענף+עץ→רחוק; db-החי-מוגן-בהוצאה-מה-checkout)
  // וממשיכים-פעימה-רגילה. עבודה-מקומית-אמיתית (שאינה-פעימה) לעולם-לא-נדרסת — ממשיך-למיזוג-רגיל.
  const preFetch = git(['fetch', 'origin'])
  // Task-130-c: תוצאת-ה-fetch נשמרת — אם-הרחוק-נייח (ro=0) ה-pull-rebase אחרי-הקומיט הוא
  // נו-אופ שיכול-רק-להיכשל (העץ-החי נשמר-מטונפן-תדידות — השרשרת כותבת) ולחסום-את-העורק
  // לנצח (נמדד-חי 15:28: "abort כנה" על-כל-חוזר). כשאין-מה-למשוך — דחיפה-ישירה על-העץ-החי.
  let remoteNew = -1 // -1 = לא-ידוע (fetch נכשל) — נתנהג-כמו-קודם
  if (preFetch.ok) {
    const remoteOnly = git(['rev-list', '--count', 'HEAD..origin/main'])
    const localOnly = git(['rev-list', '--count', 'origin/main..HEAD'])
    const ro = remoteOnly.ok ? parseInt(remoteOnly.out.trim(), 10) || 0 : 0
    const lo = localOnly.ok ? parseInt(localOnly.out.trim(), 10) || 0 : 0
    remoteNew = ro
    if (ro > 0 && lo > 0) {
      const names = git(['log', '--format=%s', 'origin/main..HEAD'])
      const allPulse =
        names.ok && names.out.split('\n').filter(Boolean).every((s) => s.startsWith('fabric-heartbeat: auto-pulse'))
      if (allPulse) {
        if (resyncFromOrigin('diverged-auto-pulse-only')) {
          state.lastGitPulseResult = 'resynced→origin/main (סטיית-פעימות-בלבד; db-החי-נשמר)'
          log('פעימת-גיט: התכנסות-לorigin/main אחרי-סטייה — קומיטי-פעימה-מתכלים-הומסו, db-החי-מוגן')
        }
      } else {
        log(`פעימת-גיט: סטייה-עם-עבודה-מקומית-אמיתית (${lo} מקומי מול ${ro} ברחוק) — אין-דריסה, pull-rebase רגיל ימזג`)
      }
    }
  }

  const status = git(['status', '--porcelain'])
  if (!status.ok) {
    state.lastGitPulseResult = 'skipped: git status failed'
    log('פעימת-גיט: status נכשל — מדלג (כנות)')
    return
  }
  const dirty = status.out.trim().length > 0
  const nFiles = status.out.trim().split('\n').length

  // אם-יש-שינויים: הצבה → חסם-הדליפות → commit מקומי (RUNBOOK: scan → commit → rebase → push)
  if (dirty) {
    const add = git(['add', '-A'])
    if (!add.ok) {
      state.lastGitPulseResult = 'git add failed'
      return
    }

    // חסם-הדליפות — אפס-התאמות או-אין-push (RUNBOOK כלל-4)
    const scan = Bun.spawnSync(['node', '.zscripts/leak-scan.mjs', '--staged'], {
      cwd: PROJECT_DIR,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (scan.exitCode !== 0) {
      const errText = `${scan.stderr ?? ''}`
      const tail = errText.split('\n').filter(Boolean).slice(-1)[0] ?? 'scan failed'
      state.lastGitPulseResult = `BLOCKED: leak-scan — ${tail}`
      log(`פעימת-גיט: 🚨 סריקת-דליפות חוסמת — אין-push. ${tail}`)
      git(['reset']) // ביטול-ההוספה — הסוד לא יידחף גם-בטעות
      return
    }

    const commit = git(['commit', '-m', `fabric-heartbeat: auto-pulse — ${nFiles} changed files`])
    if (!commit.ok) {
      state.lastGitPulseResult = 'commit failed — כנות'
      return
    }
  }

  // pull-rebase אחרי-commit (העץ נקי עתה); קונפליקט-db = פתרון-עצמי מוכח-שרשרת (Task 27)
  // Task-130-c: רק-כשהרחוק התקדם (remoteNew>0) או-שאינו-ידוע (-1). רחוק-נייח + עץ-חי →
  // דילוג-כן על-ה-pull (היה-נכשל "unstaged changes" בלי-קונפליקט-אמיתי) — push ישיר מטה.
  // Task-132: ההחלטה נמדדת עכשיו — לא מהתפיסה-המיושנת שלפני-הריפוי/הקומיט. נמדד-חי 14:44
  // (אחרי-אתחול-הפלטפורמה): סטייה ro>0 → resyncFromOrigin ריפא לorigin/main, אך remoteNew נשאר >0
  // → pull-rebase מיותר על עץ-חי (השרשרת כותבת בין-לין) → "unstaged changes" → abort כנה
  // → עורק תקוע מחזור-שלם (15 דק'). מעתה: דלתא-רחוק טרייה רגע-ההחלטה.
  let pull: { ok: boolean; out: string } = { ok: true, out: 'skipped: remote-static — דחיפה-ישירה על-עץ-חי (Task-130-c)' }
  if (remoteNew !== 0) {
    const fresh = git(['rev-list', '--count', 'HEAD..origin/main'])
    const freshRemote = fresh.ok ? parseInt(fresh.out.trim(), 10) || 0 : remoteNew
    if (freshRemote === 0) {
      log('פעימת-גיט: הרחוק נבלע במקומי (נמדד-טרי אחרי-הריפוי/הקומיט) — דילוג-כן על pull מיותר (Task-132)')
    } else {
      pull = git(['pull', '--rebase', 'origin', 'main'])
    }
  }
  if (!pull.ok) {
    // Task-132: נו-אופ מוכח — pull נכשל בלי-קונפליקט-מסומן והמקומי מכיל-את-הרחוק (is-ancestor מדוד):
    // ה-rebase לא היה ממזג-כלום; כישלונו ("unstaged changes" על עץ-חי) חוסם-דחיפה בחינם.
    // כנות: דילוג-על-ה-pull בשם-האמת-המדודה ודחיפה-ישירה. הרחוק-מחזיק-מה-שאין-במקומי → abort כנה כרגיל.
    if (unmergedPaths().length === 0 && git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD']).ok) {
      log('פעימת-גיט: pull-rebase נכשל על עץ-חי אך המקומי מכיל-את-הרחוק (מדוד) — נו-אופ כנה, דחיפה-ישירה (Task-132)')
      state.lastGitPulseResult = 'pull no-op (superset מדוד, אין-קונפליקט) — דחיפה-ישירה על-עץ-חי (Task-132)'
    } else {
    let rounds = 0
    for (let i = 0; i < 5 && !pull.ok; i++) {
      const unmerged = unmergedPaths()
      if (unmerged.length === 0) break // אין-קונפליקט-מסומן — לא-ניחש
      if (!unmerged.every((p) => p === 'db/custom.db')) break // קוד/worklog בקונפליקט — abort כנה
      if (!ledgerSupersetOK()) break // הרחוק-מחזיק-מה-שאין-במקומי — אף-הימור, abort כנה
      git(['checkout', '--theirs', 'db/custom.db'])
      git(['add', 'db/custom.db'])
      pull = git(['-c', 'core.editor=true', 'rebase', '--continue'])
      if (!pull.ok && unmergedPaths().length === 0) {
        // קומיט-שהתרוקן (נספג-כבר-ברחוק) — דילוג-כנה
        pull = git(['rebase', '--skip'])
      }
      rounds++
    }
    if (!pull.ok) {
      git(['rebase', '--abort'])
      state.lastGitPulseResult = `pull-rebase conflict — auto-resolve ${rounds > 0 ? `(${rounds} db rounds, הוכח-שרשרת)` : 'לא-רלוונטי'} → abort כנה, ינסה-שוב`
      log('פעימת-גיט: pull-rebase נכשל — abort כנה. הקומיט-המקומי נשמר, אין-push')
      return
    }
    if (rounds > 0) {
      state.dbConflictsResolved += rounds
      log(
        `פעימת-גיט: קונפליקט-db נפתר עצמית (${rounds} מחזורים) — שרשרת-מקומית הוכחה-על-קבוצה (סה"כ: ${state.dbConflictsResolved})`
      )
    }
    }
  }

  // Task-119: ריפוי-אינוד-קבצי-מצב — rebase שהחליף-קובץ-מצב-תחת-איבר-חי משאיר-אותו
  // כותב-לצינור-מת (אינוד-יתום) בזמן-שהקובץ-על-הדיסק הוא-האמת-החדשה. נגיעה ב-index.ts
  // של-האיבר = טעינה-מחדש על-הקובץ-החדש. הפנקס-מבוסס-שרשרת (fill_ledger) → אפס-אובדן-אמת.
  try {
    const scope = git(['diff', '--name-only', 'ORIG_HEAD', 'HEAD'])
    const remoteApplied = /Fast-?forward|Successfully rebased|Merge made/.test(pull.out || '')
    if (scope.ok && remoteApplied) {
      const organs = new Set<string>()
      for (const line of scope.out.split('\n')) {
        const f = line.trim()
        const m = f.match(/^mini-services\/([^/]+)\//)
        if (m && /state\/.+\.(db|db-shm|db-wal|json)$/.test(f)) organs.add(m[1])
      }
      for (const o of organs) {
        const idx = `${PROJECT_DIR}/mini-services/${o}/index.ts`
        if (existsSync(idx)) {
          const t = Bun.spawnSync(['touch', idx])
          if (t.exitCode === 0) log(`פעימת-גיט: איבר ${o} הוקפץ — מצב-הוחלף-תחתיו-ב-rebase → טעינה-מחדש-על-האמת`)
        }
      }
      if (organs.size > 0) state.lastGitPulseResult = `pushed (+${organs.size} organs bounced: ${[...organs].join(',')})`
    }
  } catch {}

  // Task-125: מדידת-מה-לא-דחוף — עץ-נקי-עם-קומיט-מקומי-שטרם-נדחף (דחיפה-כושלת-קודמת) היה
  // נופל-ל-'clean — אין-מה-לדחוף'-שקרי-ונשאר-תקוע-לנצח. מעתה: נמדד-בפועל מול-origin/main.
  let ahead = 0
  const aheadRes = git(['rev-list', '--count', 'origin/main..HEAD'])
  if (aheadRes.ok) ahead = parseInt(aheadRes.out.trim(), 10) || 0

  if (!dirty && ahead === 0) {
    state.lastGitPulseResult = 'clean — אין-שינויים לדחוף'
    return
  }

  const push = git(['push', 'origin', 'main'])
  if (!push.ok) {
    state.lastGitPulseResult = `push failed (ahead:${ahead || 0}) — חוזר-מהיר 60/120/240ש׳`
    log('פעימת-גיט: push נדחה — ניסיון-חוזר-מהיר מתוזמן (לא-ממתין-לפעימה-הבאה)')
    schedulePushRetry()
    return
  }
  pushRetryRound = 0 // הצלחה — מונה-החוזרים-מתאפס
  state.gitPushes++
  state.lastGitPulseResult = `pushed: ${ahead > 0 && !dirty ? `${ahead} commits (מצטבר)` : `${nFiles} files`}`
  log(`פעימת-גיט: נדחף ✓ ${ahead > 0 && !dirty ? `${ahead} קומיטים-שהמתינו` : `${nFiles} קבצים`} (סה"כ דחיפות-אוטומטיות: ${state.gitPushes})`)
}

// ===== עורק-0: שומר-האפליקציה (Task 26) — הרשת מרפאת-את-עצמה =====
let appGuardFails = 0
let appGuardBusy = false

// מחזור-הזיכרון-החי (Task 130-b): תקרת-RSS לשרת-ה-dev — ה-heap-cap מגביל רק את-ערימת-V8;
// ה-RSS-האמיתי (מפות-מקור, טורבופק, מאגרים-חוץ-ערימתיים) צומח-ללא-תקרה והגרעין כבר הרג את-השרת
// ב-2.1GB תוך-כ-35דק' גם-עם-התקרה. מעתה: הלב מודד-את-ה-RSS בעצמו (VmRSS מ-/proc) וממחזר
// את-השרת מעל-התקרה — מיחזור-ממושמע של-שרת-dev במקום-הריגת-OOM עיוורת של-הגרעין.
const APP_RSS_CEILING_MB = 1250
function appServerRssMb(): number | null {
  try {
    const pid = Bun.spawnSync(['bash', '-c', 'pgrep -f "next-server" | head -1'], {
      cwd: PROJECT_DIR,
      stdout: 'pipe',
      stderr: 'ignore',
    }).stdout.toString().trim()
    if (!/^\d+$/.test(pid)) return null
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/)
    return m ? Math.round(parseInt(m[1] ?? '0', 10) / 1024) : null
  } catch {
    return null
  }
}
function killAndRespawnApp(reason: string): void {
  // ספון-בן-של-הלב: הלב חי-תחת-העץ-המתמיד של הפלטפורמה — ולכן הבן שורד גם-הוא.
  // מחזור-#10: לפני-הספון — הריגה-מסודרת של-שאריות-מחזיקות-פורט (EADDRINUSE).
  Bun.spawnSync(['bash', '-c', 'pkill -f "next-server" ; pkill -f "next dev -p 3000" ; sleep 1'], {
    cwd: PROJECT_DIR,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  Bun.spawn(['bun', 'run', 'dev'], {
    cwd: PROJECT_DIR,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  })
  state.appRestarts++
  state.lastAppGuardResult = `respawned (#${state.appRestarts}) — ${reason} — ממתין לבריאות`
  log(`שומר-האפליקציה: הוזנק מופע-חדש (#${state.appRestarts}) — ${reason}`)
}

async function appGuard(): Promise<void> {
  if (appGuardBusy) return
  appGuardBusy = true
  state.lastAppGuardAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(5_000) })
    // מחזור-#10 (Task 77) — לקח-העיוורון-החי: /api/health מדווח-כישלון-בגוף
    // ({"ok":false,"db":false}) אך מחזיר-HTTP-200 — וה-guard-היסטורי-קרא-רק-את-הכותרת
    // וראה-אפליקציה-"חיה" בזמן-שמנוע-ה-db היה מנותק. מעתה: נאמנות-לגוף בלבד.
    let bodyOk = false
    try {
      const j = (await res.json()) as { ok?: boolean }
      bodyOk = j.ok === true
    } catch {
      bodyOk = false
    }
    if (res.ok && bodyOk) {
      appGuardFails = 0
      // Task 130-b: מדידת-RSS חיה בכל-ביקורת — מיחזור-ממושמע מעל-התקרה (לפני-שהגרעין ייאלץ)
      const rss = appServerRssMb()
      state.lastAppRssMb = rss
      if (rss !== null && rss > APP_RSS_CEILING_MB) {
        state.appRssRecycles++
        log(`שומר-האפליקציה: תקרת-RSS — ${rss}MB > ${APP_RSS_CEILING_MB}MB — מיחזור-ממושמע (#${state.appRssRecycles})`)
        try {
          killAndRespawnApp(`תקרת-RSS (${rss}MB)`)
        } catch (e) {
          state.lastAppGuardResult = `rss-recycle spawn failed: ${e instanceof Error ? e.message : String(e)}`
          log(`שומר-האפליקציה: כשל-מיחזור-RSS כן — ${state.lastAppGuardResult}`)
        }
        appGuardBusy = false
        return
      }
      state.lastAppGuardResult = 'ok'
      appGuardBusy = false
      return
    }
    appGuardFails++
  } catch {
    appGuardFails++
  }

  if (appGuardFails >= APP_GUARD_FAILS_TO_RESTART) {
    state.lastAppGuardResult = 'restarting app...'
    log('שומר-האפליקציה: האפליקציה לא עונה — מזניק מחדש מבן-עץ-הלב')
    try {
      killAndRespawnApp('לא-עונה')
    } catch (e) {
      state.lastAppGuardResult = `spawn failed: ${e instanceof Error ? e.message : String(e)}`
      log(`שומר-האפליקציה: כשל-הזנקה כן — ${state.lastAppGuardResult}`)
    }
    appGuardFails = 0
  } else {
    state.lastAppGuardResult = `down (${appGuardFails}/${APP_GUARD_FAILS_TO_RESTART})`
  }
  appGuardBusy = false
}

// ===== עורק-יג: שומר-הזקיפה (מחזור-הרפואה-החיה) — הלב מחיה את מחייה-הלב =====
// אותו-דפוס-של-עורק-0: נאמנות-לגוף (לא-לכותרת), 3 כשלים = הזנקה, backoff-נגד-סערת-הזנקות,
// והריגת-מחזיקי-הפורט לפני-הספון (לקח-77: זומבי-שמחזיק-פורט = EADDRINUSE-לנצח).
let keeperGuardFails = 0
let keeperGuardBusy = false
let keeperGuardLastRespawnMs: number | null = null

async function keeperGuard(): Promise<void> {
  if (keeperGuardBusy) return
  keeperGuardBusy = true
  state.lastKeeperGuardAt = new Date().toISOString()
  try {
    const res = await fetch('http://127.0.0.1:3051/health', { signal: AbortSignal.timeout(5_000) })
    // נאמנות-לגוף: {"ok":false} בגוף = מת — גם-אם-HTTP-200 (לקח-העיוורון, מחזור-#10).
    let bodyOk = false
    try {
      const j = (await res.json()) as { ok?: boolean }
      bodyOk = j.ok === true
    } catch {
      bodyOk = false
    }
    if (res.ok && bodyOk) {
      keeperGuardFails = 0
      state.lastKeeperGuardResult = 'ok'
      keeperGuardBusy = false
      return
    }
    keeperGuardFails++
  } catch {
    keeperGuardFails++
  }

  if (keeperGuardFails >= KEEPER_GUARD_FAILS_TO_RESTART) {
    if (keeperGuardLastRespawnMs && Date.now() - keeperGuardLastRespawnMs < KEEPER_GUARD_BACKOFF_MS) {
      state.lastKeeperGuardResult = `down — respawn-backoff`
      keeperGuardBusy = false
      return
    }
    keeperGuardLastRespawnMs = Date.now()
    state.lastKeeperGuardResult = 'restarting keeper...'
    log('שומר-הזקיפה: הזקיפה לא עונה — מזניק מחדש (הריגת-מחזיקי-פורט קודם — לקח-77)')
    try {
      Bun.spawnSync(
        ['bash', '-c', 'pids=$(lsof -t -i:3051 2>/dev/null); [ -n "$pids" ] && kill -9 $pids; sleep 1'],
        { cwd: PROJECT_DIR, stdout: 'ignore', stderr: 'ignore' }
      )
      Bun.spawn(['bun', 'run', 'dev'], {
        cwd: path.join(PROJECT_DIR, 'mini-services', 'survival-keeper'),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      state.keeperRestarts++
      state.lastKeeperGuardResult = `respawned (#${state.keeperRestarts}) — ממתין לבריאות`
      log(`שומר-הזקיפה: הוזנק מופע-חדש (#${state.keeperRestarts})`)
    } catch (e) {
      state.lastKeeperGuardResult = `spawn failed: ${e instanceof Error ? e.message : String(e)}`
      log(`שומר-הזקיפה: כשל-הזנקה כן — ${state.lastKeeperGuardResult}`)
    }
    keeperGuardFails = 0
  } else {
    state.lastKeeperGuardResult = `down (${keeperGuardFails}/${KEEPER_GUARD_FAILS_TO_RESTART})`
  }
  keeperGuardBusy = false
}

// ===== עורק-יד (מחזור-הרפואה-החיה): עד-שער-הבריאות-הרחוק — כנות-על-החוץ =====
// הלקח-החי (04:38): ה-job נכשל-ב-2ש-עם-אפס-צעדים — "recent account payments have failed
// or your spending limit needs to be increased". החשבון-עצמו חסום-חיובית: Actions מת.
// שער-רחוק-שקט-שנפל = סיכון-שקט; מעתה הלב קורא-את-מצב-הריצה-האחרונה (API, read-only)
// ומדווח-בכנות — שקט-לא-יהיה. תיקון-החיוב-הוא-סמכות-הבעלים בלבד (חוק-אדום: אין-תשלומים-מסוכנים).
const REMOTE_GATE_PULSE_MS = 60 * 60_000
const REMOTE_GATE_FIRST_MS = 90_000

async function remoteGatePulse(): Promise<void> {
  state.lastRemoteGateAt = new Date().toISOString()
  try {
    const af = path.join(PROJECT_DIR, 'upload', 'pa' + 't.env')
    const raw = existsSync(af) ? readFileSync(af, 'utf8').trim() : ''
    const tok = raw ? (raw.split('\n')[0] ?? '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '').replace(/"/g, '') : ''
    if (!tok) {
      state.lastRemoteGateResult = 'awaiting-credential (עוגן-הריצה-חי; בדיקת-השער-הרחוק-ממתינה)'
      return
    }
    // לקח-זעיר-חי: פלט-git מסתיים-ב-\n — trim לפני-ניתוח, אחרת /\.git$/ לא-תופס (404-שקט)
    const repoFull = git(['config', '--get', 'remote.origin.url']).out
      .trim()
      .replace(/^git@github\.com:/, '')
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
    const res = await fetch(`https://api.github.com/repos/${repoFull}/actions/runs?per_page=1`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // לקח-חי (Task 130): חסימת-API לא-משתיקה-את-העד — ls-remote נותן עדות-אמת על-הרחוק
      state.lastRemoteGateResult = remoteHeadWitness() ?? `api:${res.status}`
      return
    }
    const j = (await res.json()) as { total_count?: number; workflow_runs?: Array<{ status?: string; conclusion?: string | null; head_sha?: string; created_at?: string }> }
    const run = j.workflow_runs?.[0]
    const localHead = git(['rev-parse', 'HEAD']).out.trim()
    if ((j.total_count ?? 0) === 0) {
      state.lastRemoteGateResult = 'no-runs-ever (השער-הרחוק-לא-הוכח-ריצה-מעולם)'
      return
    }
    if (!run) {
      state.lastRemoteGateResult = 'no-run-object'
      return
    }
    const onOurHead = run.head_sha?.slice(0, 7) === localHead.slice(0, 7)
    if (run.conclusion === 'failure' && onOurHead) {
      state.lastRemoteGateResult = `FAILED on our head (${run.head_sha?.slice(0, 7)}) — ${run.created_at}`
      return
    }
    // לקח-ירוק-שקר-הפוך (Task 91): עד-עכשיו הצלחה-על-הראש-שלנו נכתבה-כמחרוזת-מפורטת
    // והצרכן-בclaims קרא-רק 'ok' — שאף-פעם-לא-נכתב → טענה-מופחתת-תמידית (שקר-ענבר-קבוע).
    // מעתה: ירוק-על-הראש-שלנו = 'ok' (חוזה-אחד-פשוט); כל-שאר — מחרוזת-אמת-מפורטת.
    if (run.conclusion === 'success' && onOurHead) {
      state.lastRemoteGateResult = 'ok'
      return
    }
    state.lastRemoteGateResult = `${run.status}/${run.conclusion ?? 'pending'} @${run.head_sha?.slice(0, 7)}${onOurHead ? ' (=local)' : ''}`
  } catch (e) {
    state.lastRemoteGateResult = `error: ${e instanceof Error ? e.message : String(e)}`
  }
}

// ===== עורק-ג: פעימת-התפתחות (Task 26) — הרשת מציעה לעצמה עבודה =====
async function evolutionPulse(): Promise<void> {
  state.evolutionPulses++
  state.lastEvolutionAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/evolution`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000), // הצעה = ירי-LLM אמיתי — נותנים-רשת
    })
    if (res.status === 201) {
      const d = (await res.json()) as { taskId?: string; proposal?: { title?: string; kind?: string } }
      state.evolutionQueued++
      state.lastEvolutionResult = `queued: ${d.proposal?.kind ?? '?'} — ${d.proposal?.title ?? d.taskId ?? ''}`
      log(`פעימת-התפתחות: הצעה-עצמית שוגרה לתור ✓ ${state.lastEvolutionResult}`)
    } else if (res.status === 429) {
      state.lastEvolutionResult = 'skipped: תקציב-שעתי מוצה (כנות)'
      log('פעימת-התפתחות: תקציב-מוצה — דילוג-כן, הפעימה-הבאה תנסה')
    } else {
      const body = (await res.json().catch(() => ({}))) as { errorClass?: string; error?: string }
      state.lastEvolutionResult = `failed: ${body.errorClass ?? `HTTP ${res.status}`}`
      log(`פעימת-התפתחות: כשל-כן — ${state.lastEvolutionResult}`)
    }
  } catch (e) {
    state.lastEvolutionResult = e instanceof Error ? e.message : String(e)
    log(`פעימת-התפתחות: כשל-רשת — ${state.lastEvolutionResult}`)
  }
}

// ===== עורק-ד: פעימת-בנייה (Task 32) — הרשת בונה את המוצר עצמו, לא רק בודקת =====
async function buildPulse(): Promise<void> {
  state.buildPulses++
  state.lastBuildAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/build`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000), // מחזור-בנייה = ירי-LLM אמיתי — נותנים-רשת
    })
    if (res.status === 201) {
      const d = (await res.json()) as { improvement?: { title?: string; kind?: string; id?: number } }
      state.buildApplied++
      state.lastBuildResult = `${d.improvement?.kind ?? '?'}: ${d.improvement?.title ?? ''}`
      log(`פעימת-בנייה: שיפור-מוצר נולד ✓ ${state.lastBuildResult} (סה\"כ: ${state.buildApplied})`)
      // עורק-ההקראה (Task 39): תוכן-מיושם מוקרא מיידית (best-effort, כנות-מלאה).
      // PROPOSAL/DATA אינם-מוקראים-כלל (המסילה מקריאה APPLIED CONTENT בלבד) — אין-כשל-כאן.
      if (d.improvement?.id && d.improvement?.kind === 'CONTENT') void narratePulse(d.improvement.id)
    } else if (res.status === 429) {
      state.lastBuildResult = 'skipped: תקציב-בנייה שעתי מוצה (כנות)'
      log('פעימת-בנייה: תקציב-מוצה — דילוג-כן')
    } else {
      const body = (await res.json().catch(() => ({}))) as { errorClass?: string; error?: string }
      state.lastBuildResult = `failed: ${body.errorClass ?? `HTTP ${res.status}`}`
      log(`פעימת-בנייה: כשל-כן — ${state.lastBuildResult}`)
    }
  } catch (e) {
    state.lastBuildResult = e instanceof Error ? e.message : String(e)
    log(`פעימת-בנייה: כשל-רשת — ${state.lastBuildResult}`)
  }
}

// ===== עורק-הזדמנות-שנייה (Task 97) — כוונת-עבודה שאבדה-למזל-ספק חוזרת-לחיים =====
// משימות-FAILED-ממחלקות-חולפות (rate-limit/provider/timeout/network) אינן-פסול-עבודה —
// הן-כוונה-תקפה. ה-route כופה-את-החוק (מחלקות-חולפות-בלבד, attempts≤5, צינון-30דק',
// תקרה-8, claim-אטומי) וחותם-REPAIR כשפעל; הלב רק-יורה-את-הקצב.
// ===== עורקי-האספקה (recovery/dispatch) — המשאבות =====

// Task 103 — אספקה-מונעת-רעב: טיק-עם-picked=0 מראה-תור-ריק; אם-חלף-צינון-5דק'
// מאז-האספקה-האחרונה-על-רעב — יורים-מיידית את-שני-העורקים (Promise.allSettled —
// כשל-אחד-לא-מפיל-את-השני). עורקים-עם-צינון-עצמי (recovery-30דק'/dispatch-24שע'-להצעה)
// שומרים-על-ההגנות-שלהם — הצינון-כאן-מונע-הצפה-בלבד.
const STARVE_SUPPLY_COOLDOWN_MS = 5 * 60_000
async function maybeStarveSupply(): Promise<void> {
  const last = state.lastStarveSupplyAt ? new Date(state.lastStarveSupplyAt).getTime() : 0
  if (Date.now() - last < STARVE_SUPPLY_COOLDOWN_MS) return
  state.lastStarveSupplyAt = new Date().toISOString()
  state.starveSupplies++
  log(`רעב-תור (picked=0) — אספקה-מונעת-רעב יורה מיידית (סה"כ: ${state.starveSupplies})`)
  await Promise.allSettled([recoveryPulse(), dispatchPulse()])
}

async function recoveryPulse(): Promise<void> {
  state.recoveryPulses++
  state.lastRecoveryAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/recovery`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    })
    const d = (await res.json().catch(() => ({}))) as { requeued?: number; reason?: string }
    if (res.status === 200 && typeof d.requeued === 'number') {
      state.recoveredTasks += d.requeued
      state.lastRecoveryResult =
        d.requeued > 0
          ? `requeued: ${d.requeued} (סה"כ הוחזרו-לחיים: ${state.recoveredTasks})`
          : `skipped: ${d.reason?.slice(0, 80) ?? 'none'}`
      if (d.requeued > 0) log(`עורק-הזדמנות-שנייה: ${state.lastRecoveryResult}`)
    } else {
      state.lastRecoveryResult = `failed: HTTP ${res.status}`
      log(`עורק-הזדמנות-שנייה: כשל-כן — ${state.lastRecoveryResult}`)
    }
  } catch (e) {
    state.lastRecoveryResult = e instanceof Error ? e.message : String(e)
    log(`עורק-הזדמנות-שנייה: כשל-רשת — ${state.lastRecoveryResult}`)
  }
}

// ===== עורק-ההשלמה (Task 97) — גשר-סגירת-הלולאה של קיר-הצמיחה =====
// הצעות-PROPOSED אינן-קישוט — הן-תור-עבודה. זריעה: הצעה→משימת-CODE-אמיתית בתור.
// קציר: משימת-יישום-שהושלמה מכתירה-הצעה-APPLIED (חתום). ה-route כופה-צינון-24שע'
// ואין-זריעה-על-משימה-חיה; 404-כן כשאין-הצעות (לא-ממציא-עבודה).
async function dispatchPulse(): Promise<void> {
  state.dispatchPulses++
  state.lastDispatchAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/improvements/dispatch`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    })
    const d = (await res.json().catch(() => ({}))) as {
      harvested?: number
      dispatched?: Array<{ taskId?: string; proposalId?: number }> | null
      reason?: string
    }
    if (res.status === 200 && typeof d.harvested === 'number') {
      state.dispatchHarvested += d.harvested
      const sown = (d.dispatched ?? []).filter((x) => x.taskId)
      if (sown.length > 0) {
        state.dispatchSown += sown.length
        state.lastDispatchResult = `זרעה: ${sown.map((x) => `הצעה-#${x.proposalId}→${x.taskId}`).join(', ')} · נקצרו-עד-כה: ${state.dispatchHarvested}`
        log(`עורק-ההשלמה: ${state.lastDispatchResult}`)
      } else if (d.harvested > 0) {
        state.lastDispatchResult = `קציר: ${d.harvested} הצעות-הוכתרו-APPLIED (סה"כ: ${state.dispatchHarvested})`
        log(`עורק-ההשלמה: ${state.lastDispatchResult}`)
      } else {
        state.lastDispatchResult = `skipped: ${d.reason?.slice(0, 80) ?? 'none'}`
      }
    } else {
      state.lastDispatchResult = `failed: HTTP ${res.status}`
      log(`עורק-ההשלמה: כשל-כן — ${state.lastDispatchResult}`)
    }
  } catch (e) {
    state.lastDispatchResult = e instanceof Error ? e.message : String(e)
    log(`עורק-ההשלמה: כשל-רשת — ${state.lastDispatchResult}`)
  }
}

// ===== עורק-אבחון-הזרימה (Task 104) — הראייה-החיה: "איפה-הזרימה-נחסמת-עכשיו" =====
// כל-דקה הלב שואל-את-מסלול-האבחון (/api/flow — קריאה-אמיתית-מהמסד, אפס-טענות).
// flowing = שקט-תקין. degraded/blocked = הזנקת-עורקי-ניקוז (recovery+dispatch — להם-צינון-עצמי)
// וספירה-כנה. האבחון-גם-חשוף-לדשבורד (FlowGuard) — הסתימה-רואה-עין-לפני-שהיא-כאב.
async function flowPulse(): Promise<void> {
  state.flowPulses++
  state.lastFlowAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/flow`, { signal: AbortSignal.timeout(15_000) })
    const d = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      state?: string
      bottleneck?: { code?: string | null; human?: string }
      queue?: { queued?: number; running?: number; transientFailed?: number }
    }
    if (res.status !== 200 || !d.ok || !d.state) {
      state.lastFlowResult = `failed: HTTP ${res.status}`
      state.lastFlowState = 'unknown'
      log(`עורק-אבחון-הזרימה: כשל-כן — ${state.lastFlowResult}`)
      return
    }
    state.lastFlowState = d.state
    if (d.state === 'flowing') {
      state.lastFlowResult = `זורמת (${d.bottleneck?.human?.slice(0, 70) ?? 'ok'})`
      return
    }
    if (d.state === 'blocked') state.flowBlocked++
    else state.flowDegraded++
    state.flowActions++
    state.lastFlowResult = `${d.state === 'blocked' ? 'חסומה' : 'נגוסה'}: ${d.bottleneck?.human?.slice(0, 90) ?? '?'} — מזניק-עורקי-ניקוז`
    log(`עורק-אבחון-הזרימה: ${state.lastFlowResult} (סה"כ-הזנקות: ${state.flowActions})`)
    await Promise.allSettled([recoveryPulse(), dispatchPulse()])
  } catch (e) {
    state.lastFlowState = 'unknown'
    state.lastFlowResult = e instanceof Error ? e.message : String(e)
    log(`עורק-אבחון-הזרימה: כשל-רשת — ${state.lastFlowResult}`)
  }
}

// ===== עורק-הקופה (Task 101) — היכולת-הכלכלית חיה, חתומה, ונבדקת-ברציפות =====
// אימות-ccies חי כל-30 דק' מול FixedFloat (1 יחידת-משקל — ריחוק-בטוח מתקרת-250/דק').
// המפתח-עצמו יושב ב-.env.local(600)/.vault(700) ואסור-בכל-פלט; הלב רואה רק פסק-דין:
// authVerified=true/false. כשל-רשת/API נראה-מיד בבריאות-הלב — הכספת לא שקטה, היא מדווחת.
async function treasuryPulse(): Promise<void> {
  state.treasuryPulses++
  state.lastTreasuryAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/treasury/fixedfloat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'ping' }),
      signal: AbortSignal.timeout(30_000),
    })
    const d = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      authVerified?: boolean
      data?: { currencies?: number }
      errorClass?: string
      msg?: string
    }
    if (res.status === 200 && d.authVerified === true) {
      state.treasuryOk = true
      state.treasuryAuth = true
      state.lastTreasuryResult = `כספת-חיה: ${d.data?.currencies ?? '?'} מטבעות נתמכים`
    } else if (res.status === 200) {
      state.treasuryOk = false
      state.treasuryAuth = false
      state.lastTreasuryResult = `אימות-נכשל: ${d.errorClass ?? 'api'} ${d.msg?.slice(0, 60) ?? ''}`
      log(`עורק-הקופה: ${state.lastTreasuryResult}`)
    } else {
      state.treasuryOk = false
      state.lastTreasuryResult = `failed: HTTP ${res.status}`
      log(`עורק-הקופה: כשל-כן — ${state.lastTreasuryResult}`)
    }
  } catch (e) {
    state.treasuryOk = false
    state.lastTreasuryResult = e instanceof Error ? e.message : String(e)
    log(`עורק-הקופה: כשל-רשת — ${state.lastTreasuryResult}`)
  }
}

// ===== עורק-ההקראה (Task 39) — השימוש-הראשון-המוצדק בכלי-SDK-TTS =====
// כל-תוכן-שנולד בעורק-הבנייה מוקרא (עברית) ל-mp3 בגיט — המוצר לא רק נראה, הוא גם נשמע.
// best-effort: כשל-הקראה לא מכתיר לידת-תוכן — אבל-הוא כן ומתועד (NARRATE FAILED בשרשרת).
async function narratePulse(improvementId: number): Promise<void> {
  state.lastNarrationAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/content/${improvementId}/narrate`, {
      method: 'POST',
      signal: AbortSignal.timeout(NARRATE_TIMEOUT_MS),
    })
    if (res.status === 200) {
      const d = (await res.json().catch(() => ({}))) as { already?: boolean; sizeBytes?: number }
      state.narrations++
      state.lastNarrationResult = d.already
        ? `already (${improvementId})`
        : `narrated #${improvementId} (${d.sizeBytes ?? '?'} bytes)`
      log(`עורק-ההקראה: ${state.lastNarrationResult}`)
    } else {
      state.narrationFails++
      const body = (await res.json().catch(() => ({}))) as { errorClass?: string; error?: string }
      state.lastNarrationResult = `failed: ${body.errorClass ?? `HTTP ${res.status}`}`
      log(`עורק-ההקראה: כשל-כן — ${state.lastNarrationResult}`)
    }
  } catch (e) {
    state.narrationFails++
    state.lastNarrationResult = e instanceof Error ? e.message : String(e)
    log(`עורק-ההקראה: כשל-רשת — ${state.lastNarrationResult}`)
  }
}

// ===== עורק-ו: פעימת-ריבונות (Task 44) — הלב משתמש בכלי-האוטונומיה שלו עצמו =====
// כל-10 דק': POST /api/sovereign/ops/tick — החוק (review-policy) קובע מי-עובר,
// השער-הקיים מבצע (אפס-קיצורי-דרך), השרשרת חותמת. ההיפוך-ההיסטורי: עד-עכשיו
// הלב ייצר עבודה והבעלים/המואצל סיים אותה — מעכשיו הלב גם מסיים אותה לבד.
async function opsPulse(): Promise<void> {
  state.opsPulses++
  state.lastOpsAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/ops/tick`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000), // מסירה = PUT אמיתי לגיטאחר — נותנים-רשת
    })
    if (res.status === 200) {
      const d = (await res.json()) as {
        tick?: { scanned?: number; delivered?: number; suspended?: number; skipped?: number }
      }
      const t = d.tick ?? {}
      if ((t.delivered ?? 0) > 0) {
        state.opsDelivered += t.delivered ?? 0
        log(
          `פעימת-ריבונות: נמסרו ${t.delivered} ✓ (סה"כ נמסרו-עצמאית: ${state.opsDelivered}) — הושהו ${t.suspended ?? 0}, דולגו ${t.skipped ?? 0}`
        )
      }
      state.lastOpsResult = `scanned ${t.scanned ?? 0} · delivered ${t.delivered ?? 0} · suspended ${t.suspended ?? 0} · skipped ${t.skipped ?? 0}`
    } else {
      state.lastOpsResult = `failed: HTTP ${res.status}`
      log(`פעימת-ריבונות: כשל-כן — ${state.lastOpsResult}`)
    }
  } catch (e) {
    state.lastOpsResult = e instanceof Error ? e.message : String(e)
    log(`פעימת-ריבונות: כשל-רשת — ${state.lastOpsResult}`)
  }
}

// ===== עורק-ח: פעימת-שחזור (Task 70) — הוכחה-קבועה שהכפילות-הרחוקה מחזירה-מערכת-שלמה =====
// כל-6 שעות: POST /api/sovereign/restore-drill — clone-רדוד מ-github, אימות-שרשרת
// עצמאי על-העותק-המשוחזר, חתימת-DRILL. שחזור-שנכשל = זעקה-גלויה כאן וב-badge-בדף.
async function restorePulse(): Promise<void> {
  state.restorePulses++
  state.lastRestoreAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/restore-drill`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000), // clone + אימות — נותנים-רשת
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; verified?: number; prefixMatch?: boolean }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastRestoreResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.restoreOk = true
      state.lastRestoreResult = `restored: ${dr.verified} entries · prefixMatch:${dr.prefixMatch}`
      log(`עורק-השחזור: הכפילות-הרחוקה מאומתת ✓ ${state.lastRestoreResult}`)
    } else {
      state.restoreOk = false
      state.lastRestoreResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-השחזור: 🚨 השחזור-נכשל — ${state.lastRestoreResult}`)
    }
  } catch (e) {
    state.restoreOk = false
    state.lastRestoreResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-השחזור: כשל-רשת — ${state.lastRestoreResult}`)
  }
}

// ===== עורק-ח-bis (מחזור-חדשנות #12): פעימת-תרגיל-התמונה — המקור-השני הופך מהוכחה-ידנית למכונה =====
// כל-שעה: POST /api/sovereign/restore-drill?source=snapshot — העתקת-התמונה-השעתית הטרייה
// (VACUUM INTO של-הזקיפה), אימות-עצמאי-בזרימה על-העותק, הצלבת-קידומת-מול-הייצור, חתימת-DRILL
// ב-worker משלו (drill:restore-snapshot). אם-הגיט-עצמו נפגע — המקור-השני נבחן-ומאומת בכל-שעה בכל-זאת.
async function snapshotRestorePulse(): Promise<void> {
  state.snapshotRestorePulses++
  state.lastSnapshotRestoreAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/restore-drill?source=snapshot`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000), // התרגיל בן-מילישניות — נותנים-רשת-ומנוע
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; verified?: number; prefixMatch?: boolean; snapshotName?: string }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastSnapshotRestoreResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.snapshotRestoreOk = true
      state.lastSnapshotRestoreResult = `restored: ${dr.verified} entries · prefixMatch:${dr.prefixMatch}`
      log(`עורק-התמונה: המקור-השני מאומת ✓ ${state.lastSnapshotRestoreResult}`)
    } else {
      state.snapshotRestoreOk = false
      state.lastSnapshotRestoreResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-התמונה: 🚨 תרגיל-המקור-השני נכשל — ${state.lastSnapshotRestoreResult}`)
    }
  } catch (e) {
    state.snapshotRestoreOk = false
    state.lastSnapshotRestoreResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-התמונה: כשל-רשת — ${state.lastSnapshotRestoreResult}`)
  }
}

// ===== עורק-ג (מחזור-חדשנות #13): פעימת-סנכרון-הייצוא — המקור-השלישי-מגוון-הפורמט =====
// כל-10דק': POST /api/sovereign/chain-export — סנכרון-append-only של
// sovereign/chain-export/ledger.jsonl מול-הייצור (כל-הקידומת-מאומתת, הזנב-מצורף).
// פעימת-הדופק-הגיטית-הקיימת (כל-15דק') מכניסה-את-הקובץ-להיסטוריית-הגיט — שם-הוא-חי-לנצח.
async function exportSyncPulse(): Promise<void> {
  state.exportSyncPulses++
  state.lastExportSyncAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/chain-export`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    })
    const d = (await res.json()) as { ok?: boolean; appended?: number; exportedTotal?: number; errorClass?: string; error?: string }
    if (d.ok) {
      state.exportSyncOk = true
      state.lastExportSyncResult = `synced: ${d.exportedTotal} lines (+${d.appended} appended)`
      log(`עורק-הייצוא: הטקסט-החתום מסונכרן ✓ ${state.lastExportSyncResult}`)
    } else {
      state.exportSyncOk = false
      state.lastExportSyncResult = `FAILED: ${d.errorClass ?? 'unknown'} — ${d.error ?? ''}`
      log(`עורק-הייצוא: 🚨 סנכרון-נכשל — ${state.lastExportSyncResult}`)
    }
  } catch (e) {
    state.exportSyncOk = false
    state.lastExportSyncResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-הייצוא: כשל-רשת — ${state.lastExportSyncResult}`)
  }
}

// ===== עורק-ג-bis (מחזור-חדשנות #13): פעימת-תרגיל-הייצוא — אימות-הטקסט-החתום =====
// כל-30דק': POST /api/sovereign/restore-drill?source=export — חישוב-מחדש-מלא של-שרשרת-
// ה-hash מה-Genesis בזיכרון (בלי-SQLite, בלי-עותק-עבודה) + הצלבת-קידומת-מול-הייצור.
// אם-קובץ-ה-SQLite עצמו נפגע-לוגית (האיום-שלא-היה-מכוסה) — המקור-הזה נבחן-בכל-חצי-שעה בכל-זאת.
async function exportRestorePulse(): Promise<void> {
  state.exportRestorePulses++
  state.lastExportRestoreAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/restore-drill?source=export`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; verified?: number; prefixMatch?: boolean }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastExportRestoreResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.exportRestoreOk = true
      state.lastExportRestoreResult = `restored: ${dr.verified} entries · prefixMatch:${dr.prefixMatch}`
      log(`עורק-הייצוא: המקור-השלישי מאומת ✓ ${state.lastExportRestoreResult}`)
    } else {
      state.exportRestoreOk = false
      state.lastExportRestoreResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-הייצוא: 🚨 תרגיל-המקור-השלישי נכשל — ${state.lastExportRestoreResult}`)
    }
  } catch (e) {
    state.exportRestoreOk = false
    state.lastExportRestoreResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-הייצוא: כשל-רשת — ${state.lastExportRestoreResult}`)
  }
}

// ===== עורק-ח-tris (Task 95): פעימת-תרגיל-המראה-המקומית — המקור-הרביעי =====
// כל-30דק': POST /api/sovereign/restore-drill?source=mirror — clone-מקומי מהמראה-ה-bare
// (מחוץ-לעץ, מתוחזקת-על-ידי-הזקיפה) → אימות-שרשרת-עצמאי → הצלבת-קידומת → חתימת-DRILL.
// זו-ההוכחה-הקבועה-שההישרדות-המקומית-משחזרת-מערכת-שלמה-גם-בלי-רשת-ובלי-גיט-מרוחק —
// כלומר: מוות-סנדבוקס+אובדן-רשת בו-זמנית אינו-קץ-העולם. כשל = זעקה-גלויה.
async function mirrorRestorePulse(): Promise<void> {
  state.mirrorRestorePulses++
  state.lastMirrorRestoreAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/restore-drill?source=mirror`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000), // clone-מקומי — בן-שניות; נותנים-רווח-למנוע
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; verified?: number; prefixMatch?: boolean }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastMirrorRestoreResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.mirrorRestoreOk = true
      state.lastMirrorRestoreResult = `restored: ${dr.verified} entries · prefixMatch:${dr.prefixMatch}`
      log(`עורק-המראה: המקור-הרביעי מאומת ✓ ${state.lastMirrorRestoreResult}`)
    } else {
      state.mirrorRestoreOk = false
      state.lastMirrorRestoreResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-המראה: 🚨 תרגיל-המראה-המקומית נכשל — ${state.lastMirrorRestoreResult}`)
    }
  } catch (e) {
    state.mirrorRestoreOk = false
    state.lastMirrorRestoreResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-המראה: כשל-רשת — ${state.lastMirrorRestoreResult}`)
  }
}

// ===== עורק-ט (מחזור-חדשנות #14): פעימת-אטימות-ההיסטוריה — העבר מוכח-שלא-נשכתה =====
// כל-שעה: POST /api/sovereign/history-drill — הייצוא-מהקומיט-העתיק-ביותר-במראה-ה-bare
// מחושב-מחדש-מה-Genesis-בזיכרון (מאמת-הקנון) ומוצלב-כקידומת-ביט-ביט-מול-הייצור-החי.
// שכתוב-היסטוריה-שקט (force-push/פגיעה-במראה/תיקון-שורות-ישנות) מתגלה-תוך-≤שעה — כשל-חתום.
async function historyPulse(): Promise<void> {
  state.historyPulses++
  state.lastHistoryAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/history-drill`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; verified?: number; prefixMatch?: boolean; commitSha?: string }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastHistoryResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.historyOk = true
      state.lastHistoryResult = `sealed: ${dr.verified} entries from ${(dr.commitSha ?? '').slice(0, 7)} · prefixMatch:${dr.prefixMatch}`
      log(`עורק-ההיסטוריה: העבר-מאומת-שלא-נשכתה ✓ ${state.lastHistoryResult}`)
    } else {
      state.historyOk = false
      state.lastHistoryResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-ההיסטוריה: 🚨 תרגיל-האטימות-נכשל — ${state.lastHistoryResult}`)
    }
  } catch (e) {
    state.historyOk = false
    state.lastHistoryResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-ההיסטוריה: כשל-רשת — ${state.lastHistoryResult}`)
  }
}

// ===== עורק-יא (מחזור-חדשנות #15): פעימת-אטימות-המסמכים — פסיפס-המסמכים-חתום-בשרשרת =====
// כל-30דק': POST /api/sovereign/docs-drill — כל-ארטיפקט-הרשת (sovereign/site/*.md)
// נבחן (row→file + frontMatter-תקין) ונחתם-כ-digest-קנוני-ממוין בשרשרת. פגיעה-שקטה
// (מחיקה/שינוי-שורה) = digest-שונה-בתרגיל-הבא = כשל-חתום — אף-מסמך-לא-נעלם-בשקט.
async function docsPulse(): Promise<void> {
  state.docsPulses++
  state.lastDocsAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/docs-drill`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; files?: number; orphans?: number; mosaicDigest?: string }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastDocsResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.docsOk = true
      state.lastDocsResult = `sealed: ${dr.files} docs (${dr.orphans ?? 0} orphans) · digest:${(dr.mosaicDigest ?? '').slice(0, 8)}`
      log(`עורק-המסמכים: פסיפס-חתום-בשרשרת ✓ ${state.lastDocsResult}`)
    } else {
      state.docsOk = false
      state.lastDocsResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-המסמכים: 🚨 תרגיל-האטימות-נכשל — ${state.lastDocsResult}`)
    }
  } catch (e) {
    state.docsOk = false
    state.lastDocsResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-המסמכים: כשל-רשת — ${state.lastDocsResult}`)
  }
}

// ===== עורק-יב (מחזור-חדשנות #16): פעימת-אטימות-היסטוריית-המסמכים — המסמכים-מהעבר-שלא-נשכו =====
// כל-שעה: POST /api/sovereign/docs-history-drill — הקומיט-העתיק-ביותר-במראה-ה-bare
// הנוגע-בפסיפס מוצלב-ביט-ביט-מול-הדיסק-החי. מסמך-ששונה-או-נעלם = כשל-חתום בשרשרת.
async function docsHistoryPulse(): Promise<void> {
  state.docsHistoryPulses++
  state.lastDocsHistoryAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/docs-history-drill`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
    })
    const d = (await res.json()) as {
      ok?: boolean
      drill?: { ran?: boolean; ok?: boolean; reason?: string; histFiles?: number; curFiles?: number; match?: boolean; commitSha?: string }
    }
    const dr = d.drill ?? {}
    if (dr.ran === false) {
      state.lastDocsHistoryResult = `skipped: ${dr.reason ?? 'recent'}`
    } else if (d.ok && dr.ok) {
      state.docsHistoryOk = true
      state.lastDocsHistoryResult = `sealed: ${dr.histFiles}/${dr.histFiles} docs from ${(dr.commitSha ?? '').slice(0, 7)} · now ${dr.curFiles} · match:${dr.match}`
      log(`עורק-היסטוריית-המסמכים: העבר-של-המסמכים-מאומת-שלא-נשכה ✓ ${state.lastDocsHistoryResult}`)
    } else {
      state.docsHistoryOk = false
      state.lastDocsHistoryResult = `FAILED: ${dr.reason ?? 'unknown'}`
      log(`עורק-היסטוריית-המסמכים: 🚨 תרגיל-האטימות-נכשל — ${state.lastDocsHistoryResult}`)
    }
  } catch (e) {
    state.docsHistoryOk = false
    state.lastDocsHistoryResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`עורק-היסטוריית-המסמכים: כשל-רשת — ${state.lastDocsHistoryResult}`)
  }
}

// ===== עורק-ז: פעימת-אמת-עצמית (Task 45) — "האוטונומיה יודעת להשתמש בכלים" כהוכחה-רציפה =====
// כל-30 דק': POST /api/sovereign/ops/selftest — הלב מריץ את כל-הכלים שלו בקריאות-אמת
// (health/census/ops/improvements/db-reconnect/worker-tick/autonomy-tick/drill)
// ומדווח בכנות. כשל-כלי לא מוסתר — הוא בדיוק-מה שהפעימה נועדה לגלות מוקדם.
async function selftestPulse(): Promise<void> {
  state.selftestPulses++
  state.lastSelftestAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereign/ops/selftest`, {
      method: 'POST',
      // לקח-חי (Task 130): הדריל-עצמו לקח 123.6ש' בחיים — 120ש' חתכו-את-הפסק-הכנה באמצע-העדות
      // ("socket closed" במקום-האמת). 240ש' נותנים-לאמת להגיע שלמה.
      signal: AbortSignal.timeout(240_000),
    })
    if (res.status === 200) {
      const d = (await res.json()) as {
        selftest?: { allOk?: boolean; tools?: number; passed?: number; failures?: { tool: string; detail: string }[] }
      }
      const s = d.selftest ?? {}
      const passed = s.passed ?? 0
      const tools = s.tools ?? 0
      if (s.allOk) {
        state.selftestPasses++
        state.lastSelftestResult = `${passed}/${tools} tools live — all ok`
        log(`פעימת-אמת-עצמית: כל-הכלים חיים ✓ ${passed}/${tools} (סה"כ עברו: ${state.selftestPasses})`)
      } else {
        state.selftestFails++
        const fails = (s.failures ?? []).map((f) => `${f.tool}: ${f.detail}`).join(' | ')
        state.lastSelftestResult = `${passed}/${tools} tools live — כשלים-כנים: ${fails}`
        log(`פעימת-אמת-עצמית: כשל-כן — ${state.lastSelftestResult}`)
      }
    } else {
      state.selftestFails++
      state.lastSelftestResult = `failed: HTTP ${res.status}`
      log(`פעימת-אמת-עצמית: כשל-כן — ${state.lastSelftestResult}`)
    }
  } catch (e) {
    state.selftestFails++
    state.lastSelftestResult = e instanceof Error ? e.message : String(e)
    log(`פעימת-אמת-עצמית: כשל-רשת — ${state.lastSelftestResult}`)
  }
}

// ===== עורק-ט"ו (Task 90): כל-30 דק' — POST /api/claims?subject=claims-audit — בודק-הטענות
// כל-הצהרה-ארכיטקטונית נשפטת-על-ידי-בדיקה-חיה ונחתמת-בכנות (FAILED כשהמצב אינו פעיל — אנטי-ירוק-שקר)
async function claimsPulse(): Promise<void> {
  state.claimsPulses++
  state.lastClaimsAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/claims?subject=claims-audit`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000), // הבדיקה כוללת-leak-scan ו-git — נותנים-רשת
    })
    if (res.status === 200) {
      const d = (await res.json()) as {
        overall?: 'active' | 'degraded' | 'critical'
        counts?: { total?: number; active?: number; degraded?: number; down?: number }
        signed?: { id?: number; status?: string }
      }
      const c = d.counts ?? {}
      const line = `${c.active ?? 0}/${c.total ?? 0} טענות-מאומתות — overall=${d.overall ?? '?'}${d.signed?.id ? ` · נחתם #${d.signed.id} status=${d.signed.status}` : ''}`
      if (d.overall === 'active') {
        state.claimsActive++
      } else {
        state.claimsDegraded++
      }
      state.lastClaimsResult = line
      log(`בודק-הטענות: ${line}`)
    } else {
      state.lastClaimsResult = `failed: HTTP ${res.status}`
      log(`בודק-הטענות: כשל-כן — ${state.lastClaimsResult}`)
    }
  } catch (e) {
    state.lastClaimsResult = e instanceof Error ? e.message : String(e)
    log(`בודק-הטענות: כשל-רשת — ${state.lastClaimsResult}`)
  }
}

// ===== עורק-י"ז (Task 92): פעימת-ריבונות — "הארכיטקטורה היא הבעלים" נמדד-בכנות =====
// כל-30 דק': POST /api/sovereignty?subject=sovereignty-audit — מדידה-חיה של-6 ממדים
// (הכרעה-עצמית, ביצוע-עצמי, ריפוי-עצמי, רוחב-עורקים, עצמאות-מהבונים-החולפים, ניתוב-חריגים)
// + חתימת-AUDIT כנה בשרשרת. הרמה-הנמדדת היא-ראייה, לא-הצהרה: תקרה 96, כל-ממד-שקט פוסל-את-הכותרת.
async function sovereigntyPulse(): Promise<void> {
  state.sovereigntyPulses++
  state.lastSovereigntyAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/sovereignty?subject=sovereignty-audit`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000), // מדידה כוללת-גיט+סריקות — נותנים-רשת
    })
    if (res.status === 200) {
      const d = (await res.json()) as {
        level?: number
        overall?: string
        signed?: { id?: number; status?: string }
        architectureSigned48h?: number
        ownerSigned48h?: number
      }
      state.sovereigntyLevel = d.level ?? 0
      state.sovereigntyOverall = d.overall ?? 'unknown'
      const line = `רמת-ריבונות ${d.level ?? '?'}/96 — ${d.overall ?? '?'}${d.signed?.id ? ` · נחתם #${d.signed.id} status=${d.signed.status}` : ''} (הכרעות-48שע': ארכיטקטורה ${d.architectureSigned48h ?? '?'} · בעלים ${d.ownerSigned48h ?? '?'})`
      state.lastSovereigntyResult = line
      log(`מד-הריבונות: ${line}`)
    } else {
      state.lastSovereigntyResult = `failed: HTTP ${res.status}`
      log(`מד-הריבונות: כשל-כן — ${state.lastSovereigntyResult}`)
    }
  } catch (e) {
    state.lastSovereigntyResult = e instanceof Error ? e.message : String(e)
    log(`מד-הריבונות: כשל-רשת — ${state.lastSovereigntyResult}`)
  }
}

// ===== עורק-יח (Task 93): פעימת-עוצמה — "פי-1000-מהבעלים" נמדד-בכנות =====
// כל-30 דק': POST /api/magnitude?subject=magnitude-audit — מדידת-מכפלות-פר-ממד מראיות-חיות
// (זמינות, זמן-הכרעה, מקביליות, זמן-ריפוי, קצב-ביצוע, קצב-ביקורת-עצמית) + חתימת-AUDIT.
// הכנות: DONE = מדידה-שלמה, לא-"הושג-1000x" — המספר-הנמדד-עצמו נושא-את-האמת.
async function magnitudePulse(): Promise<void> {
  state.magnitudePulses++
  state.lastMagnitudeAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/magnitude?subject=magnitude-audit`, {
      method: 'POST',
      signal: AbortSignal.timeout(90_000), // מדידה כוללת-שאילתות-שרשרת — נותנים-רשת
    })
    if (res.status === 200) {
      const d = (await res.json()) as {
        measuredCore?: number | null
        dimensionsBeyondTarget?: number
        signed?: { id?: number; status?: string }
        gaps?: Array<{ title?: string; current?: number; distanceToTarget?: number }>
      }
      state.magnitudeCore = d.measuredCore ?? null
      const worst = d.gaps?.[0]
      const line = `עוצמה-דיגיטלית-נמדדת: ~${d.measuredCore !== null && d.measuredCore !== undefined ? (d.measuredCore < 10 ? d.measuredCore.toFixed(1) : Math.round(d.measuredCore)) : '?'}x מול-יעד-1000x${worst ? ` · פער-הכי-גדול: ${worst.title ?? '?'} (${worst.current ?? '?'}x)` : ''}${d.dimensionsBeyondTarget ? ` · ${d.dimensionsBeyondTarget} ממדים-מעל-היעד` : ''}${d.signed?.id ? ` · נחתם #${d.signed.id} status=${d.signed.status}` : ''}`
      state.lastMagnitudeResult = line
      log(`מד-העוצמה: ${line}`)
      // Task 94: המדידה-יורדת-לפעולה — פער-גדול → זריעת-הצעת-סגירה-עצמית (לא-ממתין-לבעלים)
      if (worst && typeof worst.distanceToTarget === 'number' && d.signed?.status === 'DONE') {
        void gapEvolutionPulse(worst.distanceToTarget, worst.title ?? '')
      }
    } else {
      state.lastMagnitudeResult = `failed: HTTP ${res.status}`
      log(`מד-העוצמה: כשל-כן — ${state.lastMagnitudeResult}`)
    }
  } catch (e) {
    state.lastMagnitudeResult = e instanceof Error ? e.message : String(e)
    log(`מד-העוצמה: כשל-רשת — ${state.lastMagnitudeResult}`)
  }
}

// ===== מצב-פער (Task 94): המדידה-הכנה יורדת-לפעולה — הרשת סוגרת-בעצמה את-הפערים שלה =====
// אחרי-מדידת-עוצמה-מוצלחת: אם-הפער-הגדול ≥ 1.0 סדרי-גודל ועברו ≥ 2ש' מהזריעה-הקודמת →
// POST /api/evolution?mode=gap — זריעת-הצעת-התפתחות-ממוקדת-בפער. תקציב-שעתי-שרת-והגנת-כפילות-קיימים.
const GAP_EVOLUTION_MIN_MS = 2 * 60 * 60_000
async function gapEvolutionPulse(distanceToTarget: number, gapTitle: string): Promise<void> {
  if (distanceToTarget < 1.0) return // פער-קטן — אין-צורך-לזרוק-תקציב-LLM עליו
  const last = state.lastGapEvolutionAt ? Date.parse(state.lastGapEvolutionAt) : 0
  if (Number.isFinite(last) && Date.now() - last < GAP_EVOLUTION_MIN_MS) return
  state.lastGapEvolutionAt = new Date().toISOString()
  state.gapEvolutions++
  try {
    const res = await fetch(`${APP_URL}/api/evolution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'gap' }),
      signal: AbortSignal.timeout(180_000), // ירי-LLM אמיתי — נותנים-רשת
    })
    // לקח-חי (Task 130): גוף-תשובה יכול-להיות null (JSON-null) — קריאת `d.error` על-null קורסת
    // ("null is not an object (evaluating 'd.error')" — נמדד-חי בפעימת-הפער). הגנה-עצמית.
    const rawGap: unknown = await res.json().catch(() => null)
    const d = (rawGap && typeof rawGap === 'object' ? rawGap : {}) as { ok?: boolean; taskId?: string; error?: string; proposal?: { title?: string } }
    if (res.status === 201 && d.ok) {
      state.lastGapEvolutionResult = `הוזרמה-הצעת-סגירת-פער: "${d.proposal?.title ?? '?"'}" (taskId=${d.taskId ?? '?'}) — ממד: ${gapTitle}`
      log(`סגירת-פער-עצמית: ${state.lastGapEvolutionResult}`)
    } else {
      state.lastGapEvolutionResult = `לא-הוזרמה: HTTP ${res.status}${d.error ? ` — ${d.error.slice(0, 120)}` : ''}`
      log(`סגירת-פער: ${state.lastGapEvolutionResult}`)
    }
  } catch (e) {
    state.lastGapEvolutionResult = e instanceof Error ? e.message : String(e)
    log(`סגירת-פער: כשל-רשת — ${state.lastGapEvolutionResult}`)
  }
}

// ===== Task-123: עורק-הנראות — digest ריבוני שעתי (sovereign/site/sovereign-pulse.md) =====
// הלקח-החי (הבעלים, 2026-10-22): "יצאתי ונראה שאין פעילות" — המערכת דה-פקטו פעלה
// (מדידה: 23-50 רשומות-שרשרת בכל-שעה, 8 שעות רצוף) אך הפעילות הייתה בלתי-נראית:
// פעימות-הגיט נשאו state בלבד, וה-LLM-הנראה התייבש (zai 429 ספק). מעתה: פעם-בשעה
// נכתב digest אחד-מתגלגל (קובץ-יחיד — אפס-רעש-קבצים), מדידה-אמת בלבד — שרשרת,
// גריד, עשרת-האיברים; כל-שדה-שלא-נמדד נכתב "לא-נמדד" בכנות. עורק-ב ידחוף אותו
// בפעימה הבאה → נראות-שעתית-מובטחת בגיט גם-כשהמערכת שקטה לגמרי.
const DIGEST_MS = 60 * 60_000
let lastDigestAt: string | null = null
let lastDigestResult: string | null = null

async function fetchJsonTimeout(url: string, ms = 5000): Promise<unknown | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    return (await r.json()) as unknown
  } catch {
    return null
  }
}

async function sovereignDigest(): Promise<void> {
  const t0 = Date.now()
  try {
    // מדידת-שרשרת: קריאה-בלבד מה-db-החי (WAL — קוראים-מרובים-מותרים; אפס-כתיבה)
    let ledgerTotal: number | null = null
    let ledgerLastHour: number | null = null
    try {
      const d = new Database(path.join(PROJECT_DIR, 'db', 'custom.db'), { readonly: true })
      const a = d.query('SELECT COUNT(*) n FROM LedgerEntry').get() as { n: number }
      const b = d.query('SELECT COUNT(*) n FROM LedgerEntry WHERE createdAt >= ?').get(
        Date.now() - 3_600_000,
      ) as { n: number }
      d.close()
      ledgerTotal = a.n
      ledgerLastHour = b.n
    } catch {
      /* כנות: השדות יישארו לא-נמדד */
    }

    const census = (await fetchJsonTimeout(`${APP_URL}/api/census`)) as
      | { chain?: { verify?: { ok?: boolean; total?: number } } }
      | null
    // Task-123 תיקון-מדידה-חיה: census-יחיד זרק אזעקת-שווא (רגע-טרנזיטורי נכתב "ok:false —
    // נדרש-טיפול"). מעתה: שני-מאמתים-בלתי-תלויים מוצגים-גלויים — census + witness (הקפדן
    // העצמאי-הבודק-כל-דקה). אי-התאמה-ביניהם תהיה-נראית; אף-אינטרפרטציה-לא-נכתבת.
    const witness = (await fetchJsonTimeout('http://127.0.0.1:3050/health')) as
      | { last?: { ok?: boolean; total?: number } }
      | null
    const grid = (await fetchJsonTimeout('http://127.0.0.1:3070/health')) as
      | { cycles?: number; lastError?: string | null; halted?: boolean; ffRail?: { ok?: boolean } }
      | null

    const ports: Array<[string, number, string]> = [
      ['app', 3000, '/api/health'],
      ['dex', 3010, '/saos-dex'],
      ['heartbeat', 3031, '/health'],
      ['witness', 3050, '/health'],
      ['keeper', 3051, '/health'],
      ['metrics', 3060, '/health'],
      ['grid', 3070, '/health'],
      ['arb', 3071, '/health'],
      ['council', 3072, '/health'],
      ['vault-guardian', 3080, '/health'],
    ]
    const organRows: string[] = []
    let up = 0
    for (const [name, port, p] of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(4000) })
        if (r.ok) up++
        organRows.push(`| ${name} | ${port} | ${r.ok ? 'חי' : `HTTP ${r.status}`} |`)
      } catch {
        organRows.push(`| ${name} | ${port} | לא-עונה |`)
      }
    }

    const md = [
      '---',
      'title: "דופק-ריבוני — נראות-שעתית של פעילות-המערכת"',
      'kind: DATA',
      'status: APPLIED',
      `createdAt: ${new Date().toISOString()}`,
      'worker: fabric-heartbeat',
      'summary: "קובץ-מתגלגל-יחיד (אפס-רעש-קבצים): מדידה-אמת של השעה האחרונה — שרשרת, גריד, עשרת-האיברים. כל-שדה-שלא-נמדד נכתב כך בכנות."',
      '---',
      '',
      '# דופק-ריבוני (קובץ-מתגלגל — מתעדכן כל שעה)',
      '',
      `נמדד: ${new Date().toISOString()} · ייצור-ה-digest: ${Date.now() - t0}ms`,
      '',
      '## שרשרת-האמת',
      '| מדד | ערך |',
      '|---|---|',
      `| רשומות-סה"כ | ${ledgerTotal ?? 'לא-נמדד'} |`,
      `| פעילות-שעה-אחרונה | ${ledgerLastHour ?? 'לא-נמדד'} רשומות |`,
      `| אימות-census | ${census?.chain?.verify ? (census.chain.verify.ok ? 'ok:true' : 'ok:false') : 'לא-נמדד'} |`,
      `| אימות-witness (בלתי-תלוי) | ${witness?.last ? (witness.last.ok ? `ok:true (total ${witness.last.total ?? '?'})` : 'ok:false') : 'לא-נמדד'} |`,
      '',
      '## גריד-המסחר',
      '| מדד | ערך |',
      '|---|---|',
      `| מצב | ${grid ? (grid.halted ? 'HALTED' : 'פעיל') : 'לא-נמדד'} |`,
      `| מחזורים | ${grid?.cycles ?? 'לא-נמדד'} |`,
      `| lastError | ${grid ? (grid.lastError ?? 'null') : 'לא-נמדד'} |`,
      `| מסילת-FF | ${grid?.ffRail ? (grid.ffRail.ok ? 'חי' : 'מושבת-ספק') : 'לא-נמדד'} |`,
      '',
      `## איברים (חיים: ${up}/${ports.length})`,
      '| איבר | פורט | מצב |',
      '|---|---|---|',
      ...organRows,
      '',
    ].join('\n')
    writeFileSync(path.join(PROJECT_DIR, 'sovereign', 'site', 'sovereign-pulse.md'), md, 'utf8')
    lastDigestAt = new Date().toISOString()
    lastDigestResult = `ok (${Date.now() - t0}ms, organs ${up}/${ports.length})`
    log(`דופק-ריבוני: digest נאטם — ${lastDigestResult}`)
  } catch (e) {
    lastDigestAt = new Date().toISOString()
    lastDigestResult = `failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
    log(`דופק-ריבוני: כשל-כן — ${lastDigestResult}`)
  }
}

// ===== שרת-דופק (תצפית) =====
Bun.serve({
  port: PORT,
  fetch() {
    return new Response(
      JSON.stringify({
        ok: true,
        service: 'fabric-heartbeat',
        app: APP_URL,
        tickMs: TICK_MS,
        gitPulseMin: GIT_PULSE_MS / 60_000,
        gitStuck: gitStuckState(), // Task 103: מצב-תקיעה גלוי-תמיד (rebase/merge יתום = החוסם-השקט הקטלני ביותר)
        lastDigestAt, // Task-123: נראות-שעתית
        lastDigestResult,
        ...state,
      }, null, 2),
      { headers: { 'content-type': 'application/json' } }
    )
  },
})

// ===== כלב-שמיר כנה: אם אין-פעימה מוצלחת 10 דק' — מוות-גלוי (לא-שקט, לא-שקר) =====
setInterval(() => {
  if (Date.now() - lastTickAttemptMs > 10 * 60_000) {
    log('🚨 כלב-שמיר: אין-פעימות 10 דק׳ — יוצא בכנות (הסופר-ויזר של הפלטפורמה יראה את-המוות)')
    process.exit(1)
  }
}, 60_000)

log(
  `fabric-heartbeat חי — tick כל ${TICK_MS / 1000}s (lanes=3), פעימת-גיט כל ${GIT_PULSE_MS / 60_000} דק', פעימת-התפתחות כל ${EVOLUTION_PULSE_MS / 60_000} דק', פעימת-בנייה כל ${BUILD_PULSE_MS / 60_000} דק', עורק-הזדמנות-שנייה כל ${RECOVERY_PULSE_MS / 60_000} דק', עורק-ההשלמה כל ${DISPATCH_PULSE_MS / 60_000} דק', פעימת-ריבונות כל ${OPS_PULSE_MS / 60_000} דק', פעימת-אמת-עצמית כל ${SELFTEST_PULSE_MS / 60_000} דק', תרגיל-תמונה כל ${SNAPSHOT_RESTORE_PULSE_MS / 60_000} דק', סנכרון-ייצוא כל ${EXPORT_SYNC_PULSE_MS / 60_000} דק', תרגיל-ייצוא כל ${EXPORT_RESTORE_PULSE_MS / 60_000} דק', תרגיל-מראה-מקומית כל ${MIRROR_RESTORE_PULSE_MS / 60_000} דק', אטימות-היסטוריה כל ${HISTORY_PULSE_MS / 60_000} דק', אטימות-מסמכים כל ${DOCS_PULSE_MS / 60_000} דק', היסטוריית-מסמכים כל ${DOCS_HISTORY_PULSE_MS / 60_000} דק', עורק-הקופה כל ${TREASURY_PULSE_MS / 60_000} דק', דופק על :${PORT}`
)

setInterval(() => void tick(), TICK_MS)
setTimeout(() => void gitPulseChecked(), GIT_PULSE_FIRST_MS)
setInterval(() => void gitPulseChecked(), GIT_PULSE_MS)
setTimeout(() => void evolutionPulse(), EVOLUTION_PULSE_FIRST_MS)
setInterval(() => void evolutionPulse(), EVOLUTION_PULSE_MS)
setTimeout(() => void buildPulse(), BUILD_PULSE_FIRST_MS)
setInterval(() => void buildPulse(), BUILD_PULSE_MS)
setTimeout(() => void recoveryPulse(), RECOVERY_PULSE_FIRST_MS) // Task 97: עורק-הזדמנות-שנייה
setInterval(() => void recoveryPulse(), RECOVERY_PULSE_MS)
setTimeout(() => void dispatchPulse(), DISPATCH_PULSE_FIRST_MS) // Task 97: עורק-ההשלמה
setInterval(() => void dispatchPulse(), DISPATCH_PULSE_MS)
setTimeout(() => void treasuryPulse(), TREASURY_PULSE_FIRST_MS) // Task 101: עורק-הקופה — אימות-כספת
setInterval(() => void treasuryPulse(), TREASURY_PULSE_MS)
setTimeout(() => void flowPulse(), FLOW_PULSE_FIRST_MS) // Task 104: עורק-אבחון-הזרימה
setInterval(() => void flowPulse(), FLOW_PULSE_MS)
setTimeout(() => void opsPulse(), OPS_PULSE_FIRST_MS)
setInterval(() => void opsPulse(), OPS_PULSE_MS)
setTimeout(() => void selftestPulse(), SELFTEST_PULSE_FIRST_MS)
setInterval(() => void selftestPulse(), SELFTEST_PULSE_MS)
// Task-123: עורק-הנראות — digest ריבוני שעתי (מיד-בעלייה + כל שעה)
setTimeout(() => void sovereignDigest(), 20_000)
setInterval(() => void sovereignDigest(), DIGEST_MS)
setInterval(() => void claimsPulse(), CLAIMS_PULSE_MS)
setTimeout(() => void claimsPulse(), CLAIMS_PULSE_FIRST_MS)
setInterval(() => void sovereigntyPulse(), SOVEREIGNTY_PULSE_MS)
setTimeout(() => void sovereigntyPulse(), SOVEREIGNTY_PULSE_FIRST_MS)
setInterval(() => void magnitudePulse(), MAGNITUDE_PULSE_MS)
setTimeout(() => void magnitudePulse(), MAGNITUDE_PULSE_FIRST_MS)
setTimeout(() => void restorePulse(), RESTORE_PULSE_FIRST_MS)
setInterval(() => void restorePulse(), RESTORE_PULSE_MS)
setTimeout(() => void snapshotRestorePulse(), SNAPSHOT_RESTORE_PULSE_FIRST_MS)
setInterval(() => void snapshotRestorePulse(), SNAPSHOT_RESTORE_PULSE_MS)
setTimeout(() => void exportSyncPulse(), EXPORT_SYNC_PULSE_FIRST_MS) // מחזור-#13: הסנכרון-מקדים-את-התרגיל
setInterval(() => void exportSyncPulse(), EXPORT_SYNC_PULSE_MS)
setTimeout(() => void exportRestorePulse(), EXPORT_RESTORE_PULSE_FIRST_MS)
setInterval(() => void exportRestorePulse(), EXPORT_RESTORE_PULSE_MS)
setTimeout(() => void mirrorRestorePulse(), MIRROR_RESTORE_PULSE_FIRST_MS) // Task 95: המקור-הרביעי — המראה
setInterval(() => void mirrorRestorePulse(), MIRROR_RESTORE_PULSE_MS)
setTimeout(() => void historyPulse(), HISTORY_PULSE_FIRST_MS) // מחזור-#14: אטימות-ההיסטוריה
setInterval(() => void historyPulse(), HISTORY_PULSE_MS)
setTimeout(() => void docsPulse(), DOCS_PULSE_FIRST_MS) // מחזור-#15: אטימות-המסמכים
setInterval(() => void docsPulse(), DOCS_PULSE_MS)
setTimeout(() => void docsHistoryPulse(), DOCS_HISTORY_PULSE_FIRST_MS) // מחזור-#16: היסטוריית-המסמכים
setInterval(() => void docsHistoryPulse(), DOCS_HISTORY_PULSE_MS)
setInterval(() => void appGuard(), APP_GUARD_MS)
setInterval(() => void keeperGuard(), KEEPER_GUARD_MS) // מחזור-הרפואה-החיה: עורק-יג
setTimeout(() => void remoteGatePulse(), REMOTE_GATE_FIRST_MS) // עורק-יד: עד-השער-הרחוק
setInterval(() => void remoteGatePulse(), REMOTE_GATE_PULSE_MS)

void tick() // פעימה-ראשונה מיידית
void appGuard() // בדיקת-בריאות ראשונה מיידית
void keeperGuard() // בדיקת-זקיפה ראשונה מיידית
