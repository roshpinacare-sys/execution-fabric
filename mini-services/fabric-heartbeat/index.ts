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
const EVOLUTION_PULSE_MS = 5 * 60_000 // Task 29: 10→5 דק' — "טפל בפתוחים בצורה הטובה ביותר" (התקציב השעתי 12 קושר בדיוק)
const EVOLUTION_PULSE_FIRST_MS = 120_000
const BUILD_PULSE_MS = 10 * 60_000 // Task 32: עורק-הבנייה — 6 פעימות/שעה = התקציב השעתי בדיוק
const BUILD_PULSE_FIRST_MS = 4 * 60_000
const OPS_PULSE_MS = 10 * 60_000 // Task 44: עורק-הריבונות — הלב מריץ את הטיק העצמי ומרוקן מלאי
const OPS_PULSE_FIRST_MS = 90_000
const SELFTEST_PULSE_MS = 30 * 60_000 // Task 45: עורק-ז — הלב מוכיח את סרט-הכלים שלו ברציפות
const SELFTEST_PULSE_FIRST_MS = 3 * 60_000
const RESTORE_PULSE_MS = 6 * 60 * 60_000 // Task 70: עורק-ח — הוכחה-קבועה שהכפילות-הרחוקה מחזירה-מערכת-שלמה
const RESTORE_PULSE_FIRST_MS = 150_000
const NARRATE_TIMEOUT_MS = 120_000 // Task 39: ירי-TTS אמיתי — מהיר, אך-נותנים-רשת
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
  narrations: number
  narrationFails: number
  lastNarrationAt: string | null
  lastNarrationResult: string | null
  appRestarts: number
  lastAppGuardAt: string | null
  lastAppGuardResult: string | null
  dbFileReplaced: number
  lastReconnectResult: string | null
  restorePulses: number
  restoreOk: boolean | null
  lastRestoreAt: string | null
  lastRestoreResult: string | null
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
  narrations: 0,
  narrationFails: 0,
  lastNarrationAt: null,
  lastNarrationResult: null,
  appRestarts: 0,
  lastAppGuardAt: null,
  lastAppGuardResult: null,
  dbFileReplaced: 0,
  lastReconnectResult: null,
  restorePulses: 0,
  restoreOk: null,
  lastRestoreAt: null,
  lastRestoreResult: null,
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
      signal: AbortSignal.timeout(120_000), // selftest כולל drill — נותנים-רשת
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
  `fabric-heartbeat חי — tick כל ${TICK_MS / 1000}s, פעימת-גיט כל ${GIT_PULSE_MS / 60_000} דק', פעימת-התפתחות כל ${EVOLUTION_PULSE_MS / 60_000} דק', פעימת-בנייה כל ${BUILD_PULSE_MS / 60_000} דק', פעימת-ריבונות כל ${OPS_PULSE_MS / 60_000} דק', פעימת-אמת-עצמית כל ${SELFTEST_PULSE_MS / 60_000} דק', דופק על :${PORT}`
)

setInterval(() => void tick(), TICK_MS)
setTimeout(() => void gitPulseChecked(), GIT_PULSE_FIRST_MS)
setInterval(() => void gitPulseChecked(), GIT_PULSE_MS)
setTimeout(() => void evolutionPulse(), EVOLUTION_PULSE_FIRST_MS)
setInterval(() => void evolutionPulse(), EVOLUTION_PULSE_MS)
setTimeout(() => void buildPulse(), BUILD_PULSE_FIRST_MS)
setInterval(() => void buildPulse(), BUILD_PULSE_MS)
setTimeout(() => void opsPulse(), OPS_PULSE_FIRST_MS)
setInterval(() => void opsPulse(), OPS_PULSE_MS)
setTimeout(() => void selftestPulse(), SELFTEST_PULSE_FIRST_MS)
setInterval(() => void selftestPulse(), SELFTEST_PULSE_MS)
setTimeout(() => void restorePulse(), RESTORE_PULSE_FIRST_MS)
setInterval(() => void restorePulse(), RESTORE_PULSE_MS)
setInterval(() => void appGuard(), APP_GUARD_MS)

void tick() // פעימה-ראשונה מיידית
void appGuard() // בדיקת-בריאות ראשונה מיידית
