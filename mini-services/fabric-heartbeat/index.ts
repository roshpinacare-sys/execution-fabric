// fabric-heartbeat — עורק-החיים של רשת-הביצוע (Task 25 + Task 26)
//
// שלושה עורקים, שלושתם עצמאיים-לגמרי בדפדפן:
//   עורק-א: לולאת-tick כל 5 שניות → POST /api/worker/tick — הרשת קולטת-ומבצעת
//            משימות-QUEUED לבד (claim אטומי הוא קו-ההגנה מול עובד-הדפדפן).
//   עורק-ב: פעימת-גיט כל 15 דק' (וגם 90 שניות אחרי-הזנקה) — לפי RUNBOOK ריפו-האם:
//            pull-rebase → אם-יש-שינויים → leak-scan (חסם-כנה) → commit → push.
//            "הגיט-הוא-הקיום; הסנדבוקס-הוא-רק-זוג-ידיים."
//   עורק-ג (Task 26 + Task 28): פעימת-התפתחות כל 10 דק' → POST /api/evolution (auto) — הרשת מחליטה
//            בעצמה: ממצא-HIGH לא-מטופל מביקורת-עצמית → למידה; אחרת → הצעה-עצמית. ירי-LLM אמיתי.
//            תקציב-שעתי 6/שעה נאכף שרת-צד (429 = דילוג-כן) — הקצב-קושר בדיוק.
//   עורק-0 (Task 26): שומר-האפליקציה — בדיקת-בריאות כל 15 שניות; 3 כשלים-רצופים
//            = הזנקת-האפליקציה מחדש מבן-עץ-הלב (העץ-המתמיד). הרשת מרפאת-את-עצמה.
//   עורק-ב שדרוג (Task 27): קונפליקט-db ב-pull-rebase — פתרון-עצמי מוכח-שרשרת:
//            אם-db/custom.db בלבד-בקונפליקט והשרשרת-המקומית על-קבוצה של הרחוקה
//            (ראש-הרחוק ∈ שרשרת-מקומית && ספירה-מקומית ≥ רחוקה) → קח-מקומי והמשך.
//            אחרת — abort כנה. אף-פתרון-אוטומטי על קבצי-קוד — רק על ה-db עם-הוכחת-הכלה.
//
// דיסציפלינה: אף סוד לא נוגע/נדפס כאן (ה-credential-helper קורא את קובץ-הסמכות
// בזמן-ריצה); אין-force-push; כשל-סריקת-דליפות = אין-push (כנות); כל-כשל נרשם-וממשיך.

import { existsSync, writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'

const APP_URL = process.env.FABRIC_APP_URL ?? 'http://127.0.0.1:3000'
const PORT = Number(process.env.FABRIC_HEARTBEAT_PORT ?? 3031)
// נגזרת-מיקום-עצמי (mini-services/fabric-heartbeat → שורש-הפרויקט) — אפס-נתיב-מילולי (חסם-הדליפות)
const PROJECT_DIR = process.env.FABRIC_PROJECT_DIR ?? path.resolve(import.meta.dir, '../..')
const TICK_MS = 5_000
const GIT_PULSE_MS = 15 * 60_000
const GIT_PULSE_FIRST_MS = 90_000
const EVOLUTION_PULSE_MS = 10 * 60_000 // Task 28: 20→10 דק' — "יותר גבוה" (התקציב השעתי 6 קושר בדיוק)
const EVOLUTION_PULSE_FIRST_MS = 120_000
const APP_GUARD_MS = 15_000
const APP_GUARD_FAILS_TO_RESTART = 3

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
  evolutionPulses: number
  evolutionQueued: number
  lastEvolutionAt: string | null
  lastEvolutionResult: string | null
  appRestarts: number
  lastAppGuardAt: string | null
  lastAppGuardResult: string | null
  dbFileReplaced: number
  lastReconnectResult: string | null
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
  evolutionPulses: 0,
  evolutionQueued: 0,
  lastEvolutionAt: null,
  lastEvolutionResult: null,
  appRestarts: 0,
  lastAppGuardAt: null,
  lastAppGuardResult: null,
  dbFileReplaced: 0,
  lastReconnectResult: null,
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
    const res = await fetch(`${APP_URL}/api/worker/tick`, {
      method: 'POST',
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) {
      state.lastTickError = `HTTP ${res.status}`
      return
    }
    const d = (await res.json()) as { picked?: number; executed?: boolean; status?: string }
    state.lastTickError = null
    if (d.picked) {
      state.picked++
      log(`tick: משימה נקלטה → מבצע... (סה"כ נקלטו ${state.picked})`)
      if (d.executed) state.executed++
      log(`tick: הסתיים status=${d.status ?? '?'} (בוצעו בהצלחה: ${state.executed})`)
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
  let pull = git(['pull', '--rebase', 'origin', 'main'])
  if (!pull.ok) {
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

  if (!dirty) {
    state.lastGitPulseResult = 'clean — אין-שינויים לדחוף'
    return
  }

  const push = git(['push', 'origin', 'main'])
  if (!push.ok) {
    state.lastGitPulseResult = 'push failed — ינסה-שוב בפעימה-הבאה'
    log('פעימת-גיט: push נדחה — הפעימה-הבאה תעשה pull-rebase ותנסה שוב')
    return
  }
  state.gitPushes++
  state.lastGitPulseResult = `pushed: ${nFiles} files`
  log(`פעימת-גיט: נדחף ✓ ${nFiles} קבצים (סה"כ דחיפות-אוטומטיות: ${state.gitPushes})`)
}

// ===== עורק-0: שומר-האפליקציה (Task 26) — הרשת מרפאת-את-עצמה =====
let appGuardFails = 0
let appGuardBusy = false

async function appGuard(): Promise<void> {
  if (appGuardBusy) return
  appGuardBusy = true
  state.lastAppGuardAt = new Date().toISOString()
  try {
    const res = await fetch(`${APP_URL}/api/health`, { signal: AbortSignal.timeout(5_000) })
    if (res.ok) {
      appGuardFails = 0
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
      // ספון-בן-של-הלב: הלב חי-תחת-העץ-המתמיד של הפלטפורמה — ולכן הבן שורד גם-הוא.
      // אם מופע-זומבי מחזיק את-הפורט — הספון ייפול EADDRINUSE בכנות והסבב-הבא ינסה שוב.
      Bun.spawn(['bun', 'run', 'dev'], {
        cwd: PROJECT_DIR,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      state.appRestarts++
      state.lastAppGuardResult = `respawned (#${state.appRestarts}) — ממתין לבריאות`
      log(`שומר-האפליקציה: הוזנק מופע-חדש (#${state.appRestarts})`)
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
  `fabric-heartbeat חי — tick כל ${TICK_MS / 1000}s, פעימת-גיט כל ${GIT_PULSE_MS / 60_000} דק', פעימת-התפתחות כל ${EVOLUTION_PULSE_MS / 60_000} דק', דופק על :${PORT}`
)

setInterval(() => void tick(), TICK_MS)
setTimeout(() => void gitPulseChecked(), GIT_PULSE_FIRST_MS)
setInterval(() => void gitPulseChecked(), GIT_PULSE_MS)
setTimeout(() => void evolutionPulse(), EVOLUTION_PULSE_FIRST_MS)
setInterval(() => void evolutionPulse(), EVOLUTION_PULSE_MS)
setInterval(() => void appGuard(), APP_GUARD_MS)

void tick() // פעימה-ראשונה מיידית
void appGuard() // בדיקת-בריאות ראשונה מיידית
