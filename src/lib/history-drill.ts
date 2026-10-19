// תרגיל-אטימות-ההיסטוריה (מחזור-חדשנות #14, Task 81): הוכחה שההיסטוריה-החתומה-בגיט
// מעולם-לא-נשכתה — לא רק שההווה משחזר, אלא שהעבר עדיין עומד.
//
// הפער-הכן-שנסגר: שלושת-תרגילי-השחזור (clone-גיט #8, תמונה-שעתית #11, ייצוא-JSONL #13)
// מוכיחים-את-ההווה: "המצב-הנוכחי-משחזר-ומאומת". איש-מהם-אינו-מוכיח-את-העבר: שהייצוא-
// שנחתם-בקומיט-הראשון עדיין-תקף-במלואו-היום — שאף-שכתוב-היסטוריה (force-push, פגיעה-
// במראה, תיקון-שקט-של-שורות-ישנות) לא הזיז אף-בית ממה-שנחתם-אז. השרשרת-חתומה-hash-
// ל-hash, אך-ההוכחה-התקופתית-של-כך-מול-עותק-היסטורי-גיט-היא-מה-שהופך-את-התכונה-מרעיון-
// לראיה-חתומה.
//
// המנגנון (3-שלבים):
//  1. הקומיט-העתיק-ביותר-במראה-ה-bare (../fabric-mirror.git) המכיל-את-הייצוא —
//     `git rev-list --reverse main -- <path>`. למה-המראה-ולא-עץ-העבודה: המראה-מקבלת-
//     דחיפות-fast-forward-בלבד (הזקיפה) — היסטוריה-שלמה-שנשמרת-גם-כשעץ-העבודה-rebase.
//  2. `git show <sha>:<path>` **כזרימה** (spawn→readline, O(1) זיכרון, אפס-עותק-עבודה)
//     → חישוב-מחדש-מלא-מה-Genesis דרך-מאמת-השורות-הקנוני (ChainVerifier — אותו-כלל-
//     אמת-של-הייצוא-החי, אפס-שכפול-קוד-שעלול-לסטות).
//  3. הצלבת-קידומת-מול-הייצור-החי: ראש-ההיסטוריה בגובה-סדרה חייב-להיות-זהה-ביט-ביט-
//     ל-hash-הייצור-שם. חישוב-מחדש-מוכיח-תקינות-פנימית; ההצלבה-מוכיחה-שההיסטוריה-וההווה
//     הם-שרשרת-אחת-רציפה.
//
// כנות (fail-honest): מראה-חסרה=history-mirror-missing; אין-קומיט=history-commit-missing;
// git-show-נכשל=history-show-failed; שורה-פגומה=history-corrupt-line-N; פער-רצף=history-gap-at-N;
// שרשרת-פגועה=copy-chain-broken-at-N (קנון-מאוחד-מ-#11); הקדמה-לייצור=copy-ahead-of-production;
// סתירת-קידומת=copy-not-a-prefix. כשל-חתום-לא-המצאה.
//
// זמן-ההוכחה-צומח-מדי-קומיט: הייצוא-נולד-במחזור-#13 — ההיסטוריה-צעירה-היום; המנגנון-נצחי.
// חוק-ה-workpath: המראה-נגזרת-מ-process.cwd() — אפס-נתיב-מכונה-מילולי.
import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { db } from '@/lib/db'
import { appendLedger, sha256Short, GENESIS } from '@/lib/ledger'
import { ChainVerifier } from '@/lib/chain-export'
import { dbReady } from '@/lib/restore-drill'

const MIRROR_DIR = path.join(process.cwd(), '..', 'fabric-mirror.git')
const EXPORT_IN_REPO = 'sovereign/chain-export/ledger.jsonl'
const WORKER = 'drill:history'
const MIN_INTERVAL_MS = 30 * 60_000
const GIT_TIMEOUT_MS = 60_000

export interface HistoryDrillResult {
  ok: boolean
  ran: boolean
  reason?: string
  errorClass?: string | null
  commitSha?: string
  commitDate?: string
  verified?: number
  total?: number
  historyHead?: string
  prodHead?: string
  prefixMatch?: boolean
  durationMs?: number
  at: string
  ledgerId?: number
}

export interface HistoryDrillBrief {
  at: string
  ok: boolean
  ledgerId: number
  durationMs: number
  errorClass: string | null
}

function gitMirror(args: string[], timeout = GIT_TIMEOUT_MS): string {
  return execFileSync('git', ['--git-dir', MIRROR_DIR, ...args], {
    timeout,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  }).toString()
}

export async function lastHistoryDrill(): Promise<HistoryDrillBrief | null> {
  const rec = await db.ledgerEntry.findFirst({
    where: { kind: 'DRILL', worker: WORKER },
    orderBy: { id: 'desc' },
  })
  if (!rec) return null
  return {
    at: rec.createdAt.toISOString(),
    ok: rec.status === 'DONE',
    ledgerId: rec.id,
    durationMs: rec.durationMs,
    errorClass: rec.errorClass,
  }
}

let running = false // מנעול-ריצה-בודדת — אותה-היגיינה-של-שאר-התרגילים

