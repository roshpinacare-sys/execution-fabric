// survival-keeper — הזקיפה (Task 71 + Task 72)
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
// Task 72 — מצב-עמיד-להתחדשות: לקח-חי (הריצה-הראשונה): bun --hot עלול-להתחדש-בגלל
// פעימות-הגיט-של-הלב — ואז-המונים/האירועים/ה-backoff מתאפסים (הפסד-ראיות!). מעתה:
// כל-המצב-החי נשמר-ב-state-file מחוץ-לעץ-הפרויקט, נטען-באתחול, ונשמר-בשינוי.
//
// Task 72 — לקח-חי-שני (תרגיל-ההרג): bun --hot גרם-פיצול-מוח — הטיימרים-הישנים-המשיכו-
// לחיות-על-המצב-הישן (והחיו-באמת!), בזמן-שהמודול-החדש-הגיש-מצב-קפוא-דרך-השרת.
// התיקון-מהשורש: הזקיפה-רצה-**בלי---hot** — תהליך-יציב-אחד, אפס-פיצול. עדכון-קוד
// = הזנקה-מחדש-יזומה (פרוטוקול-התחייה) — ואפילו-שם-המצב-עמיד-על-הדיסק.
//
// כנות: מי-משגיח-על-הזקיפה? יציבות-התהליך-העצמית (ללא-התחדשות-חמה — אפס-פיצול) + כלב-השמיר
// של הלב + badge-חי לבעלים ב-census + כלי-'keeper' ב-selftest (Task 72 — עדות-חתומה
// בשרשרת-כל-30דק'). הזקיפה אינה-אלוהות — היא-שכבה.
// אף-סוד לא נוגע/נדפס כאן. אף-כתיבה-לגיט לא נעשית כאן (רק-קריאה-למראה).

import path from 'node:path'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
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
const FLUSH_MS = 60_000 // שמירת-מצב-תקופתית (וגם-בכל-אירוע-משמעותי)

const MIRROR_DIR = path.resolve(PROJECT_ROOT, '..', 'fabric-mirror.git') // מחוץ-לעץ-הפרויקט
const BACKUP_DIR = path.resolve(PROJECT_ROOT, '..', 'fabric-backups') // מחוץ-לעץ-הפרויקט
const STATE_PATH = path.resolve(PROJECT_ROOT, '..', 'fabric-keeper-state.json') // מחוץ-לעץ-הפרויקט
const DB_PATH = path.join(PROJECT_ROOT, 'db', 'custom.db')
const CRED_HELPER = path.join(PROJECT_ROOT, '.zscripts', 'git-credential-pat.sh')

const APP_URL = 'http://127.0.0.1:3000'
const HEARTBEAT_URL = 'http://127.0.0.1:3031/health'
const WITNESS_URL = 'http://127.0.0.1:3050/health'
const METRICS_URL = 'http://127.0.0.1:3060/health' // Task 102 — איבר-המדידה (הוחזר מהמתים)
const GRID_URL = 'http://127.0.0.1:3070/health' // Task 105 — איבר-הגריד (יד-המסחר-של-הגוף)
const DEX_URL = 'http://127.0.0.1:3010/saos-dex/api/dex/state' // Task 106 — הדקס-הריבוני (השוק-שלנו)
const ARB_URL = 'http://127.0.0.1:3071/health' // Task 106 — איבר-השוק-החריף (גריד+ארב על הדקס)
const COUNCIL_URL = 'http://127.0.0.1:3072/health' // Task 107 — מועצת-השולחן (AutoHedge+agency-agents מותאם)
const VAULT_GUARDIAN_URL = 'http://127.0.0.1:3080/health' // T-111 — שומר-הכספת (ריבונות-מפתחות: census + שחזור-אוטומטי-מהגיט)
const WALLET_URL = 'http://127.0.0.1:3085/health' // Task-134 — HSM-החתימה (Saosmartwallet-זמן-ריצה: כספת-AES-256-GCM + חתימה-אטומה)
const ARCHITECT_URL = 'http://127.0.0.1:3086/health' // Task-135 — הארכיטקט-הריבוני (ביקורת→החלטה→ריפוי→חתימה)

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

