// תרגיל-אטימות-היסטוריית-המסמכים — הקשת-המלאה (מחזור-חדשנות #16+#17, Tasks 83-84):
// המסמכים-מהעבר-מוכחים-שלא-נשכו — על-כל-אורך-הזמן, לא-רק-בקצוות.
//
// הפער-הכן-שנסגר ב-#16: תרגיל-#15 (drill:docs) חותם-מדי-30דק' את מצב-הפסיפס-הנוכחי —
// אך איש-אינו-מוכיח-שהמסמכים-שנכתבו-אתמול-עומדים-עדיין-בלי-שינוי-אף-בית. #16 צליב את
// **הקומיט-העתיק-ביותר** ביט-ביט-מול-הדיסק-החי.
//
// הפער-הכן-שנסגר ב-#17: קצה-אחד-מוכח-אינו-קשת-מוכחת. תיאורטית, שכתוב-שקט-של-מסמך-
// בנקודת-ביניים-בהיסטוריה (והשארת-הקצוות-תקינים) היה-חומק-מ-#16. מעתה התרגיל-דוגם
// **5 נקודות-זמן לאורך הקשת** (עתיק · רבע · אמצע · שלושה-רבעים · אחרון-לפני-הראש)
// ומפריך-שתי-שכבות:
//  א. **פריכת-הקשת-התוך-גיטית** (זולה — blob-ids בלבד, אפס-קריאת-תוכן): לכל מסמך
//     שמופיע-בנקודה קדומה, ה-blob-שלו בכל נקודה מאוחרת יותר חייב-להיות-זהה ביט-ביט
//     (הפסיפס-append-only — sitebuild.ts מעולם-לא-משנה-קובץ-קיים). שינוי=
//     docs-history-arc-tampered-at-<path>; היעלמות=docs-history-arc-vanished-at-<path>;
//     ירידה-במספר-המסמכים-בין-נקודות-עוקבות=docs-history-arc-nonmonotonic.
//  ב. **פריכת-האמת-מול-הדיסק-החי** (קנון-#16): שני **קצות-הקשת** (העתיק-ביותר והאחרון)
//     נקראים-תוכן-תוכן (git show) ומוצלבים-ביט-ביט-מול-readFileSync-על-הדיסק — כדי-שההוכחה
//     לא-תהיה-גיט-מעיד-על-עצמו אלא-גיט-מעיד-על-המציאות-החיה-בשני-קצוות-הזמן.
//
// החתימה: digest-קנוני-ממוין של `sha12:path:blobSha` לכל-נקודת-קשת, ו-digests-שני-הקצוות
// מול-הדיסק — כולם-נכנסים-ל-outputHash. שכתוב-שקט בכל-נקודת-זמן שהיא = digest-שונה-בתרגיל-הבא = חתום.
//
// כנות (fail-honest): מראה-חסרה=docs-history-mirror-missing; אין-קומיט=docs-history-commit-missing;
// git-פקודה-נכשלה=docs-history-show-failed; תיקייה-חסרה-היום=docs-dir-missing (קנון-#15);
// db-לא-מחובר=db-not-ready (לקח-#8); כשל-כללי=docs-history-failed. כשל-חתום-לא-המצאה.
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
const ARC_POINTS = 5 // נקודות-הדגימה-על-הקשת: עתיק, רבע, אמצע, שלושה-רבעים, אחרון

