// בודק-הטענות (Claims-vs-Reality) — השכבה שמפרידה בין-מה-שהארכיטקטורה-אומרת לבין-מה-שהיא עושה.
//
// רקע (דרישת-הבעלים, 2026-10-20): "הרבה-מההצהרות בארכיטקטורה אינן מדויקות — הכלים לא
// עובדים כמו שהם מתוארים". התרופה: כל-טענה-מרכזית מקבלת בדיקה-חיה קצרה (≤3ש),
// ראייה-כתובה ומצב-כן (פעיל/מופחת/שתוק) — אף-טענה לא נשפטת לפי-מה-שהיא מדווחת על-עצמה.
//
// חוקים-קשים:
//  · קריאות-בלבד — אפס-כתיבה ל-db/גיט/שירותים מהבדיקות-עצמן (החתימה-ב-route בנפרד).
//  · כל-בדיקה חסומה-בזמן — דגימה-חיה אסור-שתיתקע.
//  · fail-honest: בדיקה-שנפלה מדווחת-את-הכישלון בשמו (down + הסבר), לא מוסתרת.
//  · אפס-קריאות-רשת-חוץ (GitHub וכד') — רק-שירותים-מקומיים + גיט-מקומי-קריאה.

import { execFile } from 'node:child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { promisify } from 'util'
import { db } from '@/lib/db'

const execFileP = promisify(execFile)

export type ClaimStatus = 'active' | 'degraded' | 'down'

export interface ClaimProbe {
  id: string
  claim: string // הטענה-הארכיטקטונית — מה-המערכת-מבטיחה
  status: ClaimStatus // מה-שנמדד-בפועל עכשיו
  evidence: string // הראייה-החיה הקצרה (עברית)
  latencyMs: number | null
  probedAt: string
}

export interface ClaimsReport {
  overall: 'active' | 'degraded' | 'critical'
  counts: { total: number; active: number; degraded: number; down: number }
  claims: ClaimProbe[]
  generatedAt: string
  durationMs: number
}

const HEART = 'http://127.0.0.1:3031'
const WITNESS = 'http://127.0.0.1:3050'
const KEEPER = 'http://127.0.0.1:3051'
const ROOT = process.cwd()

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function short(s: string, n = 140): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

// קריאת-HTTP מקומית חסומת-זמן — מחזירה-נתון או-זורקת-שגיאה-כנה
async function getJson<T>(url: string, label: string, ms = 3000): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
  return (await res.json()) as T
}

// פקודת-גיט מקומית-קריאה-בלבד, חסומה-זמן
async function gitOut(args: string[], ms = 4000): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd: ROOT, timeout: ms, maxBuffer: 8 * 1024 * 1024 })
  return stdout.toString('utf8').trim()
}

// עוטף-מדידה: הופך-פרוב-אסינכרוני לרשומת-טענה-כנה (כישלון = down + הסבר, לעולם-לא-שקט)
async function probe(id: string, claim: string, fn: () => Promise<{ status: ClaimStatus; evidence: string }>): Promise<ClaimProbe> {
  const t0 = Date.now()
  try {
    const r = await fn()
    return { id, claim, status: r.status, evidence: r.evidence, latencyMs: Date.now() - t0, probedAt: new Date().toISOString() }
  } catch (e) {
    return { id, claim, status: 'down', evidence: short(errMsg(e)), latencyMs: Date.now() - t0, probedAt: new Date().toISOString() }
  }
}

// ===== הטענות-עצמן =====

interface WitnessJson { ok: boolean; total: number; verified: number; head: string; brokenAt: number | null }
interface HeartJson {
  ok: boolean; lastTickError: string | null
  lastGitPulseResult: string | null; gitPushes: number
  lastSelftestResult: string | null; lastRemoteGateResult: string | null
  lastKeeperGuardResult: string | null; lastAppGuardResult: string | null
}
interface KeeperJson {
  ok: boolean
  mirror: { exists: boolean; synced: boolean; lastResult: string | null; mirrorHead: string | null }
  snapshots: { count: number; lastAt: string | null; lastResult: string | null }
  watches: Record<string, { up: boolean; fails: number; restarts: number }>
}