const watches: Record<'app' | 'heartbeat' | 'witness' | 'metrics' | 'grid' | 'dex' | 'arb' | 'council' | 'vault-guardian' | 'wallet' | 'architect', WatchState> = {
  app: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null },
  heartbeat: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null },
  witness: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null },
  metrics: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task 102
  grid: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task 105
  dex: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task 106
  arb: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task 106
  council: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task 107
  'vault-guardian': { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // T-111
  wallet: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task-134 — HSM
  architect: { up: false, fails: 0, restarts: 0, lastCheckAt: null, lastResult: null, lastRestartAt: null }, // Task-135 — הארכיטקט
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
let events: Event[] = []
let ticks = 0
let lastTickAt: string | null = null
const startedAt = new Date().toISOString()

// ── עמידות-מצב (Task 72): טעינה-באתחול, שמירה-בשינוי ──────────────────────
function loadState(): void {
  try {
    if (!existsSync(STATE_PATH)) return
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as {
      ticks?: number
      watches?: Record<string, Partial<WatchState>>
      mirror?: Partial<MirrorState>
      snapshots?: Partial<SnapshotState>
      events?: Event[]
    }
    if (typeof s.ticks === 'number') ticks = s.ticks
    for (const key of ['app', 'heartbeat', 'witness', 'metrics', 'grid', 'dex', 'arb', 'council', 'vault-guardian', 'wallet', 'architect'] as const) {
      const p = s.watches?.[key]
      if (p) Object.assign(watches[key], p, { up: false, fails: 0 }) // רעננות-חיים-מתחילה-מאפס; הראיות-נשמרות
    }
    Object.assign(mirror, s.mirror ?? {})
    Object.assign(snapshots, s.snapshots ?? {}, { dir: BACKUP_DIR })
    if (Array.isArray(s.events)) events = s.events.slice(0, EVENTS_MAX)
    log(`מצב-נטען מהדיסק: ticks=${ticks}, החייאות app/לב/עד=${watches.app.restarts}/${watches.heartbeat.restarts}/${watches.witness.restarts}, אירועים=${events.length}`)
  } catch (e) {
    log(`כשל-טעינת-מצב (ממשיך-ריק-כן): ${e instanceof Error ? e.message : String(e)}`)
  }
}

let dirty = false
function markDirty(): void {
  dirty = true
}

function flushState(): void {
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({ savedAt: new Date().toISOString(), ticks, watches, mirror, snapshots, events }, null, 1),
    )
    dirty = false
  } catch (e) {
    log(`כשל-שמירת-מצב (כן): ${e instanceof Error ? e.message : String(e)}`)
  }
}

function log(msg: string): void {
  console.log(`[survival-keeper ${new Date().toISOString()}] ${msg}`)
}

function pushEvent(kind: string, msg: string): void {
  events.unshift({ at: new Date().toISOString(), kind, msg })
  if (events.length > EVENTS_MAX) events.length = EVENTS_MAX
  markDirty()
}

