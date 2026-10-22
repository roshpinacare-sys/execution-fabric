import { createHash } from 'crypto'
import type { LedgerEntry } from '@prisma/client'
import { db } from '@/lib/db'

// שרשרת-אמת (worklog Task 12): hash = sha256(JSON.stringify({...rec, prev})).slice(0,32)
// genesis prev = "GENESIS" — אותה סמנטיקה שהוכחה על fleet-economy.

export const GENESIS = 'GENESIS'

export function sha256Short(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

export interface LedgerRecord {
  taskId: string | null
  kind: string
  status: string
  worker: string
  attempts: number
  durationMs: number
  errorClass: string | null
  outputHash: string
  prev: string
}

// canonical stringify — סדר-מפתחות קבוע, אפס-אמביגואליות
export function ledgerRecordString(rec: LedgerRecord): string {
  return JSON.stringify({
    taskId: rec.taskId,
    kind: rec.kind,
    status: rec.status,
    worker: rec.worker,
    attempts: rec.attempts,
    durationMs: rec.durationMs,
    errorClass: rec.errorClass,
    outputHash: rec.outputHash,
    prev: rec.prev,
  })
}

export function ledgerHash(rec: LedgerRecord): string {
  return sha256Short(ledgerRecordString(rec))
}

export interface VerifyResult {
  ok: boolean
  head: string
  brokenAt: number | null
  verified: number
}

// מחזור-חדשנות #7 (Task 74): אימות-מלא-בזרימה.
// זה-אינו-דלתא ואינו-checkpoint: כל-רשומה נאותת מה-Genesis בכל-קריאה — דגם-האמונים
// של verifyChain נשמר-שלם. השינוי-הוא-אך-ורק דפוס-הקריאה: cursor pagination
// (WHERE id > cursor LIMIT n) → זיכרון-חסום-ב-O(מנת-דף) במקום O(n) — קריטי-במפקח
// הריבוני שרץ-לנצח-עם-שרשרת-צומחת.
export interface StreamedVerifyResult extends VerifyResult {
  pages: number // כמה-דפים-נקראו (מדידה-כנה של העלות)
  total: number // סך-הרשומות בטבלה (COUNT)
}

export async function verifyChainStreamed(pageSize = 500): Promise<StreamedVerifyResult> {
  let prev = GENESIS
  let brokenAt: number | null = null
  let verified = 0
  let pages = 0
  let cursorId: number | undefined
  while (brokenAt === null) {
    const page = await db.ledgerEntry.findMany({
      orderBy: { id: 'asc' },
      take: pageSize,
      ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })
    if (page.length === 0) break
    pages++
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
    if (page.length < pageSize) break
    cursorId = page[page.length - 1].id
  }
  const total = await db.ledgerEntry.count()
  return { ok: brokenAt === null, head: verified > 0 ? prev : GENESIS, brokenAt, verified, pages, total }
}

// אימות מקצה-לקצה: קישוריות prev + חישוב-מחדש של כל-hash. fail-closed.
export function verifyChain(entries: LedgerEntry[]): VerifyResult {
  let prev = GENESIS
  let brokenAt: number | null = null
  let verified = 0
  for (const e of entries) {
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
  const head = verified > 0 ? entries[verified - 1].hash : GENESIS
  return { ok: brokenAt === null, head, brokenAt, verified }
}

// הוספת רשומה לשרשרת: prev = hash הראש הנוכחי (או GENESIS)
// opts.batchId — מקשר-ניווט בלבד (Task 24): נשמר בעמודה נפרדת, מחוץ ל-hash הקנוני,
// כדי שהחתימה-ההיסטורית של כל-השרשרת תישאר בדיוק כמו-שהיא.
//
// Task 61 (בחינה-עמוקה): תיקון תנאי-תחרות קריטי — findFirst→create לא-אטומי.
// שתי-בקשות-מקבילות היו קוראות את אותו-ראש ויוצרות מזלג (שתי-רשומות עם אותו-prev
// → השרשרת-נשברת). כל-הכותבים בתהליך-זה עוברים דרך כאן → שרשרת-הבטחות מסדרת-אותם:
// כל-append קורא את הראש רק אחרי שהקודם הסתיים — prev תמיד הראש-האמיתי.
//
// Task 86 (אירוע-חי 18:27:43, מזלג-ראשון מאז-#61): המנעול-המודולי-בגדר-עצמו ב-Next.js dev —
// Turbopack בונה כל-route-handler כ-bundle נפרד, ולכל-עותק-מודול תור-משלו. שלושת-התרגילים
// שירדו-באותו-tick מהלב (docs/history/restore-export) רצו בשלושה-עותקי-מנעול → שתי-רשומות
// נולדו-עם אותו-prev (1044/1045). התיקון-מהשורש: התור חי על **globalThis** — מרחב-יחיד
// בכל-התהליך, חוצה-bundles. ומעליו שתי-הגנות-עמוקות:
//  (א) UNIQUE(prev) ברמת-המסד — מזלג בין-תהליכים (אפילו-אפליקציה-שנייה-ששרדה-רגע) נדחה-
//      אל-האבן ולא-נכתב-שקט; המפסיד מנסה-שוב-אחרי-קריאת-ראש-טרייה (retry על P2002).
//  (ב) appendSlot מיוצא — תיקון-שרשרת חד-פעמי יכול להחזיק-את-המנעול-הגלובלי-לכל-אורך-
//      הכתיבה-מחדש, ואף-append לא-יוכל-להתחבר-באמצע.
const g = globalThis as unknown as { __fabricLedgerAppendQueue?: Promise<unknown> }

// ריצה-בתוך-המנעול-הגלובלי-המשותף (תור-יחיד בכל-התהליך, בכל-ה-bundles)
export function appendSlot<T>(job: () => Promise<T>): Promise<T> {
  const prev = g.__fabricLedgerAppendQueue ?? Promise.resolve()
  const run = prev.then(job, job) // רץ-גם-אם-קודם-נכשל — התור-לא-קורס
  g.__fabricLedgerAppendQueue = run.catch(() => undefined) // כישלון-הקורא-לא-מזהם-את-התור
  return run
}

const APPEND_RETRIES = 6

// Task-122 (אירוע-חי 07:58:20, רשומה-חתומה-חסרה): פעימת-גיט החליפה-את-קובץ-ה-db תחת-האפליקציה
// בדיוק-בעת-חתימת-סבב-selftest כושל — appendLedger זרק שגיאת-חיבור חולפת (לא-Unique) והסבב
// נשאר בלי-רשומה בשרשרת (הדוח-נאטם, החתימה-לא). מעתה: שגיאות-חולפות (חיבור/מאגר/נעילה)
// מנוסות-שוב בגבול-זמן צנוע (~12ש' — החיבור-מחדש-של-הלב מגיע-בתוכו), כל-ניסיון קורא-ראש-טרייה
// (חוק UNIQUE(prev) שומר at-most-once בתוך-השרשרת), וכל-כתיבה-מוצלחת מאומתת-בקריאה-חוזרת
// (חוק-קריאה-חוזרת): כתיבה-שנבלעה-בקובץ-יתום (inode-חלוף שקט) לא-תימצא-בקריאה-החוזרת
// ותיחשב-כישלון-חולף — הניסיון-הבא ייחתם-על-הקובץ-הקנוני. כשל-מתמשך = זריקה-כנה-רגילה.
const TRANSIENT_DB_ERROR =
  /reach database server|connection pool|closed the connection|database (is )?locked|SQLITE_BUSY|SQLITE_READONLY|prepared statement|Cannot fetch data from database/

const RESILIENT_RETRIES = 4
const RESILIENT_BACKOFF_MS = [2_000, 3_000, 4_000, 4_000]

export function appendLedger(
  rec: Omit<LedgerRecord, 'prev'>,
  opts?: { batchId?: string }
): Promise<LedgerEntry> {
  return appendSlot(async (): Promise<LedgerEntry> => {
    // retry: בין-תהליכים UNIQUE(prev) עשוי לדחות-כותב-מאוחר (אפליקציה-שנייה-רגעית).
    // התור-המקומי אינו-רואה-את-הזר — רק-המסד. קריאת-ראש-טרייה+חישוב-מחדש = תיקון-עצמי.
    let lastErr: unknown = null
    for (let attempt = 0; attempt <= APPEND_RETRIES; attempt++) {
      try {
        const last = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
        const full: LedgerRecord = { ...rec, prev: last?.hash ?? GENESIS }
        const hash = ledgerHash(full)
        return await db.ledgerEntry.create({ data: { ...full, hash, batchId: opts?.batchId ?? null } })
      } catch (e) {
        lastErr = e
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.includes('Unique constraint')) throw e // אינו-מזלג — כישלון-אמיתי, עולה
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)))
      }
    }
    throw lastErr
  })
}

