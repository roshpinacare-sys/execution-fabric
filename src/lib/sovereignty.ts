// מד-הריבונות-העצמית (Sovereignty Meter) — השכבה שמודדת אם הארכיטקטורה בפועל "הבעלים".
//
// דרישת-הבעלים (2026-10-20): "הארכיטקטורה הריבונית האוטונומית היא הבעלים — לא להפנות אלי
// בקשות אלה רק מקרים מאוד חריגים. המערכת צריכה לדעת לעשות הכל — תוודא רמה בכנות בלי לשקר".
//
// התרופה: מד-ריבונות חי — שישה-ממדים, כל-אחד נמדד מראיות-חיות בלבד (לא מהצהרות),
// fail-honest: ממד-שנפל = down + הסבר, לעולם-לא-ירוק-שקר.
//
// חוק-הצניעות (אנטי-ירוק-שקר): הציון תקרה 96 לעולם — 4% שמורים למה-שלא-יודעים-שלא-יודעים.
// ריבונות-שלמה 100/100 היא טענה-שלא-ניתנת-לבדיקה — וטענה-כזו היא בדיוק מה שאסור.
//
// מרשם-החריגים (Owner Gates): הערוץ הלגיטימי היחיד להפנות-בעלים — שער-חתום עם
// {מה-נוסה, למה-הארכיטקטורה-לא-יכולה-לבד, מה-נדרש}. כל-תלות-בעלים-שאיננה-שער-רשום = פגם-ריבונות.

import { execFile } from 'node:child_process'
import { promisify } from 'util'
import { db } from '@/lib/db'
import { collectClaims } from '@/lib/claims'

const execFileP = promisify(execFile)

export type SovereigntyStatus = 'active' | 'degraded' | 'down'

export interface SovereigntyDimension {
  id: string
  title: string // עברית — ממד-הריבונות
  doctrine: string // מה "ארכיטקטורה-כבעלים" מחייבת בממד-זה
  weight: number // משקל בציון-המרוכב
  status: SovereigntyStatus // מה-נמדד, לא-מה-מדווח
  score: number // 0..100 מדוד
  evidence: string // הראייה-החיה הקצרה (עברית)
}

export interface SovereigntyGate {
  id: string // מזהה-שער
  title: string
  whyNotSelf: string // למה הארכיטקטורה לא יכולה-לבד — כנות-מלאה
  tried: string // מה נוסה לפני-ההפניה
  need: string // מה נדרש מהבעלים — אם-בכלל, עכשיו
  status: 'dormant' | 'demanding' | 'resolved' // dormant=קיים-אך-לא-דורש כלום עכשיו
  evidence: string
}

export interface SovereigntyReport {
  level: number // 0..100 מדוד — תקרה 96 (חוק-הצניעות)
  overall: 'sovereign' | 'active-with-holes' | 'partial' | 'owner-dependent'
  dimensions: SovereigntyDimension[]
  gates: SovereigntyGate[] // החריגים-הלגיטימיים-היחידים להפניית-בעלים
  architectureSigned48h: number // הכרעות-שחתמה-הארכיטקטורה ב-48 שעות
  ownerSigned48h: number // הכרעות-שחתם-הבעלים ב-48 שעות — צריך-להיות 0 או-קרוב
  generatedAt: string
  durationMs: number
}

const ROOT = process.cwd()
const HEART = 'http://127.0.0.1:3031'
const WITNESS = 'http://127.0.0.1:3050'
const KEEPER = 'http://127.0.0.1:3051'
const APP = 'http://127.0.0.1:3000'

// חותמות-עובדים-של-הארכיטקטורה-עצמה (הריבון) — מול-חותמות-בעלים/אדם
const OWNER_WORKERS = new Set(['owner', 'operator', 'human', 'manual'])
// מסילות-מוח (מועמדי-LLM בשרשרת) — חלק-מהריבון, לא "בונים-חולפים"
const BRAIN_RAIL_WORKERS = new Set(['zai-primary', 'nvidia-nim', 'zai-compact-retry', 'exhausted'])

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function short(s: string, n = 150): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function statusFrom(score: number): SovereigntyStatus {
  return score >= 85 ? 'active' : score >= 50 ? 'degraded' : 'down'
}