// ── Task-114: חוק-הקמה-מחדש-עצמית (self-provision from git) ────────────────
// לקח-בדם (22:26Z): אתחול-מכונה-מחק-את-repos/ ואת-node_modules — הזקיפה-ניסתה-
// להזניק-את-הדקס-103-פעמים-וכשלה-ב-ENOENT-מטעה ("/bin/sh" שהוא-בעצם-cwd-חסר),
// והגריד-קרס-בכל-אתחול-על-ה-binding-ה-native. מעתה: לפני-כל-זינוק, אם-האיבר
// חסר-מהעץ — הזקיפה-**מקימה-אותו-מהגיט-בעצמה**. אסור-שתהיה-מצב-בו-איבר-מורד
// וממתין-לבן-אדם. המקור-המכונן-הוא-גיט; ההקמה-אוטונומית-לגמרי.
// Task-124 — חוק-אפס-החסמות: Bun.spawnSync חסם-את-הת'רד-היחיד-והקפיא-את-הזקיפה
// (נמדד-חי 09:04→09:15 2026-10-22: טיקים-קופאים בזמן-spawnSync-של-עדכון-מראת-גיט
// על-רשת-תקועה; Bun מוסיף-טיימאוט-אך-pipe-של-נכד-מחזיק-אותו-תקוע-לנצח).
// מעתה: הרצה-אסינכרונית-תחומה — SIGKILL בדדליין, קטיעת-פלט אם-נכד מחזיק-pipe,
// והלולאה-ממשיכה-למדוד תמיד. אסור-שתהיה-קריאה-חוסמת-בזקיפה-הריבונית.
async function runBounded(cmd: string[], cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  let proc: ReturnType<typeof Bun.spawn> | null = null
  try {
    proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const killTimer = setTimeout(() => {
      try {
        proc?.kill(9)
      } catch {
        /* כבר-מת */
      }
    }, timeoutMs)
    try {
      const collect = (async () => {
        const [so, se] = await Promise.all([
          new Response(proc!.stdout).text().catch(() => ''),
          new Response(proc!.stderr).text().catch(() => ''),
        ])
        return `${so}\n${se}`.trim()
      })()
      const exited = proc!.exited.then((c) => c)
      const code = await Promise.race([
        exited,
        new Promise<number>((r) => setTimeout(() => r(-999), timeoutMs + 5_000)),
      ])
      const out = await Promise.race([
        collect,
        new Promise<string>((r) => setTimeout(() => r('[פלט-נחתך — נכד-מחזיק-pipe]'), timeoutMs + 10_000)),
      ])
      return { ok: code === 0, out: code === 0 ? out : `${out}\n[exit ${code}]`.trim() }
    } finally {
      clearTimeout(killTimer)
    }
  } catch (e) {
    return { ok: false, out: `spawn-שגיאה: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function shellOut(cmd: string, cwd: string, timeoutMs = 300_000): Promise<{ ok: boolean; out: string }> {
  return runBounded(['/bin/sh', '-c', cmd], cwd, timeoutMs)
}

async function provisionOrgan(name: string, dir: string): Promise<{ provisioned: boolean; detail: string }> {
  const steps: string[] = []
  // א'-התיקיה-עצמה נעדרת → שיבוט-מה-origin-של-העץ (dex חי-בגיט נפרד)
  if (!existsSync(dir)) {
    const origin = await git(['remote', 'get-url', 'origin'])
    if (!origin.ok) return { provisioned: false, detail: 'origin url לא-נקרא' }
    const rel = path.relative(PROJECT_ROOT, dir)
    // קינון-רק-לאיבר-שהוא-ריפו-נפרד (dex); שאר-האיברים-חיים-בתוך-העץ-ולא-יגיעו-לכאן
    const c = await shellOut(`git clone --depth 1 '${origin.out.split('\n')[0].trim()}' '${rel}' 2>&1`, PROJECT_ROOT, 300_000)
    if (!c.ok) return { provisioned: false, detail: `clone נכשל: ${c.out.split('\n').slice(-1)[0] ?? '?'}` }
    steps.push('clone ✓')
  }
  // ב'-תלויות חסרות → התקנה-עצמית (אתחול-מכונה-מוחק-node_modules)
  if (!existsSync(path.join(dir, 'node_modules'))) {
    const i = await shellOut('bun install 2>&1', dir, 300_000)
    if (!i.ok) return { provisioned: false, detail: `bun install נכשל: ${i.out.split('\n').slice(-1)[0] ?? '?'}` }
    steps.push('bun install ✓')
  }
  // ג'-סכמה: איבר-עם-prisma חייב-סנכרון-סכמה לפני-עלייה.
  // Task-131: הדקס-המחודר (mini-services/saos-dex) מנהל-סכמה-עצמית (bun:sqlite CREATE IF
  // NOT EXISTS) — אין-prisma ואין-db:push; כפיה-הייתה-מכשילה-את-הזינוק בכל-מחזור.
  if (name === 'dex' && existsSync(path.join(dir, 'prisma', 'schema.prisma'))) {
    const hasDb = existsSync(path.join(dir, 'db', 'dex.db'))
    // Task-126 (שיעור-דם-חי 12:46+12:56): DATABASE_URL-יורש-מהפלטפורמה (מצביע-על-db-הראשי!)
    // גובר-על-.env-וגרם-לשני-אירועי-השחתה-של-סכמת-הפנקס. דריסה-מוטמעת-בשורת-הפקודה
    // מנצחת-כל-ירושה — ה-dex ידחוף-רק-אל-dex.db-שלו, לעולם-לא-אל-הפנקס-הראשי.
    const p = await shellOut(`DATABASE_URL='file:${dir}/db/dex.db' bun run db:push 2>&1`, dir, 300_000)
    if (!p.ok) return { provisioned: false, detail: `db:push נכשל: ${p.out.split('\n').slice(-1)[0] ?? '?'}` }
    steps.push(hasDb ? 'db:push ✓' : 'db:push (db-חדש) ✓')
  }
  return { provisioned: true, detail: steps.join(' · ') || 'היה-שלם' }
}

// ── עזרי-גיט (אסינכרוני-תחום — Task-124: spawnSync-ללא-טיימאוט היה-קפיאה-צפויה) ──
async function git(args: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  return runBounded(['git', ...args], cwd ?? PROJECT_ROOT, 30_000)
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

// הלב, העד ואיבר-המדידה: מעקב + החייאה-עצמית
async function watchService(
  name: 'heartbeat' | 'witness' | 'metrics' | 'grid' | 'dex' | 'arb' | 'council' | 'vault-guardian',
  url: string,
): Promise<void> {
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
  const dirName =
    name === 'heartbeat' ? 'fabric-heartbeat'
    : name === 'metrics' ? 'saos-metrics'
    : name === 'grid' ? 'saos-grid' // Task 105
    : name === 'dex' ? 'saos-dex' // Task-131 — הדקס-הריבוני כאיבר-מהשורה בעץ-הנצחי (לקח-הדם: ה-clone-המקונן repos/saos-dex אבד-באתחול — מימושו מעולם לא היה בגיט; מעתה mini-services/saos-dex מוגן-פעימת-גיט)
    : name === 'arb' ? 'saos-arb' // Task 106 — איבר-השוק-החריף
    : name === 'council' ? 'saos-council' // Task 107 — מועצת-השולחן
    : name === 'vault-guardian' ? 'vault-guardian' // T-111 — שומר-הכספת
    : name === 'wallet' ? 'saos-wallet' // Task-134 — HSM-החתימה (Saosmartwallet-זמן-ריצה)
    : name === 'architect' ? 'saos-architect' // Task-135 — הארכיטקט-הריבוני
    : 'chain-witness'
  const dir = path.isAbsolute(dirName) ? dirName : path.join(PROJECT_ROOT, 'mini-services', dirName)
  try {
    // Task-114 — חוק-הקמה-מחדש-עצמית: איבר-חסר-מהעץ (תיקיה/node_modules/db) מוקם-מהגיט-
    // לפני-הזינוק. לעולם-לא 'spawn-נכשל-וממתינים' — הריבונות-מקימה-את-עצמה.
    const prov = await provisionOrgan(name, dir)
    if (!prov.provisioned) {
      w.lastResult = `provision failed: ${prov.detail}`
      log(`🚨 הקמת-${name}-מהגיט-נכשלה — ${prov.detail}`)
      pushEvent('provision-failed', `${name}: ${prov.detail}`)
      return
    }
    if (prov.detail && prov.detail !== 'היה-שלם') {
      log(`🛠 ${name} הוקם-מהגיט (${prov.detail}) — לפני-זינוק`)
      pushEvent('provisioned', `${name}: ${prov.detail}`)
    }
    // לקח-חי (Task 106): spawn עם 'bun' רק-מסתמך-על-PATH-של-ההורה (ENOENT נמדד);
    // וגם posix_spawn-ישיר-של-הבינארי-נכשל-ENOENT-מהתהליך-הזה (נמדד-חי) —
    // מעטפת-/bin/sh פותרת (שלוש-שכבות-ניסיון-מתועדות: יחסי → מוחלט → מעטפת).
    // Task-131 (לקח-הדם 15:28): הדקס-המחודר הוא-איבר-bun-פשוט (mini-services/saos-dex,
    // פורט-3010 מקודד-בתוכו) — זינוק-גנרי כמו-כל-איבר; אין-עוד-next/clone/פורט-מיוחד.
    const child = Bun.spawn(['/bin/sh', '-c', `cd '${dir}' && exec /usr/local/bin/bun run dev`], {
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
async function originUrl(): Promise<string | null> {
  const r = await git(['remote', 'get-url', 'origin'])
  return r.ok ? r.out.split('\n')[0].trim() : null
}

async function mirrorPulse(): Promise<void> {
  try {
    if (!existsSync(MIRROR_DIR)) {
      const url = await originUrl()
      if (!url) {
        mirror.lastResult = 'clone skipped: origin url לא-נקרא'
        return
      }
      log(`מראת-גיבוי: נוצרת clone --mirror (${MIRROR_DIR})`)
      // Task-124: אסינכרוני-תחום — spawnSync-ללא-טיימאוט על-רשת היה-קפיאת-הזקיפה (נמדד-חי)
      const c = await runBounded(
        ['git', '-c', `credential.helper=${CRED_HELPER}`, 'clone', '--mirror', url, MIRROR_DIR],
        PROJECT_ROOT,
        300_000,
      )
      if (!c.ok) {
        mirror.lastResult = `clone failed — כנות: ${`${c.out}`.split('\n').filter(Boolean).slice(-1)[0] ?? '?'}`
        log(`מראת-גיבוי: clone נכשל — ${mirror.lastResult}`)
        return
      }
      pushEvent('mirror', 'מראת-גיבוי נולדה (clone --mirror)')
    }
    mirror.exists = true
    const u = await runBounded(
      ['git', '-C', MIRROR_DIR, '-c', `credential.helper=${CRED_HELPER}`, 'remote', 'update', '--prune'],
      PROJECT_ROOT,
      120_000,
    )
    if (!u.ok) {
      mirror.lastResult = `update failed — כנות: ${`${u.out}`.split('\n').filter(Boolean).slice(-1)[0] ?? '?'}`
      log(`מראת-גיבוי: עדכון-נכשל — ${mirror.lastResult}`)
      return
    }
    mirror.updates++
    mirror.lastUpdateAt = new Date().toISOString()
    const head = await git(['rev-parse', 'refs/heads/main'], MIRROR_DIR)
    const remoteMain = await git(['rev-parse', 'origin/main'], PROJECT_ROOT)
    mirror.mirrorHead = head.ok ? head.out.slice(0, 8) : null
    mirror.synced = head.ok && remoteMain.ok ? head.out === remoteMain.out : null
    mirror.lastResult = `updated ✓ head ${mirror.mirrorHead ?? '?'} · synced:${mirror.synced}`
    log(`מראת-גיבוי: עודכנה ✓ (סה"כ ${mirror.updates}; head ${mirror.mirrorHead ?? '?'})`)
    markDirty()
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
    const dbFiles = () =>
      readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('db-') && f.endsWith('.db'))
        .map((f) => ({ f, m: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
    for (const old of dbFiles().slice(SNAPSHOT_KEEP)) {
      rmSync(path.join(BACKUP_DIR, old.f), { force: true })
      try {
        rmSync(path.join(BACKUP_DIR, old.f) + '-wal', { force: true })
        rmSync(path.join(BACKUP_DIR, old.f) + '-shm', { force: true })
      } catch {
        /* כנות — אין-מה-למחוק */
      }
    }
    snapshots.count = dbFiles().length
    log(`תמונת-db נשמרה ✓ ${path.basename(target)} (${method}; מלאי: ${snapshots.count})`)
    markDirty()
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
          lastTickAt, // Task-124: טריות-טיק נמדדת — אם-הטיק-ישן-המשטח-יראה-זאת-בכנות
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
  lastTickAt = new Date().toISOString() // Task-124: נראות-כנה — משטח-ההוכחה יוכל למדוד טריות-טיק
  await Promise.all([
    watchApp(),
    watchService('heartbeat', HEARTBEAT_URL),
    watchService('witness', WITNESS_URL),
    watchService('metrics', METRICS_URL), // Task 102 — המדיד נשמר-כמו-כולם
    watchService('grid', GRID_URL), // Task 105 — הגריד נשמר-כמו-כולם
    watchService('dex', DEX_URL), // Task 106 — השוק-שלנו נשמר-כמו-כולם
    watchService('arb', ARB_URL), // Task 106 — השוק-החריף נשמר-כמו-כולם
    watchService('council', COUNCIL_URL), // Task 107 — המועצה נשמרת-כמו-כולם
    watchService('vault-guardian', VAULT_GUARDIAN_URL), // T-111 — שומר-הכספת נשמר-כמו-כולם
    watchService('wallet', WALLET_URL), // Task-134 — HSM-החתימה נשמר-כמו-כולם
    watchService('architect', ARCHITECT_URL), // Task-135 — הארכיטקט-הריבוני נשמר-כמו-כולם
  ])
}

// ── אתחול ────────────────────────────────────────────────────────────────────
loadState()
log(
  `הזקיפה חיה — מעקב כל ${CHECK_MS / 1000}s על אפליקציה/לב/עד/מדיד/גריד/דקס/ארב (החייאה אחרי ${FAILS_TO_RESPAWN} כשלים, backoff ${RESPAWN_BACKOFF_MS / 1000}s); מראת-גיבוי כל ${MIRROR_PULSE_MS / 60_000} דק'; תמונות-db כל ${SNAPSHOT_PULSE_MS / 60_000} דק' (מלאי ${SNAPSHOT_KEEP}); מצב-עמיד: ${STATE_PATH}; דופק על :${PORT}`,
)

void check()
// פעימות-אתחול מגובלות-ברעננות (Task 72): אתחול-מחדש לא יזרוק-תמונה/עדכון-מראה
// אם-הקודמת-טרייה — אפס-ספאם-אתחול, המרווחים-הקבועים-ממשיכים-לתזמן.
const mirrorStale =
  !mirror.lastUpdateAt || Date.now() - new Date(mirror.lastUpdateAt).getTime() > MIRROR_PULSE_MS - 5 * 60_000
const snapStale =
  !snapshots.lastAt || Date.now() - new Date(snapshots.lastAt).getTime() > SNAPSHOT_PULSE_MS - 5 * 60_000
if (mirrorStale) void mirrorPulse()
if (snapStale) void snapshotPulse()

setInterval(() => void check(), CHECK_MS)
setTimeout(() => {
  void mirrorPulse()
  setInterval(() => void mirrorPulse(), MIRROR_PULSE_MS)
}, MIRROR_FIRST_MS)
setTimeout(() => {
  void snapshotPulse()
  setInterval(() => void snapshotPulse(), SNAPSHOT_PULSE_MS)
}, SNAPSHOT_FIRST_MS)
setInterval(() => {
  if (dirty) flushState()
}, FLUSH_MS)
setInterval(flushState, 15 * 60_000) // עיגון-תקופתי-גם-בלי-dirty (אחריות-עמידות)
