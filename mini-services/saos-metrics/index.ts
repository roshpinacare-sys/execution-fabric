// Task-120: רילוד-היגיינה — אחרי-פעולות-git על קבצי-מצב: העתק-WAL/SHM מה-fd החי ואז שנה-תוכן-קובץ-זה (לא touch) לרילוד על inode חי.
// saos-metrics — איבר-המדידה (Task 102: החייאה)
// ═══════════════════════════════════════════════════════════════════════════
// הקוד-המקורי אבד במחיקת-סנדבוקס (המסד-הישן state/metrics.db קפוא מ-18.10 23:06 —
// נשמר-כראיה, אפס-מחיקה; המסד-החדש state/pulse.db). שיעור-ההישרדות: הקוד-עצמו
// חתום-עכשיו בגיט, והזקיפה (survival-keeper) משגיחה-עליו ומזניקה-אותו.
//
// תפקיד: התשובה-המדידה לשאלה "האם-הרשת חיה?" — לא-טענה, סדרת-זמן.
//   1. דגימה כל-60ש' של כל-האיברים: האפליקציה (:3000/api/metrics), הלב (:3031),
//      העד (:3050), הזקיפה (:3051). כל-דגימה שורה-חתומה-בזמן ב-pulse.db (WAL).
//   2. מהירות-תנועה: דלתות-מונים בין-דגימות (רישומים/שעה, השלמות/שעה,
//      ביצועי-לב/שעה, דחיפות-גיט/שעה) — ההוכחה-שהמערכת-זורמת, לא-רק-מאזינה.
//   3. סדרת-זמן לדשבורד: /series?minutes=N — דגימות-מדוללות לגרף-צמיחה.
//   4. מצב-איברים: /organs — תמונת-החיים-האחרונה של-כל-איבר.
//
// כנות: מונה-שמתאפס (התחדשות-שירות-נצפה) = דלתה-0-כן (לא-המצאה-צמיחה).
// אפס-סודות, נגזרת-מיקום-עצמית (import.meta.dir), אפס-נתיב-מילולי.

import path from 'node:path'
import { mkdirSync, existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'

const PORT = Number(process.env.METRICS_PORT ?? 3060)
const PROJECT_ROOT = path.resolve(import.meta.dir, '../..')
const STATE_DIR = path.join(import.meta.dir, 'state')
const DB_PATH = path.join(STATE_DIR, 'pulse.db')

const SAMPLE_MS = 60_000
const RETENTION_MS = 7 * 24 * 60 * 60_000 // שבוע — דגימה/דקה ≈ 10k שורות, זעיר

const APP_URL = 'http://127.0.0.1:3000'
const HEART_URL = 'http://127.0.0.1:3031/health'
const WITNESS_URL = 'http://127.0.0.1:3050/health'
const KEEPER_URL = 'http://127.0.0.1:3051/health'

interface OrganResult {
  name: string
  up: boolean
  error: string | null
  ms: number
  fields: Record<string, number | null>
}

interface SampleRow {
  id?: number
  at: string
  ledgerTotal: number
  ledgerDone: number
  ledgerFailed: number
  queueQueued: number
  queueRunning: number
  hbTicks: number
  hbPicked: number
  hbExecuted: number
  hbGitPulses: number
  hbGitPushes: number
  witnessTotal: number
  organsUp: number // bitmask: app=1, heart=2, witness=4, keeper=8
  organErrors: string | null
}

const startedAt = new Date().toISOString()
let ticks = 0
let lastError: string | null = null

function log(msg: string): void {
  console.log(`[saos-metrics ${new Date().toISOString()}] ${msg}`)
}

// ── מסד ──────────────────────────────────────────────────────────────────────
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
const db = new Database(DB_PATH, { create: true })
db.run('PRAGMA journal_mode = WAL')
db.run(`CREATE TABLE IF NOT EXISTS pulse_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  ledgerTotal INTEGER, ledgerDone INTEGER, ledgerFailed INTEGER,
  queueQueued INTEGER, queueRunning INTEGER,
  hbTicks INTEGER, hbPicked INTEGER, hbExecuted INTEGER, hbGitPulses INTEGER, hbGitPushes INTEGER,
  witnessTotal INTEGER,
  organsUp INTEGER,
  organErrors TEXT
)`)
db.run(`CREATE INDEX IF NOT EXISTS idx_pulse_at ON pulse_samples(at)`)

// ── דגימה ────────────────────────────────────────────────────────────────────
async function probeOrgan(
  name: string,
  url: string,
  pick: (j: Record<string, unknown>) => Record<string, number | null>,
): Promise<OrganResult> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: 'no-store' })
    const ms = Date.now() - t0
    if (!res.ok) return { name, up: false, error: `http ${res.status}`, ms, fields: {} }
    const j = (await res.json()) as Record<string, unknown>
    return { name, up: true, error: null, ms, fields: pick(j) }
  } catch (e) {
    return { name, up: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0, fields: {} }
  }
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

