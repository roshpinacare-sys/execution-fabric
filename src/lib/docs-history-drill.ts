// תרגיל-אטימות-היסטוריית-המסמכים (מחזור-חדשנות #16, Task 83): המסמכים-מהעבר-
// מוכחים-שלא-נשכו — סגירת-הציר-הרביעי.
//
// הפער-הכן-שנסגר: תרגיל-#15 (drill:docs) חותם-מדי-30דק' את מצב-הפסיפס-הנוכחי — אך
// איש-אינו-מוכיח-שהמסמכים-שנכתבו-אתמול-עומדים-עדיין-בלי-שינוי-אף-בית: שמסמך-שנכתב
// ב-02:39 לפני-יומיים הוא-ביט-ביט-אותו-מסמך-היום. פסיפס-המסמכים **append-only-ובלתי-
// ניתן-לשינוי** (sitebuild.ts כותב-קובץ-חדש-בשם-מחותמת-זמן-ומעולם-לא-משנה-קיים) —
// ותרגיל-זה הוא-ההוכחה-הקבועה-של-התכונה: המסמך-הראשון-בהיסטוריית-הגיט מוצלב-ביט-
// ביט-מול-הדיסק-החי. שכתוב-שקט-של-מסמך-ישן (בעץ-העבודה או-בהיסטוריה-עצמה) מתגלה.
//
// המנגנון (4-שלבים — דפוס-#14):
//  1. הקומיט-העתיק-ביותר-במראה-ה-bare (../fabric-mirror.git) הנוגע-ב-sovereign/site —
//     `git rev-list --reverse main -- <prefix>` (המראה-מקבלת-fast-forward-בלבד).
//  2. רשימת-המסמכים-בקומיט-זה: `git ls-tree -r --name-only <sha> -- <prefix>`.
//  3. לכל-מסמך-היסטורי: `git show <sha>:<path>` → sha256Short-התוכן-אז, מול-קריאת-
//     הקובץ-החי-על-הדיסק-עכשיו. חוסר-התאמה = docs-history-tampered-at-<path>;
//     קובץ-שנעלם = docs-history-missing-at-<path>. זיכרון-O(1): קובץ-אחד-בכל-רגע.
//  4. צמיחה-חד-כיוונית: מספר-המסמכים-החי >= ההיסטורי (הפסיפס-רק-גדל — הקטנה=docs-history-shrunk).
//     החתימה: outputHash נגזר-מ-digest-קנוני-ממוין של הקבוצה-ההיסטורית (path:hash אז) 
//     והצלבתו-מול-ה-digest-שלה-עכשיו — שניהם-נכנסים-ל-hash-החתימה.
//
// כנות (fail-honest): מראה-חסרה=docs-history-mirror-missing; אין-קומיט=docs-history-commit-missing;
// git-show-נכשל=docs-history-show-failed; תיקייה-חסרה-היום=docs-dir-missing (קנון-#15);
// כשל-כללי=docs-history-failed. כשל-חתום-לא-המצאה.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { dbReady } from '@/lib/restore-drill'
import { SITE_DIR } from '@/lib/docs-drill'

const MIRROR_DIR = path.join(process.cwd(), '..', 'fabric-mirror.git')
const SITE_PREFIX = 'sovereign/site'
const WORKER = 'drill:docs-history'
const MIN_INTERVAL_MS = 60 * 60_000
const GIT_TIMEOUT_MS = 60_000

export interface DocsHistoryDrillResult {
  ok: boolean
  ran: boolean
  reason?: string
  errorClass?: string | null
  commitSha?: string
  commitDate?: string
  histFiles?: number
  curFiles?: number
  verified?: number
  histDigest?: string
  curDigest?: string
  match?: boolean
  durationMs?: number
  at: string
  ledgerId?: number
}