export async function runHistoryDrill(force = false): Promise<HistoryDrillResult> {
  if (running) {
    return { ok: false, ran: false, reason: 'skipped: history drill already running', at: new Date().toISOString() }
  }
  running = true
  const started = Date.now()
  try {
    await dbReady() // לקח-#8: המנוע-חייב-להיות-מחובר-לפני-כל-קריאה-ולפני-החתימה
    const last = await lastHistoryDrill()
    if (!force && last && Date.now() - new Date(last.at).getTime() < MIN_INTERVAL_MS) {
      return { ok: last.ok, ran: false, reason: 'skipped: recent drill within 30min', at: last.at, ledgerId: last.ledgerId }
    }

    if (!existsSync(MIRROR_DIR)) throw new Error('history-mirror-missing')

    // 1. הקומיט-העתיק-ביותר-המכיל-את-הייצוא — מההיסטוריה-של-המראה-ה-bare
    const commits = gitMirror(['rev-list', '--reverse', 'main', '--', EXPORT_IN_REPO]).trim()
    if (commits === '') throw new Error('history-commit-missing')
    const sha = commits.split('\n')[0].trim()
    const commitDate = gitMirror(['show', '-s', '--format=%cI', sha]).trim()

    // 2. זרימת-התוכן-מההיסטוריה-עצמה (spawn→readline — O(1) זיכרון, בלי-עותק-עבודה)
    //    → חישוב-מחדש-מלא-מה-Genesis במאמת-הקנון.
    const verifier = new ChainVerifier('history')
    const child = spawn('git', ['--git-dir', MIRROR_DIR, 'show', `${sha}:${EXPORT_IN_REPO}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
    await new Promise<void>((resolve, reject) => {
      let gitErr = ''
      child.stderr.on('data', (d: Buffer) => {
        gitErr += d.toString()
      })
      child.on('error', reject) // spawn עצמו נכשל (ENOENT וכד') — כשל-כן
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`history-show-failed code=${code} ${gitErr.slice(0, 200).trim()}`))
      })
      void (async () => {
        try {
          for await (const raw of rl) verifier.consume(raw)
        } catch (e) {
          reject(e) // שורה-פגומה/פער/שרשרת-שבורה — הזרימה-נעצרת-והכישלון-עולה
          child.kill()
        }
      })()
    })
    const { verified, total, head: historyHead } = verifier.finish()

    // 3. הצלבת-קידומת-מול-הייצור-החי (קנון-#11: העותק-ההיסטורי=קידומת-מאומתת-של-החי)
    const prodRec = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
    const prodHead = prodRec?.hash ?? GENESIS
    const prodTotal = prodRec?.id ?? 0
    if (total > prodTotal) {
      throw new Error(`copy-ahead-of-production history=${total} prod=${prodTotal}`)
    }
    const anchor = await db.ledgerEntry.findFirst({ where: { id: total } })
    if (!anchor || anchor.hash !== historyHead) {
      throw new Error(
        `copy-not-a-prefix seq=${total} history=${historyHead.slice(0, 8)} prod=${anchor?.hash.slice(0, 8) ?? 'missing'}`
      )
    }

    const durationMs = Date.now() - started
    const entry = await appendLedger({
      taskId: null,
      kind: 'DRILL',
      status: 'DONE',
      worker: WORKER,
      attempts: 1,
      durationMs,
      errorClass: null,
      outputHash: sha256Short(`history:${sha.slice(0, 12)}:${verified}/${total}:${historyHead}`),
    })
    return {
      ok: true,
      ran: true,
      commitSha: sha,
      commitDate,
      verified,
      total,
      historyHead,
      prodHead,
      prefixMatch: true,
      durationMs,
      at: entry.createdAt.toISOString(),
      ledgerId: entry.id,
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    // סיווג-כן-ומדויק (קנון-הסיווגים של-#11/#13): כל-כישלון-מדווח-על-עצמו-בשמו.
    const errorClass = msg.includes('not yet connected')
      ? 'db-not-ready'
      : msg.startsWith('copy-chain-broken')
        ? 'copy-chain-broken'
        : msg.startsWith('copy-not-a-prefix') || msg.startsWith('copy-ahead')
          ? 'copy-not-prefix'
          : msg.startsWith('history-corrupt-line')
            ? 'history-corrupt-line'
            : msg.startsWith('history-gap')
              ? 'history-gap'
              : msg === 'history-mirror-missing' || msg === 'history-commit-missing'
                ? msg
                : msg.startsWith('history-show-failed')
                  ? 'history-show-failed'
                  : 'history-failed'
    try {
      const entry = await appendLedger({
        taskId: null,
        kind: 'DRILL',
        status: 'FAILED',
        worker: WORKER,
        attempts: 1,
        durationMs,
        errorClass,
        outputHash: sha256Short(''),
      })
      return {
        ok: false,
        ran: true,
        reason: msg,
        errorClass,
        durationMs,
        at: entry.createdAt.toISOString(),
        ledgerId: entry.id,
      }
    } catch {
      // אם-גם-החתימה-נכשלה (שרשרת-לא-כתיבה) — מדווחים-בכנות-בלי-רישום
      return { ok: false, ran: true, reason: msg, errorClass, durationMs, at: new Date().toISOString() }
    }
  } finally {
    running = false
  }
}