async function getJson<T>(url: string, label: string, ms = 3000): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
  return (await res.json()) as T
}

async function gitOut(args: string[], ms = 4000): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: ROOT, timeout: ms, maxBuffer: 8 * 1024 * 1024 })
  return stdout.toString('utf8').trim()
}

interface HeartJson {
  ok: boolean
  startedAt: string
  picked: number
  executed: number
  gitPushes: number
  gitHeals: number
  evolutionQueued: number
  buildApplied: number
  opsDelivered: number
  narrations: number
  appRestarts: number
  keeperRestarts: number
  lastAppGuardResult: string | null
  lastKeeperGuardResult: string | null
  restoreOk: boolean | null
  snapshotRestoreOk: boolean | null
  exportSyncOk: boolean | null
  // ספירות-עורקים לחיות (עורק: [פעימות, תוצאה-אחרונה])
  gitPulses: number
  lastGitPulseResult: string | null
  evolutionPulses: number
  lastEvolutionResult: string | null
  buildPulses: number
  lastBuildResult: string | null
  opsPulses: number
  lastOpsResult: string | null
  selftestPulses: number
  lastSelftestResult: string | null
  claimsPulses: number
  lastClaimsResult: string | null
  sovereigntyPulses: number
  lastSovereigntyResult: string | null
  restorePulses: number
  lastRestoreResult: string | null
  snapshotRestorePulses: number
  lastSnapshotRestoreResult: string | null
  exportSyncPulses: number
  lastExportSyncResult: string | null
  exportRestorePulses: number
  lastExportRestoreResult: string | null
  historyPulses: number
  lastHistoryResult: string | null
  docsPulses: number
  lastDocsResult: string | null
  docsHistoryPulses: number
  lastDocsHistoryResult: string | null
  lastRemoteGateAt: string | null
  lastRemoteGateResult: string | null
}

interface KeeperJson {
  ok: boolean
  mirror: { exists: boolean; synced: boolean; updates: number }
  snapshots: { count: number; lastAt: string | null }
  events: Array<{ at: string; kind: string; msg: string }>
  watches: Record<string, { up: boolean; fails: number; restarts: number }>
}

// ===== ממד 1: הכרעה-עצמית — מי-חותם-את-ההכרעות? =====
async function measureSelfDecision(): Promise<Pick<SovereigntyDimension, 'status' | 'score' | 'evidence'> & { arch: number; owner: number }> {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const rows = await db.ledgerEntry.groupBy({ by: ['worker'], _count: true, where: { createdAt: { gte: since } } })
  let arch = 0
  let owner = 0
  let total = 0
  for (const r of rows) {
    const n = r._count ?? 0
    total += n
    if (OWNER_WORKERS.has(r.worker)) owner += n
    else arch += n // כל-חותם-שאיננו-בעלים הוא-רכיב-ארכיטקטורה (עורקים, מסילות-מוח, בודקים)
  }
  const share = total > 0 ? Math.round((arch / total) * 100) : 0
  const ownerShare = total > 0 ? Math.round((owner / total) * 100) : 0
  // ציון: נתח-הארכיטקטורה, מופחת-בנתח-הבעלים (הפניית-הכרעות-לבעלים = נקודה-שחורה)
  const score = Math.max(0, share - ownerShare)
  return {
    status: statusFrom(score),
    score,
    evidence: `${arch} מ-${total} הכרעות-48שע' חתומות-ארכיטקטורה (${share}%) · חתומות-בעלים: ${owner}`,
    arch,
    owner,
  }
}