export interface DocsHistoryDrillBrief {
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

export async function lastDocsHistoryDrill(): Promise<DocsHistoryDrillBrief | null> {
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

export async function runDocsHistoryDrill(force = false): Promise<DocsHistoryDrillResult> {
  if (running) {
    return { ok: false, ran: false, reason: 'skipped: docs-history drill already running', at: new Date().toISOString() }
  }
  running = true
  const started = Date.now()
  try {
    await dbReady() // לקח-#8: המנוע-חייב-להיות-מחובר-לפני-כל-קריאה-ולפני-החתימה
    const last = await lastDocsHistoryDrill()
    if (!force && last && Date.now() - new Date(last.at).getTime() < MIN_INTERVAL_MS) {
      return { ok: last.ok, ran: false, reason: 'skipped: recent drill within 60min', at: last.at, ledgerId: last.ledgerId }
    }

    if (!existsSync(MIRROR_DIR)) throw new Error('docs-history-mirror-missing')

    // 1. הקומיט-העתיק-ביותר-הנוגע-בפסיפס-המסמכים — מההיסטוריה-של-המראה-ה-bare
    const commits = gitMirror(['rev-list', '--reverse', 'main', '--', SITE_PREFIX]).trim()
    if (commits === '') throw new Error('docs-history-commit-missing')
    const sha = commits.split('\n')[0].trim()
    const commitDate = gitMirror(['show', '-s', '--format=%cI', sha]).trim()

    // 2. המסמכים-שהיו-אז (ls-tree — שמות-בלבד; תוכן-נקרא-קובץ-קובץ, O(1) זיכרון)
    const histPaths = gitMirror(['ls-tree', '-r', '--name-only', sha, '--', SITE_PREFIX])
      .split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.md')).sort()
    if (histPaths.length === 0) throw new Error('docs-history-commit-missing')

    // 3. הצלבה-ביט-ביט: תוכן-אז (git show) מול-תוכן-עכשיו (דיסק-חי)
    if (!existsSync(SITE_DIR)) throw new Error('docs-dir-missing')
    const histLines: string[] = []
    const curLines: string[] = []
    for (const p of histPaths) {
      const thenContent = execFileSync('git', ['--git-dir', MIRROR_DIR, 'show', `${sha}:${p}`], {
        timeout: GIT_TIMEOUT_MS,
        stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      })
      const thenHash = sha256Short(thenContent)
      const absNow = path.join(process.cwd(), p)
      if (!existsSync(absNow)) throw new Error(`docs-history-missing-at-${p}`)
      const nowHash = sha256Short(readFileSync(absNow, 'utf8'))
      if (nowHash !== thenHash) throw new Error(`docs-history-tampered-at-${p}`)
      histLines.push(`${p}:${thenHash}`)
      curLines.push(`${p}:${nowHash}`)
    }

    // 4. צמיחה-חד-כיוונית — הפסיפס-רק-גדל
    const curNames = readdirSync(SITE_DIR).filter((f) => f.endsWith('.md'))
    if (curNames.length < histPaths.length) {
      throw new Error(`docs-history-shrunk hist=${histPaths.length} cur=${curNames.length}`)
    }

    const histDigest = sha256Short(histLines.sort().join('\n'))
    const curDigest = sha256Short(curLines.sort().join('\n'))
    const match = histDigest === curDigest // ביט-ביט — אך-נגזר-שוב-לחתימה (הצלבה-כפולה)

    const durationMs = Date.now() - started
    const entry = await appendLedger({
      taskId: null,
      kind: 'DRILL',
      status: 'DONE',
      worker: WORKER,
      attempts: 1,
      durationMs,
      errorClass: null,
      outputHash: sha256Short(`docs-history:${sha.slice(0, 12)}:${histPaths.length}/${curNames.length}:${histDigest}:${curDigest}`),
    })
    return {
      ok: true,
      ran: true,
      commitSha: sha,
      commitDate,
      histFiles: histPaths.length,
      curFiles: curNames.length,
      verified: histPaths.length,
      histDigest,
      curDigest,
      match,
      durationMs,
      at: entry.createdAt.toISOString(),
      ledgerId: entry.id,
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    // סיווג-כן-ומדויק (קנון-הסיווגים של-#11/#13/#14/#15): כל-כישלון-מדווח-על-עצמו-בשמו.
    const errorClass = msg.includes('not yet connected')
      ? 'db-not-ready'
      : msg === 'docs-history-mirror-missing' || msg === 'docs-history-commit-missing' || msg === 'docs-dir-missing'
        ? msg
        : msg.startsWith('docs-history-missing-at')
          ? 'docs-history-missing'
          : msg.startsWith('docs-history-tampered-at')
            ? 'docs-history-tampered'
            : msg.startsWith('docs-history-shrunk')
              ? 'docs-history-shrunk'
              : msg.includes('does not exist') || msg.includes('fatal:')
                ? 'docs-history-show-failed'
                : 'docs-history-failed'
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