// Task-129 (ליטוש-הכלים): מחלקה-נפרדת-בגינה — דיגסטים-תפעוליים-של-הלב.
// sovereign-pulse.md + ln.md נכתבים-מחדש-שעתית-ע״י-עורק-הנראות (Task-123) — מעולם-לא-היו
// תוצרי-sitebuild ואינם-נתונים-לחוק-ה-append-only שהתרגיל-מגן-עליו; הם-גם-לא-יכולים-לעמוד-בו
// בעצם-טבעם (מת-כתיבה-מחדש-מכוונת). שלמותם-נשמרת-בכלי-חי: משטח-ההוכחה מודד-את-mtime-שלהם
// בכל-בקשה. התיקון-כאן-הוא-תיקון-היקף-לאמת-ההיסטורית — התרגיל-ממשיך-להוכיח-ביט-ביט-את
// כל-תוצרי-הפסיפס-האמיתיים. נקודת-הסינון-היחידה: blobMapAt — כל-הבדיקות (קשת/היעלמות/
// מונוטוניות/צליבת-דיסק) ניזונות-ממנו.
const OPERATIONAL_DIGESTS = new Set<string>([
  'sovereign/site/sovereign-pulse.md',
  'sovereign/site/ln.md',
])

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
  // שכבת-#17 — הקשת-המלאה:
  arcPoints?: number
  arcOldestSha?: string
  arcYoungestSha?: string
  arcChecks?: number // בדיקות-ה-continuity התוך-גיטיות (קובץ×נקודה-מאוחרת)
  diskChecks?: number // קריאות-git-show-שהוצלבו-מול-הדיסק (שני-הקצוות)
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

// ls-tree עם-hash-אובייקט: מחזיר מפת path→blobSha (בלי-קריאת-תוכן)
function blobMapAt(sha: string): Map<string, string> {
  const raw = gitMirror(['ls-tree', '-r', sha, '--', SITE_PREFIX])
  const map = new Map<string, string>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab).split(/\s+/)
    const p = line.slice(tab + 1).trim()
    if (meta.length >= 3 && meta[1] === 'blob' && p.endsWith('.md')) {
      if (OPERATIONAL_DIGESTS.has(p)) continue // דיגסטים-תפעוליים — מחוץ-לחוק-ה-append-only (Task-129)
      map.set(p, meta[2])
    }
  }
  return map
}

function commitDate(sha: string): string {
  return gitMirror(['show', '-s', '--format=%cI', sha]).trim()
}