// טענה 1: "העד מאמת-את-השרשרת-במלואה — אין-שבר"
async function claimWitness(): Promise<{ status: ClaimStatus; evidence: string }> {
  const w = await getJson<WitnessJson>(`${WITNESS}/witness`, 'witness')
  if (!w.ok) return { status: 'down', evidence: 'העד משיב ok:false' }
  if (w.brokenAt !== null) return { status: 'down', evidence: `שרשרת-שבורה ב-${w.brokenAt} (${w.verified}/${w.total} מאומתות)` }
  if (w.verified !== w.total) return { status: 'degraded', evidence: `${w.verified}/${w.total} מאומתות — פער-רישומים` }
  return { status: 'active', evidence: `${w.total}/${w.total} מאומתות · ראש ${w.head.slice(0, 12)}` }
}

// טענה 2: "ראש-ה-db הוא ראש-השרשרת-המאומת" (ה-cross-check שמונע-יצוא-סותר)
async function claimChainHead(w: WitnessJson): Promise<{ status: ClaimStatus; evidence: string }> {
  const last = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' }, select: { id: true, hash: true } })
  if (!last) return { status: 'down', evidence: 'השרשרת ב-db ריקה' }
  if (last.hash !== w.head) return { status: 'degraded', evidence: `ראש-db #${last.id} ${last.hash.slice(0, 12)} ≠ ראש-העד ${w.head.slice(0, 12)}` }
  return { status: 'active', evidence: `ראש-db #${last.id} == ראש-העד (${last.hash.slice(0, 12)})` }
}

