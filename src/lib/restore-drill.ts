// תרגיל-שחזור (Task 70): הוכחה-קבועה שהכפילות-הרחוקה (GitHub) מחזירה-מערכת-שלמה-מאומתת.
//
// רקע: Task 69-b — תרגיל-ידני ראשון הוכיח שחזור-ביט-ביט (clone-טרי → העד-העצמאי אימת
// 610/610, head זהה-לייצור). כאן ההוכחה-הופכת-מבצורה-של-פעם-למכונה: clone-רדוד
// (--depth 1, חסכוני-ברשת) → אימות-שרשרת-עצמאי על עותק-ה-db-המשוחזר
// (prisma-חד-פעמי מעל file-URL נפרד + verifyChain הקנוני) → הצלבת-ראש מול-הייצור
// → חתימת-DRILL בשרשרת-האמת (status/errorClass/outputHash — fail-honest).
//
// היגיינה (חוק-ה-workpath של leak-scan): אפס-נתיבי-מכונה בעץ — ה-credential-helper
// נגזר-מ-process.cwd(); עותקי-העבודה נולדים-ומתים ב-/tmp (mkdtemp, נמחקים-תמיד).
//
// הגינות-מול-GitHub (docs/BEYOND-GITHUB.md): clone-גיט אינו-נגד-מכסת-ה-REST,
// ובכל-זאת — מינוף-רדוד + דילוג-אם-תרגיל-טרי-מ-30דק' + מנעול-ריצה-בודדת.
//
// מחזור-חדשנות #8 (Task 75): הלקח-החי-מ-06:52 — הפעימה-האוטומטית רצה-150ש' אחרי-עליית-הלב,
// הקריאה-הראשונה ל-db מעירה-את-תהליך-Next והמנוע-עוד-אינו-חובר ("Engine is not yet connected")
// → התרגיל-חתם-FAILED-והשאיר-כוסת-הוכחות-של-4ש'. התיקון-מהשורש: dbReady() —
// המתנה-למנוע ב-retry-קצר-וגלוי לפני-כל-הרצה; וסיווג-מדויק 'db-not-ready' אם-בכל-זאת-כשל.
//
// מחזור-חדשנות #11 (Task 78): מקור-שחזור-שני — התמונה-השעתית (VACUUM INTO ב-fabric-backups,
// זקיפה-:3051). עד-היום ההוכחה-הקבועה נשענה על מקור-אחד (clone-גיט). אם-הגיט-עצמו-נפגע
// (מכסה, זמינות, פגיעה-בריפו) — לא היה-הוכחה-שהמקור-השני-באמת-משחזר. מעתה: source='snapshot'
// מעתיק-את-התמונה-השעתית-הטרייה-ביותר לעותק-עבודה → אותו-אימות-עצמאי-בזרימה → אותה-הצלבת-
// קידומת-מול-הייצור → חתימה-ב-worker-משלו (drill:restore-snapshot). שני-מקורות-בלתי-תלויים,
// אותו-קנון-אמת. כנות: תמונה-חסרה = snapshot-missing; תמונה-ישנה-מ-90דק' = snapshot-stale —
// כשל-חתום, לא-המצאה. הנתיב-נגזר-מ-cwd (לא-קשה-מקודד) — עקבי-עם-חוק-ה-workpath.
//
// מחזור-חדשנות #13 (Task 80): מקור-שחזור-שלישי מגוון-פורמט — ייצוא-JSONL-של-השרשרת-בגיט
// (sovereign/chain-export/ledger.jsonl, append-only). הפער: שני-המקורות-הקיימים נגזרים-שניהם-
// מאותו-ארטיפקט-פיזי (קובץ-SQLite) — פגיעה-לוגית-בקובץ-הייתה-מועתקת-נאמנה לשניהם. source='export'
// מאמת-את-הטקסט-בזיכרון: חישוב-מחדש של כל-שרשרת-ה-hash מה-Genesis — בלי-Prisma, בלי-SQLite,
// בלי-עותק-עבודה (אפס-mkdtemp) — ואז אותה-הצלבת-קידומת-מול-הייצור. יתרון-היסטוריית-הגיט:
// הייצוא-שנחתם-אתמול אינו-נשחק-על-ידי-פגיעה-בקובץ-היום. כנות: קובץ-חסר=export-missing,
// שורה-פגומה=export-corrupt-line-N, פער-רצף=export-gap-at-N — כשלים-חתומים, לא-המצאות.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'
import { appendLedger, sha256Short, ledgerHash, GENESIS } from '@/lib/ledger'
import { verifyExportStream } from '@/lib/chain-export'

