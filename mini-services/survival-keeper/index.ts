// survival-keeper — הזקיפה (Task 71)
// ═══════════════════════════════════════════════════════════════════════════
// שכבת-ההישרדות-הרביעית. עד-היום: דחיפה-אוטומטית (עורק-ב) · עד-עצמאי (chain-witness)
// · תרגיל-שחזור (עורק-ח). חסר-היה: מי מזניק מחדש את-הלב ואת-העד כשהם מתים בלילה.
//
// שלוש-משימות:
//   1. זקיפה: מעקב-חי אחרי fabric-heartbeat (:3031) ו-chain-witness (:3050) —
//      3 כשלים-רצופים (~30ש) = הזנקה-מחדש (bun run dev, בן-מנותק), backoff 2דק'
//      בין-הזנקות-של-אותו-שירות (מנע-סערת-הזנקות). האפליקציה (:3000) — נצפית-בלבד:
//      הזנקתה היא תפקיד-הלב (עורק-0) — אחריות-אחת-לכל-מי, אפס-כפילות-סמכות.
//   2. מראת-גיבוי-מקומית: bare-mirror של הריפו מחוץ-לעץ-הפרויקט, מתעדכנת כל-30דק'
//      (טוקן אף-פעם לא נוגע-בדיסק כאן — רק-דרך-credential-helper הקיים, שקורא
//      את-כספת-ההרשאה בזמן-ריצה). מגינה-משחיתות-עץ/קומיטים-מקומיים — לא-ממחיקת-סנדבוקס
//      (לזה: github + עורק-ח, ראה docs/SURVIVAL.md).
//   3. תמונות-db: כל-שעה VACUUM INTO מחיבור-readonly (עותק-עקבי-אטומי) אל
//      תיקיית-גיבוי מחוץ-לעץ; מוגבל-ל-24-אחרונות. נגזרת-מיקום-עצמי בכל-הנתיבים
//      (חסם-הדליפות: אפס-נתיבי-מכונה-מילוליים בעץ).
//
// כנות: מי-משגיח-על-הזקיפה? העץ-המתמיד של הפלטפורמה (bun --hot) + כלב-השמיר
// של הלב + badge-חי לבעלים ב-census. הזקיפה אינה-אלוהות — היא-שכבה.
// אף-סוד לא נוגע/נדפס כאן. אף-כתיבה-לגיט לא נעשית כאן (רק-קריאה-למראה).

import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync } from 'node:fs'
import { Database } from 'bun:sqlite'

const PORT = Number(process.env.SURVIVAL_PORT ?? 3051)
// נגזרת-מיקום-עצמי (mini-services/survival-keeper → שורש-הפרויקט) — אפס-נתיב-מילולי
const PROJECT_ROOT = process.env.SURVIVAL_PROJECT ?? path.resolve(import.meta.dir, '../..')
const CHECK_MS = 10_000
const FAILS_TO_RESPAWN = 3
const RESPAWN_BACKOFF_MS = 120_000
const MIRROR_PULSE_MS = 30 * 60_000
const MIRROR_FIRST_MS = 45_000
const SNAPSHOT_PULSE_MS = 60 * 60_000
const SNAPSHOT_FIRST_MS = 120_000
const SNAPSHOT_KEEP = 24
const EVENTS_MAX = 50

const MIRROR_DIR = path.resolve(PROJECT_ROOT, '..', 'fabric-mirror.git') // מחוץ-לעץ-הפרויקט
const BACKUP_DIR = path.resolve(PROJECT_ROOT, '..', 'fabric-backups') // מחוץ-לעץ-הפרויקט
const DB_PATH = path.join(PROJECT_ROOT, 'db', 'custom.db')
const CRED_HELPER = path.join(PROJECT_ROOT, '.zscripts', 'git-credential-pat.sh')

const APP_URL = 'http://127.0.0.1:3000'
const HEARTBEAT_URL = 'http://127.0.0.1:3031/health'
const WITNESS_URL = 'http://127.0.0.1:3050/health'

interface WatchState {
  up: boolean
  fails: number
  restarts: number
  lastCheckAt: string | null
  lastResult: string | null
  lastRestartAt: string | null
}

interface MirrorState {
  exists: boolean
  lastUpdateAt: string | null
  lastResult: string | null
  updates: number
  mirrorHead: string | null
  synced: boolean | null
}

interface SnapshotState {
  count: number
  lastAt: string | null
  lastResult: string | null
  dir: string
}

interface Event {
  at: string
  kind: string
  msg: string
}

const watches: Record<'app' | 'heartbeat' | 'witness', WatchState> = {
  app: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null },
  heartbeat: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null },
  witness: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null },
}

const mirror: MirrorState = {
  exists: false,
  lastUpdateAt: null,
  lastResult: null,
  updates: 0,
  mirrorHead: null,
  synced: null,
}

const snapshots: SnapshotState = { count: 0, lastAt: null, lastResult: null, dir: BACKUP_DIR }
const events: Event[] = []
let ticks = 0
const startedAt = new Date().toISOString()