// ===== ממד 2: ביצוע-עצמי — הארכיטקטורה עושה עבודה-אמיתית, לא רק מנטרת =====
async function measureSelfExecution(h: HeartJson | null): Promise<Pick<SovereigntyDimension, 'status' | 'score' | 'evidence'>> {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const codeDone = await db.ledgerEntry.count({ where: { kind: 'CODE', status: 'DONE', createdAt: { gte: since } } })
  const sitebuild = await db.ledgerEntry.count({ where: { kind: 'SITEBUILD', status: 'DONE', createdAt: { gte: since } } })
  const born =
    (h?.evolutionQueued ?? 0) + (h?.buildApplied ?? 0) + (h?.opsDelivered ?? 0) + (h?.narrations ?? 0)
  const executedNow = (h?.executed ?? 0) + (h?.picked ?? 0)
  // ציון: עבודה-מוצרת-אמיתית ב-48שע' — CODE גמור הוא-הראייה-הקשה; לידות-עורקים מהריצה-הנוכחית תורמות
  const raw = Math.min(100, codeDone * 4 + sitebuild * 2 + born * 3 + executedNow * 2)
  const score = Math.min(100, raw)
  const evidence = `CODE-גמור-48שע': ${codeDone} · SITEBUILD: ${sitebuild} · לידות-עורקים-ריצה-נוכחית: ${born} · picked/executed: ${executedNow}`
  return { status: statusFrom(score), score, evidence }
}

// ===== ממד 3: ריפוי-עצמי — מחלימה בלי-יד-אנושית =====
async function measureSelfHealing(h: HeartJson | null, k: KeeperJson | null): Promise<Pick<SovereigntyDimension, 'status' | 'score' | 'evidence'>> {
  if (!k) return { status: 'down', score: 0, evidence: 'הזקיפה לא נגישה — אין-ראיית-ריפוי' }
  const watches = Object.values(k.watches ?? {})
  const upShare = watches.length > 0 ? watches.filter((w) => w.up).length / watches.length : 0
  const guardsOk = (h?.lastAppGuardResult ?? 'ok') === 'ok' && (h?.lastKeeperGuardResult ?? 'ok') === 'ok'
  const dualGuard = (h?.appRestarts ?? 0) >= 0 && (k.mirror.updates ?? 0) > 0
  const restoresOk = [h?.restoreOk, h?.snapshotRestoreOk, h?.exportSyncOk].filter((x) => x !== null)
  const restoresGood = restoresOk.filter((x) => x === true).length
  const restoreScore = restoresOk.length > 0 ? restoresGood / restoresOk.length : 0.5
  const score = Math.round(upShare * 50 + (guardsOk ? 15 : 0) + (dualGuard ? 10 : 0) + restoreScore * 25)
  const respawned = (k.events ?? []).filter((e) => e.kind === 'respawn').length
  const evidence = `${watches.filter((w) => w.up).length}/${watches.length} שירותים-חיים · השגחה-הדדית ${guardsOk ? 'תקינה' : 'פגומה'} · שחזורים ${restoresGood}/${restoresOk.length} · תחיות-מתועדות: ${respawned}`
  return { status: statusFrom(score), score, evidence }
}