const REPO_URL = 'https://github.com/roshpinacare-sys/execution-fabric.git'
const DRILL_TASK = 'restore-drill' // זהות-לוגית בלבד — בשרשרת היא ב-worker (taskId = מפתח-זר ל-Task אמיתית, קונבנציית drill:*)
const WORKERS: Record<DrillSource, string> = {
  git: 'drill:restore',
  snapshot: 'drill:restore-snapshot',
  export: 'drill:restore-export',
}
const MIN_INTERVAL_MS = 30 * 60_000
const CLONE_TIMEOUT_MS = 120_000
// מקור-התמונות-השעתיות — נגזר-מ-cwd, מחוץ-לעץ-הפרויקט (כמו המראה ה-bare של הזקיפה)
const SNAPSHOT_DIR = path.join(process.cwd(), '..', 'fabric-backups')
const SNAPSHOT_NAME = /^db-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/
const SNAPSHOT_MAX_AGE_MS = 90 * 60_000 // מעבר-לזה: המכונה-השעתית-עצמה-פסקה → כשל-כן

export type DrillSource = 'git' | 'snapshot' | 'export'

export interface RestoreDrillResult {
  ok: boolean
  ran: boolean
  source?: DrillSource
  reason?: string
  errorClass?: string | null
  verified?: number
  total?: number
  cloneHead?: string | null
  prodHead?: string | null
  prefixMatch?: boolean
  durationMs?: number
  snapshotName?: string
  snapshotAgeMs?: number
  at: string
  ledgerId?: number
}

export interface LastDrillBrief {
  at: string
  ok: boolean
  ledgerId: number
  durationMs: number
  errorClass: string | null
}

// חוסן-אתחול (מחזור-#8): הקריאה-הראשונה ל-db בתהליך-טרי עלולה-להיתקל-במנוע-שטרם-חובר.
// ממתינים-למנוע ב-retry-קצר (עד ~8ש') — רק-על-סימן-הזיהוי המדויק; כל-שגיאה-אחרת מתעופפת-מיד.
async function dbReady(maxAttempts = 16, delayMs = 500): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.ledgerEntry.findFirst({ select: { id: true }, orderBy: { id: 'desc' } })
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('not yet connected') || i >= maxAttempts) throw e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

// התמונה-השעתית-הטרייה-ביותר — לפי-mtime, לא-לפי-שם (כנות-בזמן-אמת)
function findLatestSnapshot(): { path: string; name: string; ageMs: number } | null {
  let names: string[]
  try {
    names = readdirSync(SNAPSHOT_DIR).filter((n) => SNAPSHOT_NAME.test(n))
  } catch {
    return null // הספרייה-עצמה-חסרה = אין-מקור-שני
  }
  let best: { path: string; name: string; ageMs: number } | null = null
  for (const name of names) {
    try {
      const p = path.join(SNAPSHOT_DIR, name)
      const ageMs = Date.now() - statSync(p).mtimeMs
      if (!best || ageMs < best.ageMs) best = { path: p, name, ageMs }
    } catch {
      // קובץ-נעלם-בין-readdir ל-stat — ממשיכים-לבאים-אחריו
    }
  }
  return best
}