function gitShowUtf8(spec: string): string {
  return execFileSync('git', ['--git-dir', MIRROR_DIR, 'show', spec], {
    timeout: GIT_TIMEOUT_MS,
    stdio: 'pipe',
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
}

// קנון-#16: צליבת-נקודת-קצה-מול-הדיסק-החי — תוכן-אז מול תוכן-עכשיו
function crossCheckDisk(sha: string): { digest: string; checked: number } {
  const paths = [...blobMapAt(sha).keys()].sort()
  const lines: string[] = []
  for (const p of paths) {
    const thenHash = sha256Short(gitShowUtf8(`${sha}:${p}`))
    const absNow = path.join(process.cwd(), p)
    if (!existsSync(absNow)) throw new Error(`docs-history-missing-at-${p}`)
    const nowHash = sha256Short(readFileSync(absNow, 'utf8'))
    if (nowHash !== thenHash) throw new Error(`docs-history-tampered-at-${p}`)
    lines.push(`${p}:${thenHash}`)
  }
  return { digest: sha256Short(lines.sort().join('\n')), checked: paths.length }
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
    if (!existsSync(SITE_DIR)) throw new Error('docs-dir-missing')

    // 1. כל-הקומיטים-הנוגעים-בפסיפס — מהמראה-ה-bare, עתיק→חדש
    const commits = gitMirror(['rev-list', '--reverse', 'main', '--', SITE_PREFIX]).trim()
    if (commits === '') throw new Error('docs-history-commit-missing')
    const list = commits.split('\n').map((s) => s.trim()).filter(Boolean)

    // 2. דגימת-הקשת: 5 נקודות-ממוינות (עתיק, רבע, אמצע, שלושה-רבעים, אחרון-לפני-הראש)
    const idxs = new Set<number>([0, list.length - 1])
    for (let i = 1; i < ARC_POINTS - 1; i++) {
      idxs.add(Math.round((i * (list.length - 1)) / (ARC_POINTS - 1)))
    }
    const arcShas = [...idxs].sort((a, b) => a - b).map((i) => list[i])
    const arc = arcShas.map((sha) => ({ sha, date: commitDate(sha), blobs: blobMapAt(sha) }))
    if (arc[0].blobs.size === 0) throw new Error('docs-history-commit-missing')

    // 3. פריכת-הקשת-התוך-גיטית: append-only-בין-כל-זוג-נקודות-עוקבות (blob-id-בלבד — זול)
    const arcLines: string[] = []
    let arcChecks = 0
    let prev: { sha: string; blobs: Map<string, string> } | null = null
    for (const pt of arc) {
      if (prev) {
        if (pt.blobs.size < prev.blobs.size) {
          throw new Error(`docs-history-arc-nonmonotonic ${prev.blobs.size}->${pt.blobs.size}`)
        }
        for (const [p, oldBlob] of prev.blobs) {
          const newBlob = pt.blobs.get(p)
          if (newBlob === undefined) throw new Error(`docs-history-arc-vanished-at-${p}`)
          if (newBlob !== oldBlob) throw new Error(`docs-history-arc-tampered-at-${p}`)
          arcChecks++
        }
      }
      for (const [p, blob] of pt.blobs) arcLines.push(`${pt.sha.slice(0, 12)}:${p}:${blob}`)
      prev = pt
    }
    const arcDigest = sha256Short(arcLines.sort().join('\n'))

    // 4. פריכת-האמת-מול-הדיסק-החי — שני-קצות-הקשת (קנון-#16, המורחב לשני-הקצוות)
    const oldest = arc[0]
    const youngest = arc[arc.length - 1]
    const oldestDisk = crossCheckDisk(oldest.sha)
    const youngestDisk = crossCheckDisk(youngest.sha)

    // 5. צמיחה-חד-כיוונית-סופית — הפסיפס-החי-רק-גדל מנקודת-הקצה-האחרונה
    const curNames = readdirSync(SITE_DIR).filter((f) => f.endsWith('.md')).sort()
    if (curNames.length < youngest.blobs.size) {
      throw new Error(`docs-history-shrunk hist=${youngest.blobs.size} cur=${curNames.length}`)
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
      outputHash: sha256Short(
        `docs-history-arc:${arc.length}:${oldest.sha.slice(0, 12)}:${youngest.sha.slice(0, 12)}:` +
          `${arcDigest}:${oldestDisk.digest}:${youngestDisk.digest}:${curNames.length}`
      ),
    })
    return {
      ok: true,
      ran: true,
      commitSha: oldest.sha,
      commitDate: oldest.date,
      histFiles: oldest.blobs.size,
      curFiles: curNames.length,
      verified: oldest.blobs.size,
      histDigest: oldestDisk.digest,
      curDigest: youngestDisk.digest,
      // כן: כאן-הגיעו-רק-אם-שתי-ההצלבות-מול-הדיסק-עברו (אחרת-היה-נזרק-חריג-ממוין)
      match: true,
      // שכבת-#17:
      arcPoints: arc.length,
      arcOldestSha: oldest.sha,
      arcYoungestSha: youngest.sha,
      arcChecks,
      diskChecks: oldestDisk.checked + youngestDisk.checked,
      durationMs,
      at: entry.createdAt.toISOString(),
      ledgerId: entry.id,
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    // סיווג-כן-ומדויק (קנון-הסיווגים של-#11/#13/#14/#15/#16): כל-כישלון-מדווח-על-עצמו-בשמו.
    const errorClass = msg.includes('not yet connected')
      ? 'db-not-ready'
      : msg === 'docs-history-mirror-missing' || msg === 'docs-history-commit-missing' || msg === 'docs-dir-missing'
        ? msg
        : msg.startsWith('docs-history-missing-at')
          ? 'docs-history-missing'
          : msg.startsWith('docs-history-tampered-at')
            ? 'docs-history-tampered'
            : msg.startsWith('docs-history-arc-tampered-at')
              ? 'docs-history-arc-tampered'
              : msg.startsWith('docs-history-arc-vanished-at')
                ? 'docs-history-arc-vanished'
                : msg.startsWith('docs-history-arc-nonmonotonic')
                  ? 'docs-history-arc-nonmonotonic'
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