// חתימה-עמידה (Task-122): אותו-חוזה כמו appendLedger, אך סובלנית-לשגיאות-חולפות
// ומאמתת-כל-חתימה בקריאה-חוזרת. לשימוש-בחותמים-הקריטיים (selftest/drill) — שסבב-כושל
// לא-יישאר-אף-פעם בלי-רשומה בשרשרת בגלל חלון-החלפת-db של פעימת-הגיט.
export async function appendLedgerResilient(
  rec: Omit<LedgerRecord, 'prev'>,
  opts?: { batchId?: string }
): Promise<LedgerEntry> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt <= RESILIENT_RETRIES; attempt++) {
    try {
      const created = await appendLedger(rec, opts)
      // קריאה-חוזרת: הרשומה-חייבת-להימצא-בקריאה-טרייה (מגלה כתיבה-שנבלעה בקובץ-יתום)
      const readBack = await db.ledgerEntry.findUnique({ where: { id: created.id } })
      if (readBack && readBack.hash === created.hash) return readBack
      lastErr = new Error(
        `read-back failed: record ${created.id} not confirmed on canonical file`
      )
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      // Unique(prev) מטופל-בפנים-על-ידי appendLedger; כאן מטופלים רק-חולפים
      if (!TRANSIENT_DB_ERROR.test(msg) && !msg.includes('read-back failed')) throw e
    }
    if (attempt < RESILIENT_RETRIES) {
      await new Promise((r) => setTimeout(r, RESILIENT_BACKOFF_MS[attempt]))
    }
  }
  throw lastErr
}
