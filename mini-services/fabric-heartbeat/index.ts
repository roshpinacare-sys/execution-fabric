// fabric-heartbeat — עורק-החיים של רשת-הביצוע (Task 25)
//
// שני עורקים, שניהם עצמאיים-לגמרי בדפדפן:
//   עורק-א: לולאת-tick כל 5 שניות → POST /api/worker/tick — הרשת קולטת-ומבצעת
//            משימות-QUEUED לבד (claim אטומי הוא קו-ההגנה מול עובד-הדפדפן).
//   עורק-ב: פעימת-גיט כל 15 דק' (וגם 90 שניות אחרי-הזנקה) — לפי RUNBOOK ריפו-האם:
//            pull-rebase → אם-יש-שינויים → leak-scan (חסם-כנה) → commit → push.
//            "הגיט-הוא-הקיום; הסנדבוקס-הוא-רק-זוג-ידיים."
//
// דיסציפלינה: אף סוד לא נוגע/נדפס כאן (ה-credential-helper קורא את קובץ-הסמכות
// בזמן-ריצה); אין-force-push; כשל-סריקת-דליפות = אין-push (כנות); כל-כשל נרשם-וממשיך.

import { existsSync } from 'node:fs'
import path from 'node:path'

const APP_URL = process.env.FABRIC_APP_URL ?? 'http://127.0.0.1:3000'
const PORT = Number(process.env.FABRIC_HEARTBEAT_PORT ?? 3031)
// נגזרת-מיקום-עצמי (mini-services/fabric-heartbeat → שורש-הפרויקט) — אפס-נתיב-מילולי (חסם-הדליפות)
const PROJECT_DIR = process.env.FABRIC_PROJECT_DIR ?? path.resolve(import.meta.dir, '../..')
const TICK_MS = 5_000
const GIT_PULSE_MS = 15 * 60_000
const GIT_PULSE_FIRST_MS = 90_000

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
  lastGitPulseAt: string | null
  lastGitPulseResult: string | null
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
  lastGitPulseAt: null,
  lastGitPulseResult: null,
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

// ===== עורק-ב: פעימת-גיט (RUNBOOK: pull → עבודה → סריקה → commit → rebase → push) =====
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

    const nFiles = status.out.trim().split('\n').length
    const commit = git(['commit', '-m', `fabric-heartbeat: auto-pulse — ${nFiles} changed files`])
    if (!commit.ok) {
      state.lastGitPulseResult = 'commit failed — כנות'
      return
    }
  }

  // pull-rebase אחרי-commit (העץ נקי עתה); קונפליקט = abort + כנות, הפעימה-הבאה תנסה
  const pull = git(['pull', '--rebase', 'origin', 'main'])
  if (!pull.ok) {
    git(['rebase', '--abort'])
    state.lastGitPulseResult = 'pull-rebase failed (conflict?) — abort + כנות, ינסה-שוב'
    log('פעימת-גיט: pull-rebase נכשל — abort. הקומיט-המקומי נשמר, אין-push')
    return
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

log(`fabric-heartbeat חי — tick כל ${TICK_MS / 1000}s, פעימת-גיט כל ${GIT_PULSE_MS / 60_000} דק', דופק על :${PORT}`)

setInterval(() => void tick(), TICK_MS)
setTimeout(() => gitPulse(), GIT_PULSE_FIRST_MS)
setInterval(() => gitPulse(), GIT_PULSE_MS)

void tick() // פעימה-ראשונה מיידית
