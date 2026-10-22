import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedgerResilient, sha256Short } from '@/lib/ledger'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

// נתיבים-דינמיים-בלבד (חוק-מניעת-דליפת-workpath): אפס-נתיבים-מוצקים-בקוד
const PROJECT_ROOT = process.cwd()

// משטח-ההוכחה (Task-124): הבעלים דרש הוכחה — לא טענות.
//   "אין הוכחה לטענות שלך הכל נופל ולא חוזר"
// החוק כאן: כל-שדה נמדד בזמן-הבקשה הזו, מול-העולם-האמיתי — אפס-זיכרון-מטמון, אפס-טענה.
//   איברים → בדיקת-HTTP חיה עם-זמן-תגובה-מדוד.
//   נפילות-וחזרות → קובץ-המצב-של-הזקיפה עצמו (אירועי-הזנקה מדויקים: נפל→חזר).
//   שרשרת → ספירה-חיה + עד-השרשרת (witness) עצמו מאמת.
//   גיט → HEAD מול origin/main נמדד בפועל.
// כל-המדידות במקביל (Promise.allSettled) — איבר-מת-אחד לא מושך-למטה-את-השאר.

export const dynamic = 'force-dynamic'

const exec = promisify(execFile)
const PROBE_TIMEOUT_MS = 1500

const ORGANS: Array<{ name: string; port: number; path: string }> = [
  { name: 'app', port: 3000, path: '/api/health' },
  { name: 'dex', port: 3010, path: '/saos-dex/api/dex/state' },
  { name: 'heartbeat', port: 3031, path: '/health' },
  { name: 'witness', port: 3050, path: '/health' },
  { name: 'keeper', port: 3051, path: '/health' },
  { name: 'metrics', port: 3060, path: '/health' },
  { name: 'grid', port: 3070, path: '/health' },
  { name: 'arb', port: 3071, path: '/health' },
  { name: 'council', port: 3072, path: '/health' },
  { name: 'vault-guardian', port: 3080, path: '/health' },
]

type OrganProbe = {
  name: string
  port: number
  up: boolean
  latencyMs: number | null
  httpStatus: number | null
  error: string | null
}

