// תרגיל-אטימות-המסמכים (מחזור-חדשנות #15, Task 82): חיבור-פסיפס-המסמכים-אל-השרשרת.
//
// הפער-הכן-שנסגר: ארבעת-התרגילים-הקיימים (שחזור-גיט #8, תמונה-שעתית #11, ייצוא-JSONL #13,
// אטימות-היסטוריה #14) מוכיחים-את-השרשרת-עצמה — אך **איש-מהם אינו מגן על פסיפס-המסמכים**:
// ארטיפקטי-ה-markdown שהרשת-בונה-בעצמה (sovereign/site/*.md — מאות-תוצרים-אוטונומיים).
// רשומת-SITEBUILD חותמת-את-פלט-ה-LLM-אך-לא-את-בייטי-הקובץ-בדיסק; מחיקה-שקטה-או-שינוי-
// שורה-בארטיפקט לא היה מתגלה-מעולם. מעתה: כל-תרגיל-מחשב-תמונת-אטימות-שלמה-של-הפסיפס
// (digest-קנוני-ממוין של כל-קובץ:גיבוב-תוכן) וחותם-אותה-בשרשרת — השרשרת-מעידה-על-מצב-
// המסמכים-בדיוק-כשם-שהיא-מעידה-על-עצמה. פגיעה-בקובץ = digest-שונה בתרגיל-הבא = חתום.
//
// האינווריאנטות (fail-honest):
//  1. row→file: כל-Improvement.artifactPath חייב-להתקיים-בדיסק — חסר = docs-missing-at-<path>.
//  2. file parse: כל-.md בפסיפס חייב-frontMatter-תקין (גדר-שניים, title, createdAt, body-לא-
//     ריק) — פגום = docs-corrupt-at-<name>. זו-ההגדרה-הקנונית-של-ארטיפקט-תקין (sitebuild.ts).
//  3. יתומים (קבצים-שנכתבו-מכותב-אחר ואינם-ממופים-לשורה) אינם-כשל — הם-חלק-מהפסיפס,
//     נספרים-בכנות (orphans) ונכללים-ב-digest. התרגיל-מוכיח-אטימות, לא-הנהלת-חשבונות.
//
// קנוניות: ה-digest מחושב-על-שורות-ממוינות relPath:hash — סדר-שרירותי-של-readdir אינו-
// משנה (לקח-#7: קנון-ממוין). outputHash = sha256Short(`docs:...`) נגזר-מהמצב-המלא.
// זמן: הפעימה-בלב (עורק-יא) כל-30דק', +75ש' אחרי-עליית-הלב; דילוג-כן-אם-טרי-מ-30דק'.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { dbReady } from '@/lib/restore-drill'

export const SITE_DIR = path.join(process.cwd(), 'sovereign', 'site')
const WORKER = 'drill:docs'
const MIN_INTERVAL_MS = 30 * 60_000

export interface DocsDrillResult {
  ok: boolean
  ran: boolean
  reason?: string
  errorClass?: string | null
  files?: number
  bound?: number
  orphans?: number
  mosaicDigest?: string
  durationMs?: number
  at: string
  ledgerId?: number
}

export interface DocsDrillBrief {
  at: string
  ok: boolean
  ledgerId: number
  durationMs: number
  errorClass: string | null
}

// frontMatter-קנוני (דפוס-sitebuild.ts): גדר-פתיחה, סגירה, title, createdAt, body-לא-ריק.
// מחזיר-אמת-או-שקר בלבד — הסיווג-המדויק (איזה-חוק-נשבר) נעשה-בקריאה-העוטפת.
function parsesAsArtifact(content: string): boolean {
  if (!content.startsWith('---\n')) return false
  const close = content.indexOf('\n---\n', 4)
  if (close < 0) return false
  const fm = content.slice(4, close)
  if (!/^title:/m.test(fm) || !/^createdAt:/m.test(fm)) return false
  const body = content.slice(close + 5)
  return body.trim().length > 0
}

export async function lastDocsDrill(): Promise<DocsDrillBrief | null> {
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

export async function runDocsDrill(force = false): Promise<DocsDrillResult> {
  if (running) {
    return { ok: false, ran: false, reason: 'skipped: docs drill already running', at: new Date().toISOString() }
  }
  running = true
  const started = Date.now()
  try {
    await dbReady() // לקח-#8: המנוע-חייב-להיות-מחובר-לפני-כל-קריאה-ולפני-החתימה
    const last = await lastDocsDrill()
    if (!force && last && Date.now() - new Date(last.at).getTime() < MIN_INTERVAL_MS) {
      return { ok: last.ok, ran: false, reason: 'skipped: recent drill within 30min', at: last.at, ledgerId: last.ledgerId }
    }

    if (!existsSync(SITE_DIR)) throw new Error('docs-dir-missing')

    // 1. כל-שורה-עם-ארטיפקט חייבת-קובץ-חי-בדיסק (row→file)
    const rows = await db.improvement.findMany({
      where: { artifactPath: { not: null } },
      select: { artifactPath: true },
      orderBy: { id: 'asc' },
    })
    const rowPaths = new Set(rows.map((r) => r.artifactPath as string))
    for (const p of rowPaths) {
      if (!existsSync(path.join(process.cwd(), p))) throw new Error(`docs-missing-at-${p}`)
    }

    // 2. כל-קובץ-בפסיפס חייב-להיות-ארטיפקט-תקין (frontMatter+body) ומגובב-לקנון-הממוין
    const names = readdirSync(SITE_DIR).filter((f) => f.endsWith('.md')).sort()
    if (names.length === 0) throw new Error('docs-empty')
    const lines: string[] = []
    let orphans = 0
    for (const name of names) {
      const abs = path.join(SITE_DIR, name)
      const content = readFileSync(abs, 'utf8')
      if (!parsesAsArtifact(content)) throw new Error(`docs-corrupt-at-${name}`)
      const rel = `sovereign/site/${name}`
      if (!rowPaths.has(rel)) orphans++ // יתום-כן: חלק-מהפסיפס, נספר-ולא-מפיל
      lines.push(`${rel}:${sha256Short(content)}`)
    }
    lines.sort() // לקח-#7: קנון-ממוין — סדר-הקריאה-אינו-משנה
    const mosaicDigest = sha256Short(lines.join('\n'))

    const durationMs = Date.now() - started
    const entry = await appendLedger({
      taskId: null,
      kind: 'DRILL',
      status: 'DONE',
      worker: WORKER,
      attempts: 1,
      durationMs,
      errorClass: null,
      outputHash: sha256Short(`docs:${lines.length}:${orphans}:${mosaicDigest}`),
    })
    return {
      ok: true,
      ran: true,
      files: lines.length,
      bound: lines.length - orphans,
      orphans,
      mosaicDigest,
      durationMs,
      at: entry.createdAt.toISOString(),
      ledgerId: entry.id,
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    // סיווג-כן-ומדויק (קנון-הסיווגים של-#11/#13/#14): כל-כישלון-מדווח-על-עצמו-בשמו.
    const errorClass = msg.includes('not yet connected')
      ? 'db-not-ready'
      : msg === 'docs-dir-missing' || msg === 'docs-empty'
        ? msg
        : msg.startsWith('docs-missing-at')
          ? 'docs-missing'
          : msg.startsWith('docs-corrupt-at')
            ? 'docs-corrupt'
            : 'docs-failed'
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