export async function lastRestoreDrill(source: DrillSource = 'git'): Promise<LastDrillBrief | null> {
  const rec = await db.ledgerEntry.findFirst({
    where: { kind: 'DRILL', worker: WORKERS[source] },
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

let running = false // מנעול-ריצה-בודדת — שני-POST מקבילים (או-git-מול-snapshot) לא יריצו-שני-עותקי-עבודה

export async function runRestoreDrill(force = false, source: DrillSource = 'git'): Promise<RestoreDrillResult> {
  if (running) {
    return { ok: false, ran: false, source, reason: 'skipped: drill already running', at: new Date().toISOString() }
  }
  running = true
  const started = Date.now()
  try {
    await dbReady() // מחזור-#8: המנוע-חייב-להיות-מחובר-לפני-כל-קריאה-ולפני-החתימה
    const last = await lastRestoreDrill(source)
    if (!force && last && Date.now() - new Date(last.at).getTime() < MIN_INTERVAL_MS) {
      return {
        ok: last.ok,
        ran: false,
        source,
        reason: 'skipped: recent drill within 30min',
        at: last.at,
        ledgerId: last.ledgerId,
      }
    }

    // המקור-השלישי (#13) טקסט-בזיכרון — בלי-עותק-עבודה-כלל (אפס-mkdtemp, אפס-מגע-בדיסק-חוץ)
    const useWorkCopy = source !== 'export'
    const dir = useWorkCopy ? mkdtempSync(path.join(tmpdir(), 'fabric-drill-')) : null
    try {
      // הכנת-עותק-העבודה — הנקודה-היחידה-שבה-המקורות-נבדלים; מכאן-ואילך קנון-אחד.
      // (export מדלג-כאן-לגמרי: המקור-שלו הוא-הטקסט-בזיכרון, לא-עותק-עבודה)
      let copyDb: string | undefined
      let snapshotName: string | undefined
      let snapshotAgeMs: number | undefined
      if (source === 'git') {
        const helper = path.join(process.cwd(), '.zscripts', 'git-credential-pat.sh')
        execFileSync(
          'git',
          ['clone', '--depth', '1', '--single-branch', '--branch', 'main', '-c', `credential.helper=${helper}`, REPO_URL, dir as string],
          { timeout: CLONE_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        )
        copyDb = path.join(dir as string, 'db', 'custom.db')
      } else if (source === 'snapshot') {
        const snap = findLatestSnapshot()
        if (!snap) throw new Error('snapshot-missing')
        if (snap.ageMs > SNAPSHOT_MAX_AGE_MS) {
          throw new Error(`snapshot-stale ageMin=${Math.round(snap.ageMs / 60_000)}`)
        }
        copyDb = path.join(dir, 'snapshot-copy.db')
        copyFileSync(snap.path, copyDb) // התמונה-עצמה-לא-נוגעים-בה — עותק-עבודה-מנותק
        snapshotName = snap.name
        snapshotAgeMs = snap.ageMs
      }
      if (copyDb !== undefined && !existsSync(copyDb))
        throw new Error(source === 'git' ? 'clone-db-missing' : 'snapshot-copy-missing')

      const prodRec = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
      const prodHead = prodRec?.hash ?? GENESIS
      const prodTotal = prodRec?.id ?? 0

      let verified: number
      let total: number
      let copyHead: string
      if (source === 'export') {
        // מקור-שלישי (#13): אימות-הטקסט-בזיכרון — חישוב-מחדש-מלא מה-Genesis, בלי-מנוע-DB.
        // ההבדל-המהותי: כאן-המקור-עצמו הוא-הטקסט-החתום (כבר-בגיט), לא-קובץ-SQLite.
        ;({ verified, total, head: copyHead } = await verifyExportStream())
      } else {
        // קורא-חד-פעמי על-עותק-השחזור — ה-db-הייצור-שלי לא נוגע-כלל.
        // מחזור-#10 (Task 77): האימות-על-העותק-בזרימה (cursor-pagination) — הטעינה-המלאה
        // של-העותק-מוסרת; אותו-דגם-אמונים: מה-Genesis, בלי-דלתא, בלי-checkpoint.
        const reader = new PrismaClient({ datasources: { db: { url: `file:${copyDb as string}` } } })
        try {
        total = await reader.ledgerEntry.count()
        let prev = GENESIS
        let brokenAt: number | null = null
        verified = 0
        let cursorId: number | undefined
        const PAGE = 500
        while (brokenAt === null) {
          const page = await reader.ledgerEntry.findMany({
            orderBy: { id: 'asc' },
            take: PAGE,
            ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
          })
          if (page.length === 0) break
          for (const e of page) {
            if (e.prev !== prev) {
              brokenAt = e.id
              break
            }
            if (e.hash !== ledgerHash(e)) {
              brokenAt = e.id
              break
            }
            prev = e.hash
            verified++
          }
          if (page.length < PAGE) break
          cursorId = page[page.length - 1].id
        }
        if (brokenAt !== null) throw new Error(`copy-chain-broken-at-${brokenAt}`)
        copyHead = verified > 0 ? prev : GENESIS
      } finally {
        await reader.$disconnect()
      }
      }

      // הצלבה-נכונה למערכת-חיה (לקח-הרצה-ראשונה, Task 70): הייצור גדל-בין-דחיפות —
      // שוויון-ראש-מלא אינו-הקריטריון. קריטריון-האמת: העותק-המשוחזר = קידומת-מאומתת
      // של השרשרת-החיה — hash-העותק בגובה-סדר-העותק זהה-ביט-ביט ל-hash-הייצור-שם.
      // הזנב-שנולד-אחרי-המקור (דחיפה/תמונה) מכוסה-על-ידי-פעימות-הדופק-והזקיפה.
      if (total > prodTotal) {
        throw new Error(`copy-ahead-of-production copy=${total} prod=${prodTotal}`)
      }
      const anchor = await db.ledgerEntry.findFirst({ where: { id: total } })
      if (!anchor || anchor.hash !== copyHead) {
        throw new Error(`copy-not-a-prefix seq=${total} copy=${copyHead.slice(0, 8)} prod=${anchor?.hash.slice(0, 8) ?? 'missing'}`)
      }
      const durationMs = Date.now() - started
      const entry = await appendLedger({
        taskId: null,
        kind: 'DRILL',
        status: 'DONE',
        worker: WORKERS[source],
        attempts: 1,
        durationMs,
        errorClass: null,
        outputHash: sha256Short(`restore:${source}:${verified}/${total}:${copyHead}`),
      })
      return {
        ok: true,
        ran: true,
        source,
        verified,
        total,
        cloneHead: copyHead, // שדה-התוצאה-ההיסטורי — נשאר-קריא לכל-צרכני-ה-API
        prodHead,
        prefixMatch: true,
        durationMs,
        snapshotName,
        snapshotAgeMs,
        at: entry.createdAt.toISOString(),
        ledgerId: entry.id,
      }
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true }) // העותק-נולד-ומת — לעולם-לא-מצטבר
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    // סיווג-כן-ומדויק: כל-מקור-מדווח-על-כישלונו-בשמו; אין-שקר-מטפורי-בשרשרת.
    const chainBroken = msg.startsWith('copy-chain-broken')
    const notPrefix = msg.startsWith('copy-not-a-prefix') || msg.startsWith('copy-ahead')
    const exportCorrupt =
      msg.startsWith('export-corrupt-line') || msg.startsWith('export-gap') || msg.startsWith('export-diverges')
    const missing =
      msg === 'clone-db-missing' || msg === 'snapshot-copy-missing' || msg === 'snapshot-missing' || msg === 'export-missing'
    const stale = msg.startsWith('snapshot-stale')
    const errorClass = msg.includes('not yet connected')
      ? 'db-not-ready'
      : chainBroken
        ? 'copy-chain-broken'
        : notPrefix
          ? 'copy-not-prefix'
          : stale
            ? 'snapshot-stale'
            : exportCorrupt
              ? 'export-corrupt'
              : missing
                ? source === 'git'
                  ? 'clone-db-missing'
                  : source === 'snapshot'
                    ? 'snapshot-missing'
                    : 'export-missing'
                : source === 'git'
                  ? 'clone-failed'
                  : source === 'snapshot'
                    ? 'snapshot-failed'
                    : 'export-failed'
    try {
      const entry = await appendLedger({
        taskId: null,
        kind: 'DRILL',
        status: 'FAILED',
        worker: WORKERS[source],
        attempts: 1,
        durationMs,
        errorClass,
        outputHash: sha256Short(''),
      })
      return {
        ok: false,
        ran: true,
        source,
        reason: msg,
        errorClass,
        durationMs,
        snapshotName,
        snapshotAgeMs,
        at: entry.createdAt.toISOString(),
        ledgerId: entry.id,
      }
    } catch {
      // אם-גם-החתימה-נכשלה (שרשרת-לא-כתיבה) — מדווחים-בכנות-בלי-רישום
      return { ok: false, ran: true, source, reason: msg, errorClass, durationMs, at: new Date().toISOString() }
    }
  } finally {
    running = false
  }
}