// טענה 3: "הייצוא הקנוני == השרשרת" (מ-REPAIR-1382: סריאליזציה-אחת-מוסמכת)
async function claimExport(w: WitnessJson): Promise<{ status: ClaimStatus; evidence: string }> {
  const p = join(ROOT, 'sovereign', 'chain-export', 'ledger.jsonl')
  const raw = await readFile(p, 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const last = JSON.parse(lines[lines.length - 1]) as { hash?: string }
  if (lines.length !== w.total) return { status: 'degraded', evidence: `ייצוא ${lines.length} שורות ≠ ${w.total} רישומי-שרשרת (סנכרון-ממתין)` }
  if (last.hash !== w.head) return { status: 'degraded', evidence: `ראש-ייצוא ${String(last.hash).slice(0, 12)} ≠ ראש-העד ${w.head.slice(0, 12)}` }
  return { status: 'active', evidence: `ייצוא ${lines.length} שורות · ראש == ראש-העד (${w.head.slice(0, 12)})` }
}

// טענה 4: "עורק-הדחיפה חי — הענף מסונכרן עם המקור" (גיט-מקומי-קריאה-בלבד)
async function claimPush(h: HeartJson): Promise<{ status: ClaimStatus; evidence: string }> {
  const head = await gitOut(['rev-parse', 'HEAD'])
  const remote = await gitOut(['rev-parse', 'origin/main'])
  if (head === remote) {
    const blocked = (h.lastGitPulseResult ?? '').startsWith('BLOCKED')
    return blocked
      ? { status: 'degraded', evidence: `מסונכרן אך-הפעימה-האחרונה: ${short(h.lastGitPulseResult ?? '')}` }
      : { status: 'active', evidence: `HEAD == origin/main (${head.slice(0, 12)})` }
  }
  const ahead = await gitOut(['rev-list', '--count', `${remote}..${head}`])
  const behind = await gitOut(['rev-list', '--count', `${head}..${remote}`])
  return { status: 'degraded', evidence: `ענף-מקומי ${ahead}-קדימה · ${behind}-אחורה מ-origin/main — הדחיפה-לא-הושלמה` }
}

// טענה 5: "חסם-הדליפות רץ ואוכף" (הסריקה-עצמה נבחנת — לא-רק-מסופר-עליה)
async function claimLeakGate(): Promise<{ status: ClaimStatus; evidence: string }> {
  await execFileP('node', ['.zscripts/leak-scan.mjs', '--staged'], { cwd: ROOT, timeout: 15_000 })
  return { status: 'active', evidence: 'leak-scan --staged רץ-ונקי (דלתא-מוצבת + untracked)' }
}

// טענה 6: "הלב פועם — העורקים יורים בלי-שגיאה אחרונה"
async function claimHeart(): Promise<{ status: ClaimStatus; evidence: string }> {
  const h = await getJson<HeartJson>(`${HEART}/health`, 'heart')
  if (!h.ok) return { status: 'down', evidence: 'הלב משיב ok:false' }
  if (h.lastTickError) return { status: 'degraded', evidence: `lastTickError: ${short(h.lastTickError)}` }
  return { status: 'active', evidence: 'לב-חי · אפס-שגיאות-tick אחרונות' }
}

// טענה 7: "הזקיפה משגיחה — כל-השירותים חיים בעיניה"
async function claimKeeper(h: HeartJson): Promise<{ status: ClaimStatus; evidence: string }> {
  const k = await getJson<KeeperJson>(`${KEEPER}/health`, 'keeper')
  if (!k.ok) return { status: 'down', evidence: 'הזקיפה משיבה ok:false' }
  const watches = Object.entries(k.watches ?? {})
  const down = watches.filter(([, v]) => !v.up).map(([n]) => n)
  const guarded = (h.lastKeeperGuardResult ?? 'ok') === 'ok' && (h.lastAppGuardResult ?? 'ok') === 'ok'
  if (down.length > 0) return { status: 'degraded', evidence: `שירותים-שתוקים בעיני-הזקיפה: ${down.join(', ')}` }
  return guarded
    ? { status: 'active', evidence: `${watches.length} שירותים חיים בעיני-הזקיפה · השגחה-הדדית-תקינה` }
    : { status: 'degraded', evidence: `השגחה-הדדית-מדווחת-בעיה: app=${h.lastAppGuardResult} keeper=${h.lastKeeperGuardResult}` }
}

// טענה 8: "מראת-הגיבוי מסונכרנת והתמונות-השעתיות טריות"
async function claimBackups(): Promise<{ status: ClaimStatus; evidence: string }> {
  const k = await getJson<KeeperJson>(`${KEEPER}/health`, 'keeper')
  if (!k.mirror.exists) return { status: 'down', evidence: 'מראת-הגיבוי אינה-קיימת' }
  const mirrorOk = k.mirror.synced === true
  const snapAgeMs = k.snapshots.lastAt ? Date.now() - Date.parse(k.snapshots.lastAt) : Infinity
  const snapOk = k.snapshots.count > 0 && snapAgeMs < 2 * 60 * 60 * 1000
  if (mirrorOk && snapOk) return { status: 'active', evidence: `מראה מסונכרנת (${k.mirror.mirrorHead?.slice(0, 12) ?? '—'}) · ${k.snapshots.count} תמונות, אחרונה ${Math.round(snapAgeMs / 60000)}דק'` }
  return {
    status: 'degraded',
    evidence: `מראה: ${mirrorOk ? 'מסונכרנת' : 'לא-מסונכרנת'} · תמונות: ${snapOk ? 'טריות' : 'חסרות/ישנות'}`,
  }
}

// טענה 9: "מסילות-המוח חיות" (האמת-מה-selftest האחרון — כולל-הצערה-הידועה)
async function claimBrain(h: HeartJson): Promise<{ status: ClaimStatus; evidence: string }> {
  const r = h.lastSelftestResult
  if (!r) return { status: 'degraded', evidence: 'אין-selftest אחרון — המוח-מעולם-לא-נבחן' }
  if (r.includes('all ok')) return { status: 'active', evidence: short(r) }
  if (r.includes('כשלים-כנים')) return { status: 'degraded', evidence: short(r) }
  return { status: 'degraded', evidence: short(r) }
}

// טענה 10: "השער-הרחוק (Actions) במצבו-האמיתי" — חסימת-חיוב = שער-בעלים, לא-סוד-שמוסתר
async function claimRemoteGate(h: HeartJson): Promise<{ status: ClaimStatus; evidence: string }> {
  const r = h.lastRemoteGateResult
  if (!r) return { status: 'degraded', evidence: 'טרם-נבדק מעולם' }
  // ירוק-אמת (Task 91 — סגירת-שקר-ענבר): 'ok' מהלב (חוזה-החדש) או מחרוזת-הישן
  // 'completed/success @sha (=local)' — שני-הצורות משפטות-ירוק; אין-עוד-טענה-שלא-תוכל-להיות-אקטיבית.
  const green = r === 'ok' || (r.startsWith('completed/success') && r.includes('(=local)'))
  if (green) return { status: 'active', evidence: 'הריצה-הרחוקה על-הראש-שלנו ירוקה' }
  return { status: 'degraded', evidence: short(r) }
}

// ===== הריכוז =====

export async function collectClaims(): Promise<ClaimsReport> {
  const t0 = Date.now()
  const generatedAt = new Date().toISOString()

  // העד נדרש לכמה-טענות — נמדד קודם ובנפרד; אם-נפל, השאר מדווחות-כנות-עצמאיות
  let witness: WitnessJson | null = null
  try {
    witness = await getJson<WitnessJson>(`${WITNESS}/witness`, 'witness')
  } catch { /* הטענות-התלויות-בו ידווחנה down בזכות-עצמן */ }
  let heart: HeartJson | null = null
  try {
    heart = await getJson<HeartJson>(`${HEART}/health`, 'heart')
  } catch { /* כנ"ו */ }
  const wFallback: WitnessJson = { ok: false, total: 0, verified: 0, head: '', brokenAt: null }
  const hFallback: HeartJson = {
    ok: false, lastTickError: 'הלב-לא-נגיש', lastGitPulseResult: null, gitPushes: 0,
    lastSelftestResult: null, lastRemoteGateResult: null, lastKeeperGuardResult: null, lastAppGuardResult: null,
  }

  const probes = await Promise.all([
    probe('witness-verdict', 'העד מאמת-את-השרשרת-במלואה — אין-שבר, אין-פער', () =>
      claimWitness()),
    probe('chain-head', 'ראש-ה-db זהה-לראש-השרשרת-המאומת', () =>
      claimChainHead(witness ?? wFallback)),
    probe('export-canonical', 'הייצוא-הקנוני זהה-לשרשרת (אחרי REPAIR-1382)', () =>
      claimExport(witness ?? wFallback)),
    probe('push-artery', 'עורק-הדחיפה חי — הענף מסונכרן עם origin/main', () =>
      claimPush(heart ?? hFallback)),
    probe('leak-gate', 'חסם-הדליפות רץ-באמת (לא-רק-מתואר)', () =>
      claimLeakGate()),
    probe('heart-pulse', 'הלב פועם — אפס-שגיאות-עורקים אחרונות', () =>
      claimHeart()),
    probe('keeper-supervision', 'הזקיפה משגיחה-הדדית — כל-השירותים חיים', () =>
      claimKeeper(heart ?? hFallback)),
    probe('backup-mirror', 'מראת-הגיבוי מסונכרנת והתמונות-השעתיות טריות', () =>
      claimBackups()),
    probe('brain-rails', 'מסילות-המוח חיות (selftest אחרון כן)', () =>
      claimBrain(heart ?? hFallback)),
    probe('remote-gate', 'השער-הרחוק (Actions) מדווח-מצבו-האמיתי', () =>
      claimRemoteGate(heart ?? hFallback)),
  ])

  const counts = {
    total: probes.length,
    active: probes.filter((p) => p.status === 'active').length,
    degraded: probes.filter((p) => p.status === 'degraded').length,
    down: probes.filter((p) => p.status === 'down').length,
  }
  const overall = counts.down > 0 ? 'critical' : counts.degraded > 0 ? 'degraded' : 'active'

  return { overall, counts, claims: probes, generatedAt, durationMs: Date.now() - t0 }
}