async function probeOrgan(o: { name: string; port: number; path: string }): Promise<OrganProbe> {
  const t0 = Date.now()
  try {
    const res = await fetch(`http://127.0.0.1:${o.port}${o.path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return { name: o.name, port: o.port, up: res.ok, latencyMs: Date.now() - t0, httpStatus: res.status, error: res.ok ? null : `HTTP ${res.status}` }
  } catch (e) {
    return { name: o.name, port: o.port, up: false, latencyMs: null, httpStatus: null, error: e instanceof Error ? e.message.slice(0, 80) : 'probe-failed' }
  }
}

type KeeperEvent = { at: string; kind: string; msg: string }

function readKeeperState(): { source: string; data: unknown | null } {
  // מחוץ-לעץ-הפרויקט (STATE_PATH של-הזקיפה) — fallback לשיקוף-הגיט; נגזר-מהעץ, לא-מוצק
  const candidates = [resolve(PROJECT_ROOT, '..', 'fabric-keeper-state.json'), join(PROJECT_ROOT, 'fabric-keeper-state.json')]
  for (const p of candidates) {
    try {
      if (existsSync(p)) return { source: p, data: JSON.parse(readFileSync(p, 'utf8')) }
    } catch {
      // קובץ-הבא-בתור — אפס-העלאות-יד
    }
  }
  return { source: 'missing', data: null }
}

async function git(args: string[]): Promise<string | null> {
  try {
    const r = await exec('git', args, { cwd: PROJECT_ROOT, timeout: 3000 })
    return r.stdout.trim()
  } catch {
    return null
  }
}

// תוצר-המדידה — משותף-ל-GET (תצוגה) ול-POST (חתימת-שרשרת)
export async function measureProof(): Promise<{ snapshot: Record<string, unknown>; measureMs: number }> {
  const t0 = Date.now()
  const measuredAt = new Date().toISOString()

  // 1) איברים — מדידה-חיה-מקבילית
  const organProbes = await Promise.all(ORGANS.map(probeOrgan))
  const upCount = organProbes.filter(o => o.up).length

  // 2) זקיפה — אירועי-נפילה-וחזרה ממצב-הזקיפה-עצמו
  const ks = readKeeperState()
  type KeeperWatch = { up?: boolean; restarts?: number; lastResult?: string | null; lastCheckAt?: string | null }
  const kd = (ks.data ?? null) as { ticks?: number; watches?: Record<string, KeeperWatch>; events?: KeeperEvent[] } | null
  const events = Array.isArray(kd?.events) ? kd!.events! : []
  const respawnEvents = events.filter(e => e.kind === 'respawn')
  const watchesSummary = kd?.watches
    ? Object.entries(kd.watches).map(([name, w]) => ({ name, up: !!w.up, restarts: w.restarts ?? 0, lastResult: w.lastResult ?? null }))
    : []

  // 3) שרשרת — ספירה-חיה + עד-חיצוני; ומצב-הלב (פעימת-הגיט-עצמה) — Task-125
  const hourAgo = new Date(Date.now() - 3600_000) // schema מגדיר DateTime — פילטר-פריזמה לוקח Date (שיעור-122 היה-על-שאילתות-sqlite-גולמיות)
  const [total, lastHour, last12, witness, keeperHealth, heartState] = await Promise.all([
    db.ledgerEntry.count(),
    db.ledgerEntry.count({ where: { createdAt: { gte: hourAgo } } }),
    db.ledgerEntry.findMany({ orderBy: { id: 'desc' }, take: 12, select: { id: true, createdAt: true, worker: true, status: true } }),
    fetch('http://127.0.0.1:3050/witness', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .catch(() => null),
    // Task-124: lastTickAt נמדד-חי-מהזקיפה-עצמה (קובץ-המצב-נשטף-תקופתית-ומפגר)
    fetch('http://127.0.0.1:3051/health', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
      .then(r => r.json())
      .catch(() => null),
    // Task-125: פעימת-הגיט-מהלב-עצמו — "pushed/push failed/שעה" — ההוכחה-שהבעלים-ראה-חסרה
    fetch('http://127.0.0.1:3031/', { cache: 'no-store', signal: AbortSignal.timeout(2000) })
      .then(r => r.json())
      .catch(() => null),
  ])

  // 4) גיט — נמדד בפועל
  const [head, originMain, lastCommitInfo, branch] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['rev-parse', 'origin/main']),
    git(['log', '-1', '--format=%h %s | %cI']),
    git(['rev-parse', '--abbrev-ref', 'HEAD']),
  ])

  // 5) נכסי-ריבונות (בנייה-מחדש-אחרי-התחלה-קרה + פעימת-ראיה-שעתית) — נגזר-מהעץ
  const bootAll = join(PROJECT_ROOT, '.zscripts', 'boot-all.sh')
  const pulseFile = join(PROJECT_ROOT, 'sovereign', 'site', 'sovereign-pulse.md')
  const assets = {
    bootAllScript: existsSync(bootAll),
    sovereignPulse: existsSync(pulseFile) ? { exists: true, mtime: new Date(statSync(pulseFile).mtimeMs).toISOString() } : { exists: false, mtime: null },
  }

  const hs = (heartState ?? null) as {
    gitPulses?: number
    gitPushes?: number
    lastGitPulseAt?: string | null
    lastGitPulseResult?: string | null
    appRestarts?: number
    lastAppGuardResult?: string | null
  } | null

  const snapshot = {
    measuredAt,
    measureMs: Date.now() - t0,
    rule: 'כל-שדה נמדד בזמן-אמת בבקשה-זו — אפס-טענה, אפס-מטמון',
    organs: { up: upCount, total: ORGANS.length, probes: organProbes },
    keeper: {
      stateFile: ks.source,
      ticks: kd?.ticks ?? null,
      lastTickAt: (keeperHealth as { lastTickAt?: string | null } | null)?.lastTickAt ?? (kd as { lastTickAt?: string | null } | null)?.lastTickAt ?? null,
      watches: watchesSummary,
      respawnCount: respawnEvents.length,
      respawnLatest: respawnEvents.slice(-8),
      eventsLatest: events.slice(-8),
    },
    chain: {
      total,
      lastHour,
      last12,
      witness: witness ?? { ok: false, error: 'witness-unreachable' },
    },
    git: {
      branch,
      head,
      originMain,
      synced: head !== null && head === originMain,
      lastCommit: lastCommitInfo,
    },
    // Task-125: מצב-פעימת-הגיט-מהלב — נמדד-חי-בבקשה-זו (null כנה אם-הלב-לא-עונה)
    pulse: hs
      ? {
          gitPulses: typeof hs.gitPulses === 'number' ? hs.gitPulses : null,
          gitPushes: typeof hs.gitPushes === 'number' ? hs.gitPushes : null,
          lastGitPulseAt: hs.lastGitPulseAt ?? null,
          lastGitPulseResult: hs.lastGitPulseResult ?? null,
          appRestarts: typeof hs.appRestarts === 'number' ? hs.appRestarts : null,
          lastAppGuardResult: hs.lastAppGuardResult ?? null,
        }
      : null,
    assets,
  }
  return { snapshot, measureMs: Date.now() - t0 }
}

export async function GET() {
  const { snapshot } = await measureProof()
  return NextResponse.json(snapshot)
}

// חותם-ההוכחה (Task-124): מודד-חי-עכשיו וחותם-את-התמונה-על-השרשרת.
// כל-חותמת-כזו היא רשומה-חתומה-עם-hash-של-התמונה — הוכחה-רובצת-שלא-ניתנת-לשכתוב.
export async function POST() {
  const { snapshot, measureMs } = await measureProof()
  const sealed = await appendLedgerResilient({
    taskId: null,
    kind: 'AUDIT',
    status: 'DONE',
    worker: 'proof-seal',
    attempts: 1,
    durationMs: measureMs,
    errorClass: null,
    outputHash: sha256Short(JSON.stringify(snapshot)),
  })
  return NextResponse.json({ ok: true, sealedId: sealed.id, snapshot })
}