async function sampleOnce(): Promise<SampleRow> {
  const [app, heart, witness, keeper] = await Promise.all([
    probeOrgan('app', `${APP_URL}/api/metrics`, (j) => {
      const ledger = (j.ledger ?? {}) as Record<string, unknown>
      const queue = (j.queue ?? {}) as Record<string, unknown>
      return {
        ledgerTotal: num(ledger.total, -1),
        ledgerDone: num(ledger.done, -1),
        ledgerFailed: num(ledger.failed, -1),
        queueQueued: num(queue.queued, -1),
        queueRunning: num(queue.running, -1),
      }
    }),
    probeOrgan('heart', HEART_URL, (j) => ({
      hbTicks: num(j.ticks, -1),
      hbPicked: num(j.picked, -1),
      hbExecuted: num(j.executed, -1),
      hbGitPulses: num(j.gitPulses, -1),
      hbGitPushes: num(j.gitPushes, -1),
    })),
    probeOrgan('witness', WITNESS_URL, (j) => {
      const last = (j.last ?? {}) as Record<string, unknown>
      return { witnessTotal: num(last.total, -1) }
    }),
    probeOrgan('keeper', KEEPER_URL, () => ({})),
  ])

  const upOf = (o: OrganResult): boolean => o.up
  const organsUp =
    (upOf(app) ? 1 : 0) + (upOf(heart) ? 2 : 0) + (upOf(witness) ? 4 : 0) + (upOf(keeper) ? 8 : 0)
  const errors = [app, heart, witness, keeper].filter((o) => o.error)
  const row: SampleRow = {
    at: new Date().toISOString(),
    ledgerTotal: app.fields.ledgerTotal ?? -1,
    ledgerDone: app.fields.ledgerDone ?? -1,
    ledgerFailed: app.fields.ledgerFailed ?? -1,
    queueQueued: app.fields.queueQueued ?? -1,
    queueRunning: app.fields.queueRunning ?? -1,
    hbTicks: heart.fields.hbTicks ?? -1,
    hbPicked: heart.fields.hbPicked ?? -1,
    hbExecuted: heart.fields.hbExecuted ?? -1,
    hbGitPulses: heart.fields.hbGitPulses ?? -1,
    hbGitPushes: heart.fields.hbGitPushes ?? -1,
    witnessTotal: witness.fields.witnessTotal ?? -1,
    organsUp,
    organErrors: errors.length ? JSON.stringify(errors.map((e) => ({ name: e.name, error: e.error }))) : null,
  }
  db.run(
    `INSERT INTO pulse_samples (at, ledgerTotal, ledgerDone, ledgerFailed, queueQueued, queueRunning,
      hbTicks, hbPicked, hbExecuted, hbGitPulses, hbGitPushes, witnessTotal, organsUp, organErrors)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.at, row.ledgerTotal, row.ledgerDone, row.ledgerFailed, row.queueQueued, row.queueRunning,
      row.hbTicks, row.hbPicked, row.hbExecuted, row.hbGitPulses, row.hbGitPushes, row.witnessTotal,
      row.organsUp, row.organErrors],
  )
  return row
}

// ── מהירות-תנועה (דלתות-מונים כנות) ─────────────────────────────────────────
interface Velocity {
  windowMinutes: number
  ledgerEntries: number
  completions: number
  heartExecutions: number
  gitPushes: number
  lastLedgerAt: string | null
  secondsSinceLastLedger: number | null
  counterResets: number // כנות: כמה-מונים אופסו (התחדשות-שירות) בחלון
}

// דלתה-כנה: אם-המונה-קטן (התחדשות) — 0 וספירת-איפוס
function delta(bigger: number, smaller: number, resets: { n: number }): number {
  if (bigger < 0 || smaller < 0) return 0
  if (bigger < smaller) {
    resets.n++
    return 0
  }
  return bigger - smaller
}

function velocity(windowMinutes: number): Velocity {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString()
  const rows = db
    .query(`SELECT * FROM pulse_samples WHERE at >= ? ORDER BY at ASC`)
    .all(since) as SampleRow[]
  const resets = { n: 0 }
  if (rows.length < 2) {
    const lastLedger = db
      .query(`SELECT at FROM pulse_samples WHERE ledgerTotal > 0 ORDER BY at DESC LIMIT 1`)
      .get() as { at: string } | null
    return {
      windowMinutes,
      ledgerEntries: 0,
      completions: 0,
      heartExecutions: 0,
      gitPushes: 0,
      lastLedgerAt: lastLedger?.at ?? null,
      secondsSinceLastLedger: lastLedger ? (Date.now() - new Date(lastLedger.at).getTime()) / 1000 : null,
      counterResets: resets.n,
    }
  }
  const first = rows[0]!
  const last = rows[rows.length - 1]!
  const ledgerEntries = delta(last.ledgerTotal, first.ledgerTotal, resets)
  const completions = delta(last.ledgerDone, first.ledgerDone, resets)
  const heartExecutions = delta(last.hbExecuted, first.hbExecuted, resets)
  const gitPushes = delta(last.hbGitPushes, first.hbGitPushes, resets)
  return {
    windowMinutes,
    ledgerEntries,
    completions,
    heartExecutions,
    gitPushes,
    lastLedgerAt: last.at,
    secondsSinceLastLedger: (Date.now() - new Date(last.at).getTime()) / 1000,
    counterResets: resets.n,
  }
}

// ── שרת ──────────────────────────────────────────────────────────────────────
const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    try {
      if (url.pathname === '/health' || url.pathname === '/') {
        const count = (db.query(`SELECT COUNT(*) AS c FROM pulse_samples`).get() as { c: number }).c
        return json({
          ok: true,
          service: 'saos-metrics',
          port: PORT,
          startedAt,
          uptimeMs: Date.now() - new Date(startedAt).getTime(),
          ticks,
          samples: count,
          dbPath: 'state/pulse.db',
          sampleMs: SAMPLE_MS,
          lastError,
        })
      }
      if (url.pathname === '/now') {
        const last = db.query(`SELECT * FROM pulse_samples ORDER BY at DESC LIMIT 1`).get() as SampleRow | null
        return json({
          ok: true,
          at: new Date().toISOString(),
          last: last,
          velocity1h: velocity(60),
          velocity24h: velocity(24 * 60),
        })
      }
      if (url.pathname === '/series') {
        const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes') ?? 180), 10), 7 * 24 * 60)
        const since = new Date(Date.now() - minutes * 60_000).toISOString()
        const rows = db
          .query(`SELECT * FROM pulse_samples WHERE at >= ? ORDER BY at ASC`)
          .all(since) as SampleRow[]
        // דילול כן: אם-יותר-מ-120-נקודות — קפיצות-שוות
        const max = 120
        const step = rows.length > max ? Math.ceil(rows.length / max) : 1
        const series = rows.filter((_, i) => i % step === 0 || i === rows.length - 1)
        return json({ ok: true, minutes, count: rows.length, decimated: series.length, series })
      }
      if (url.pathname === '/organs') {
        const last = db.query(`SELECT * FROM pulse_samples ORDER BY at DESC LIMIT 1`).get() as SampleRow | null
        const mask = last?.organsUp ?? 0
        const errors = last?.organErrors ? (JSON.parse(last.organErrors) as { name: string; error: string }[]) : []
        return json({
          ok: true,
          at: last?.at ?? null,
          organs: [
            { name: 'app', up: (mask & 1) !== 0, error: errors.find((e) => e.name === 'app')?.error ?? null },
            { name: 'heart', up: (mask & 2) !== 0, error: errors.find((e) => e.name === 'heart')?.error ?? null },
            { name: 'witness', up: (mask & 4) !== 0, error: errors.find((e) => e.name === 'witness')?.error ?? null },
            { name: 'keeper', up: (mask & 8) !== 0, error: errors.find((e) => e.name === 'keeper')?.error ?? null },
          ],
        })
      }
      return json({ ok: false, error: 'not-found' }, 404)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      return json({ ok: false, error: lastError }, 500)
    }
  },
})

// ── לולאת-הדגימה ─────────────────────────────────────────────────────────────
async function loop(): Promise<void> {
  ticks++
  try {
    const row = await sampleOnce()
    lastError = null
    if (ticks % 15 === 1)
      log(`דגימה #${ticks}: ledger=${row.ledgerTotal} done=${row.ledgerDone} queue=${row.queueQueued}/${row.queueRunning} organs=${row.organsUp.toString(2).padStart(4, '0')}`)
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    log(`כשל-דגימה-כן: ${lastError}`)
  }
  // תחזוקה: שמירת-שבוע
  try {
    db.run(`DELETE FROM pulse_samples WHERE at < ?`, [new Date(Date.now() - RETENTION_MS).toISOString()])
  } catch {
    /* כנות — תחזוקה-לא-קריטית */
  }
}

log(`איבר-המדידה חי — דגימה כל ${SAMPLE_MS / 1000}ש' של אפליקציה/לב/עד/זקיפה; מסד state/pulse.db (WAL); שמירת-7ימים; דופק על :${PORT}`)
void loop()
setInterval(() => void loop(), SAMPLE_MS)