function log(msg: string): void {
  console.log(`[survival-keeper ${new Date().toISOString()}] ${msg}`)
}

function pushEvent(kind: string, msg: string): void {
  events.unshift({ at: new Date().toISOString(), kind, msg })
  if (events.length > EVENTS_MAX) events.length = EVENTS_MAX
}

// ── עזרי-גיט (spawnSync — פשוט, אין-ערימה) ────────────────────────────────
function git(args: string[], cwd?: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(['git', ...args], {
    cwd: cwd ?? PROJECT_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    ok: p.exitCode === 0,
    out: `${p.stdout ?? ''}${p.exitCode === 0 ? '' : '\n' + (p.stderr ?? '')}`.trim(),
  }
}

// ── משימה-1: זקיפה ──────────────────────────────────────────────────────────
async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

// האפליקציה: נצפית-בלבד (הזנקתה = סמכות-הלב, עורק-0)
async function watchApp(): Promise<void> {
  const w = watches.app
  w.lastCheckAt = new Date().toISOString()
  const up = await probe(`${APP_URL}/api/health`)
  w.up = up
  w.fails = up ? 0 : Math.min(w.fails + 1, 999)
  w.lastResult = up ? 'ok' : `down (${w.fails}) — ההזנקה-על-הלב (עורק-0)`
  if (!up) log(`אפליקציה לא-עונה (${w.fails}) — נצפית-בלבד; הלב אחראי-להזנקתה`)
}

// הלב-והעד: מעקב + החייאה-עצמית
async function watchService(name: 'heartbeat' | 'witness', url: string): Promise<void> {
  const w = watches[name]
  w.lastCheckAt = new Date().toISOString()
  const up = await probe(url)
  if (up) {
    if (!w.up) log(`${name} חזר-לחיים ✓`)
    w.up = true
    w.fails = 0
    w.lastResult = 'ok'
    return
  }
  w.up = false
  w.fails++
  w.lastResult = `down (${w.fails}/${FAILS_TO_RESPAWN})`
  if (w.fails < FAILS_TO_RESPAWN) return

  // הזנקה — עם-מנע-סערת-הזנקות
  if (w.lastRestartAt && Date.now() - new Date(w.lastRestartAt).getTime() < RESPAWN_BACKOFF_MS) {
    w.lastResult = `down — backoff-הזנקה (${Math.round((RESPAWN_BACKOFF_MS - (Date.now() - new Date(w.lastRestartAt).getTime())) / 1000)}s)`
    return
  }
  const dir = path.join(PROJECT_ROOT, 'mini-services', name === 'heartbeat' ? 'fabric-heartbeat' : 'chain-witness')
  try {
    const child = Bun.spawn(['bun', 'run', 'dev'], {
      cwd: dir,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    child.unref()
    w.restarts++
    w.lastRestartAt = new Date().toISOString()
    w.fails = 0
    w.lastResult = 'respawned — ממתין-לבריאות-בסבבים-הבאים (EADDRINUSE-אפשרי אם-זומבי-מחזיק-פורט)'
    log(`🚑 ${name} לא-ענה ${FAILS_TO_RESPAWN} סבבים — הוזנק מחדש (#${w.restarts})`)
    pushEvent('respawn', `${name} הוזנק מחדש (#${w.restarts})`)
  } catch (e) {
    w.lastResult = `spawn failed: ${e instanceof Error ? e.message : String(e)}`
    log(`🚨 כשל-הזנקת-${name} — ${w.lastResult}`)
    pushEvent('spawn-failed', `${name}: ${w.lastResult}`)
  }
}

// ── משימה-2: מראת-גיבוי-מקומית ─────────────────────────────────────────────
function originUrl(): string | null {
  const r = git(['remote', 'get-url', 'origin'])
  return r.ok ? r.out.split('\n')[0].trim() : null
}

function mirrorPulse(): void {
  try {
    if (!existsSync(MIRROR_DIR)) {
      const url = originUrl()
      if (!url) {
        mirror.lastResult = 'clone skipped: origin url לא-נקרא'
        return
      }
      log(`מראת-גיבוי: נוצרת clone --mirror (${MIRROR_DIR})`)
      const c = Bun.spawnSync(
        ['git', '-c', `credential.helper=${CRED_HELPER}`, 'clone', '--mirror', url, MIRROR_DIR],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      if (c.exitCode !== 0) {
        mirror.lastResult = `clone failed — כנות: ${`${c.stderr ?? ''}`.split('\n').filter(Boolean).slice(-1)[0] ?? '?'}`
        log(`מראת-גיבוי: clone נכשל — ${mirror.lastResult}`)
        return
      }
      pushEvent('mirror', 'מראת-גיבוי נולדה (clone --mirror)')
    }
    mirror.exists = true
    const u = Bun.spawnSync(
      ['git', '-C', MIRROR_DIR, '-c', `credential.helper=${CRED_HELPER}`, 'remote', 'update', '--prune'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    if (u.exitCode !== 0) {
      mirror.lastResult = `update failed — כנות: ${`${u.stderr ?? ''}`.split('\n').filter(Boolean).slice(-1)[0] ?? '?'}`
      log(`מראת-גיבוי: עדכון-נכשל — ${mirror.lastResult}`)
      return
    }
    mirror.updates++
    mirror.lastUpdateAt = new Date().toISOString()
    const head = git(['rev-parse', 'refs/heads/main'], MIRROR_DIR)
    const remoteMain = git(['rev-parse', 'origin/main'], PROJECT_ROOT)
    mirror.mirrorHead = head.ok ? head.out.slice(0, 8) : null
    mirror.synced = head.ok && remoteMain.ok ? head.out === remoteMain.out : null
    mirror.lastResult = `updated ✓ head ${mirror.mirrorHead ?? '?'} · synced:${mirror.synced}`
    log(`מראת-גיבוי: עודכנה ✓ (סה"כ ${mirror.updates}; head ${mirror.mirrorHead ?? '?'})`)
  } catch (e) {
    mirror.lastResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`מראת-גיבוי: כשל-כן — ${mirror.lastResult}`)
  }
}

// ── משימה-3: תמונות-db ──────────────────────────────────────────────────────
function snapshotPulse(): void {
  try {
    if (!existsSync(DB_PATH)) {
      snapshots.lastResult = 'db לא-קיים — דילוג-כן'
      return
    }
    if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const target = path.join(BACKUP_DIR, `db-${stamp}.db`)
    // עותק-עקבי: VACUUM INTO מחיבור-readonly (קורא-תמונה-אטומית וכותב-קובץ-חדש)
    // fallback כנה: העתקת-שלושת-הקבצים (db+wal+shm) — אם-המימוש-אינו-תומך.
    let method = 'vacuum-into'
    try {
      const db = new Database(DB_PATH, { readonly: true })
      db.run(`VACUUM INTO '${target}'`)
      db.close()
    } catch {
      method = 'file-copy'
      copyFileSync(DB_PATH, target)
      for (const suf of ['-wal', '-shm']) {
        try {
          copyFileSync(DB_PATH + suf, target + suf)
        } catch {
          /* וול-לא-קיים — תקין */
        }
      }
    }
    snapshots.lastAt = new Date().toISOString()
    snapshots.lastResult = `ok (${method})`

    // תחזוקה: השאר-24-אחרונות בלבד
    const files = readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.db'))
      .map((f) => ({ f, m: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
    for (const old of files.slice(SNAPSHOT_KEEP)) {
      rmSync(path.join(BACKUP_DIR, old.f), { force: true })
      try {
        rmSync(path.join(BACKUP_DIR, old.f) + '-wal', { force: true })
        rmSync(path.join(BACKUP_DIR, old.f) + '-shm', { force: true })
      } catch {
        /* כנות — אין-מה-למחוק */
      }
    }
    snapshots.count = Math.min(files.length + 1, SNAPSHOT_KEEP)
    log(`תמונת-db נשמרה ✓ ${path.basename(target)} (${method}; מלאי: ${snapshots.count})`)
  } catch (e) {
    snapshots.lastResult = `error: ${e instanceof Error ? e.message : String(e)}`
    log(`🚨 תמונת-db נכשלה — ${snapshots.lastResult}`)
    pushEvent('snapshot-failed', snapshots.lastResult)
  }
}

// ── שרת-הזקיפה (תצפית) ──────────────────────────────────────────────────────
Bun.serve({
  port: PORT,
  fetch() {
    return new Response(
      JSON.stringify(
        {
          ok: true,
          service: 'survival-keeper',
          port: PORT,
          projectRoot: PROJECT_ROOT,
          startedAt,
          uptimeMs: Date.now() - new Date(startedAt).getTime(),
          ticks,
          watches,
          mirror,
          snapshots,
          events,
        },
        null,
        2,
      ),
      { headers: { 'content-type': 'application/json' } },
    )
  },
})

async function check(): Promise<void> {
  ticks++
  await Promise.all([watchApp(), watchService('heartbeat', HEARTBEAT_URL), watchService('witness', WITNESS_URL)])
}

log(
  `הזקיפה חיה — מעקב כל ${CHECK_MS / 1000}s על אפליקציה/לב/עד (החייאה אחרי ${FAILS_TO_RESPAWN} כשלים, backoff ${RESPAWN_BACKOFF_MS / 1000}s); מראת-גיבוי כל ${MIRROR_PULSE_MS / 60_000} דק'; תמונות-db כל ${SNAPSHOT_PULSE_MS / 60_000} דק' (מלאי ${SNAPSHOT_KEEP}); דופק על :${PORT}`,
)

void check()
void mirrorPulse()
void snapshotPulse()
setInterval(() => void check(), CHECK_MS)
setTimeout(() => {
  void mirrorPulse()
  setInterval(() => void mirrorPulse(), MIRROR_PULSE_MS)
}, MIRROR_FIRST_MS)
setTimeout(() => {
  void snapshotPulse()
  setInterval(() => void snapshotPulse(), SNAPSHOT_PULSE_MS)
}, SNAPSHOT_FIRST_MS)