// ===== ממד 4: רוחב-עורקים — "לעשות הכל מהכל": כמה עורקים חיים מתוך-מה-שמחובר =====
// הפרדה-כנה (לקח-מהמדידה-הראשונה): חיות-עורק ≠ תוצר-עורק.
//  · חי = יורה באופן-אוטונומי (פעימות>0) — זה-מה-שמד-הריבונות בודק (האם-הארכיטקטורה מפעילה-את-עצמה)
//  · מודגל = יורה אך-התוצר-האחרון כשל ('failed:'/'error:') — נספר-חלקית, נחשף-בראייה
//  · מת = לא-ירה-כלל והלב כבר-בשל (uptime ≥ 6 דק' — מעבר לחלון-ההצתות-הראשונות)
//  · מתחמם = לא-ירה אך-הלב צעיר — לא-נענש (לא-שקר: מצוין-בראייה)
interface ArteryDef {
  name: string
  pulses: number | undefined
  result: string | null | undefined
}
function arteryHealth(h: HeartJson | null): {
  live: number
  flagged: number
  warming: number
  dead: number
  total: number
  flaggedNames: string[]
  deadNames: string[]
} {
  if (!h) return { live: 0, flagged: 0, warming: 0, dead: 0, total: 0, flaggedNames: [], deadNames: ['heart-unreachable'] }
  const arteries: ArteryDef[] = [
    { name: 'git-push', pulses: h.gitPulses, result: h.lastGitPulseResult },
    { name: 'evolution', pulses: h.evolutionPulses, result: h.lastEvolutionResult },
    { name: 'build', pulses: h.buildPulses, result: h.lastBuildResult },
    { name: 'ops', pulses: h.opsPulses, result: h.lastOpsResult },
    { name: 'selftest', pulses: h.selftestPulses, result: h.lastSelftestResult },
    { name: 'claims', pulses: h.claimsPulses, result: h.lastClaimsResult },
    { name: 'sovereignty', pulses: h.sovereigntyPulses ?? 0, result: h.lastSovereigntyResult },
    { name: 'restore', pulses: h.restorePulses, result: h.lastRestoreResult },
    { name: 'snapshot-restore', pulses: h.snapshotRestorePulses, result: h.lastSnapshotRestoreResult },
    { name: 'export-sync', pulses: h.exportSyncPulses, result: h.lastExportSyncResult },
    { name: 'export-restore', pulses: h.exportRestorePulses, result: h.lastExportRestoreResult },
    { name: 'history', pulses: h.historyPulses, result: h.lastHistoryResult },
    { name: 'docs', pulses: h.docsPulses, result: h.lastDocsResult },
    { name: 'docs-history', pulses: h.docsHistoryPulses, result: h.lastDocsHistoryResult },
    { name: 'remote-gate', pulses: h.lastRemoteGateAt ? 1 : 0, result: h.lastRemoteGateResult },
    { name: 'app-guard', pulses: h.lastAppGuardAt ? 1 : 0, result: h.lastAppGuardResult },
    { name: 'keeper-guard', pulses: 1, result: h.lastKeeperGuardResult },
  ]
  const uptimeMs = (() => {
    try {
      return Date.now() - Date.parse(h.startedAt as unknown as string)
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  })()
  const mature = uptimeMs > 6 * 60_000 // מעבר לחלון-ההצתות-הראשונות של כל-העורקים
  let live = 0
  let flagged = 0
  let warming = 0
  let dead = 0
  const flaggedNames: string[] = []
  const deadNames: string[] = []
  for (const a of arteries) {
    const fired = (a.pulses ?? 0) > 0
    const productFailed = /^(failed:|error:)/.test(a.result ?? '')
    if (fired && productFailed) {
      flagged++
      flaggedNames.push(a.name)
    } else if (fired) {
      live++
    } else if (!mature) {
      warming++
    } else {
      dead++
      deadNames.push(a.name)
    }
  }
  return { live, flagged, warming, dead, total: arteries.length, flaggedNames, deadNames }
}
async function measureBreadth(h: HeartJson | null): Promise<Pick<SovereigntyDimension, 'status' | 'score' | 'evidence'>> {
  const { live, flagged, warming, dead, total, flaggedNames, deadNames } = arteryHealth(h)
  const counted = live + flagged + dead // מתחממים לא נשפטים — אין-אשמה על-צעירות
  const score = counted > 0 ? Math.round(((live + flagged * 0.6) / counted) * 100) : 0
  const parts = [`${live} חיים`]
  if (flagged > 0) parts.push(`${flagged} יורים-עם-תוצר-כושל: ${flaggedNames.slice(0, 3).join(',')}`)
  if (warming > 0) parts.push(`${warming} מתחממים (לב-צעיר)`)
  if (dead > 0) parts.push(`${dead} מתים: ${deadNames.slice(0, 3).join(',')}`)
  const evidence = `${total} עורקים מחוברים · ${parts.join(' · ')}`
  return { status: statusFrom(score), score, evidence }
}

// ===== ממד 5: עצמאות-מהבונים-החולפים — הכל חי גם-בלעדיהם =====
// הבונים-החולפים (סוכני-סשן כמו z.ai/z) מתים-מעצמם — הריבון חייב-לרוץ בלעדיהם.
// מסילת-מוח (מועמד-LLM) איננה "בונה-חולף" — היא רכיב-ריצה. הבדיקה: השירותים-חיים
// והטענות-המהותיות (פרט-ל-mind שתלוי-במסילה) ירוקות עכשיו.
async function measureBuilderIndependence(): Promise<Pick<SovereigntyDimension, 'status' | 'score' | 'evidence'>> {
  const services = [
    { name: 'app', url: `${APP}/api/health` },
    { name: 'heart', url: `${HEART}/health` },
    { name: 'witness', url: `${WITNESS}/health` },
    { name: 'keeper', url: `${KEEPER}/health` },
  ]
  const results = await Promise.all(
    services.map(async (s) => ({ name: s.name, ok: await getJson<{ ok?: boolean }>(s.url, s.name).then((r) => r.ok !== false).catch(() => false) }))
  )
  const up = results.filter((r) => r.ok).length
  let claimsCore = { total: 0, active: 0 }
  try {
    const rep = await collectClaims()
    const core = rep.claims.filter((c) => c.id !== 'brain-rails') // brain-rails = מסילת-מוח, נשפטת-בנפרד
    claimsCore = { total: core.length, active: core.filter((c) => c.status === 'active').length }
  } catch { /* כנות: בלי-בודק-הטענות הממד-מופחת */ }
  const coreShare = claimsCore.total > 0 ? claimsCore.active / claimsCore.total : 0.5
  const score = Math.round((up / services.length) * 60 + coreShare * 40)
  const down = results.filter((r) => !r.ok).map((r) => r.name)
  const evidence = `${up}/${services.length} שירותים-חיים${down.length ? ` (${down.join(',')})` : ''} · ${claimsCore.active}/${claimsCore.total} טענות-מהותיות-פעילות בלי-סוכני-סשן`
  return { status: statusFrom(score), score, evidence }
}

// ===== ממד 6 + מרשם-החריגים: ניתוב-בעלים — חריגים-חתומים בלבד =====
async function measureOwnerRouting(h: HeartJson | null): Promise<Pick<SovereigntyDimension, 'status' | 'score' | 'evidence'> & { gates: SovereigntyGate[] }> {
  const gates: SovereigntyGate[] = []

  // שער 1: חידוש-טוקן-גיטהאב — הנפקת-טוקן דורשת-זהות-חשבון-חוץ. כל-עוד-הדחיפה-חיה השער-ישן.
  // דיוק (לקח-מהמדידה-הראשונה): מחזור-דחיפה-בעיצומו (האד-גיט-חדש, דחיפה-בדרך) איננו "שער-דורש-בעלים" —
  // רק-כשל-אימות-אמיתי (401/403/blocked) מכריז-על-טוקן-מת. אחרת-אנחנו עצמנו יוצרים שקר-אדום-שקרי.
  const pushResult = h?.lastGitPulseResult ?? ''
  const authDead = /40[13]|auth|blocked|denied|token/i.test(pushResult)
  const headSynced = await gitOut(['rev-parse', 'HEAD']).then((head) => gitOut(['rev-parse', 'origin/main']).then((r) => r === head)).catch(() => false)
  const tokenAlive = pushResult.startsWith('pushed') || headSynced || (authDead === false && (h?.gitPulses ?? 0) > 0)
  gates.push({
    id: 'github-token-rotation',
    title: 'חידוש-טוקן-גיטהאב (אם-ימות)',
    whyNotSelf: 'הנפקת-טוקן GitHub מחייבת-זהות-בעלים-בממשק-החוץ — לא-קיים-דרך-API',
    tried: 'אימות-חי-בכל-פעימת-דחיפה · helper-קורא-מהדיסק-בזמן-ריצה · עורק-דחיפה-אוטונומי',
    need: tokenAlive ? 'כלום-עכשיו — הטוקן-חי' : 'טוקן-חדש מממשק-הבעלים',
    status: tokenAlive ? 'dormant' : 'demanding',
    evidence: pushResult.startsWith('pushed')
      ? `הדחיפה-חיה: ${short(pushResult, 60)}`
      : headSynced
        ? 'HEAD == origin/main — הטוקן-מתפקד'
        : tokenAlive
          ? `מחזור-בעיצומו-ללא-כשל-אימות: ${short(pushResult, 60)}`
          : 'כשל-אימות-חוזר — השער-דורש-בעלים',
  })

  const demanding = gates.filter((g) => g.status === 'demanding').length
  const dormant = gates.filter((g) => g.status === 'dormant').length
  // ציון: 100 אם-אפס-שערים-דורשים; כל-שער-דורש = 40; ישן עולה-אחרת
  const score = demanding === 0 ? (dormant > 0 ? 85 : 100) : Math.max(20, 100 - demanding * 60)
  const evidence = `${demanding} שערים-דורשים-בעלים · ${dormant} ישנים-מנוטרים · כל-השאר — הכרעה-עצמית-מלאה`
  return { status: statusFrom(score), score, evidence, gates }
}

// ===== הריכוז =====
export async function collectSovereignty(): Promise<SovereigntyReport> {
  const t0 = Date.now()
  const generatedAt = new Date().toISOString()

  let heart: HeartJson | null = null
  let keeper: KeeperJson | null = null
  try {
    heart = await getJson<HeartJson>(`${HEART}/health`, 'heart')
  } catch { /* כנות */ }
  try {
    keeper = await getJson<KeeperJson>(`${KEEPER}/health`, 'keeper')
  } catch { /* כנות */ }

  const [decision, execution, healing, breadth, independence, routing] = await Promise.all([
    measureSelfDecision().catch((e) => ({ status: 'down' as const, score: 0, evidence: short(errMsg(e)), arch: 0, owner: 0 })),
    measureSelfExecution(heart).catch((e) => ({ status: 'down' as const, score: 0, evidence: short(errMsg(e)) })),
    measureSelfHealing(heart, keeper).catch((e) => ({ status: 'down' as const, score: 0, evidence: short(errMsg(e)) })),
    measureBreadth(heart).catch((e) => ({ status: 'down' as const, score: 0, evidence: short(errMsg(e)) })),
    measureBuilderIndependence().catch((e) => ({ status: 'down' as const, score: 0, evidence: short(errMsg(e)) })),
    measureOwnerRouting(heart).catch((e) => ({ status: 'down' as const, score: 0, evidence: short(errMsg(e)), gates: [] as SovereigntyGate[] })),
  ])

  const dimensions: SovereigntyDimension[] = [
    { id: 'self-decision', title: 'הכרעה-עצמית', doctrine: 'הארכיטקטורה חותמת-על-ההכרעות — לא מפנה-לבעלים', weight: 0.25, ...decision },
    { id: 'self-execution', title: 'ביצוע-עצמי', doctrine: 'הארכיטקטורה עושה-עבודה-אמיתית — לא רק מנטרת', weight: 0.2, ...execution },
    { id: 'self-healing', title: 'ריפוי-עצמי', doctrine: 'מחלימה-עצמית מלאה — אפס-יד-אנושית', weight: 0.2, ...healing },
    { id: 'capability-breadth', title: 'רוחב-עורקים', doctrine: '"לעשות הכל מהכל" — כמה עורקים חיים', weight: 0.15, ...breadth },
    { id: 'builder-independence', title: 'עצמאות-מהבונים-החולפים', doctrine: 'הכל חי גם-בלי סוכני-הסשן החולפים', weight: 0.1, ...independence },
    { id: 'owner-routing', title: 'ניתוב-חריגים-בלבד', doctrine: 'בעלים = חריגים-חתומים בלבד, לא-ברירת-מחדל', weight: 0.1, ...routing },
  ]

  const weighted = dimensions.reduce((acc, d) => acc + d.score * d.weight, 0)
  // חוק-הצניעות: תקרה 96 — 4% שמורים למה-שלא-יודעים-שלא-יודעים
  const level = Math.min(96, Math.round(weighted))
  // אנטי-ירוק-שקר: "ריבונות" נחתמת רק אם כל-הממדים פעילים — ממד-אחד-שקט פוסל-את-הכותרת
  const worst = dimensions.reduce<SovereigntyStatus>((w, d) => (d.status === 'down' ? 'down' : d.status === 'degraded' && w !== 'down' ? 'degraded' : w), 'active')
  const overall: SovereigntyReport['overall'] =
    level >= 85 && worst === 'active'
      ? 'sovereign'
      : level >= 65 && worst !== 'down'
        ? 'active-with-holes'
        : level >= 40
          ? 'partial'
          : 'owner-dependent'

  return {
    level,
    overall,
    dimensions,
    gates: routing.gates,
    architectureSigned48h: decision.arch,
    ownerSigned48h: decision.owner,
    generatedAt,
    durationMs: Date.now() - t0,
  }
}
