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
let appendQueue: Promise<unknown> = Promise.resolve()

export function appendLedger(
  rec: Omit<LedgerRecord, 'prev'>,
  opts?: { batchId?: string }
): Promise<LedgerEntry> {
  const run = async (): Promise<LedgerEntry> => {
    const last = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
    const full: LedgerRecord = { ...rec, prev: last?.hash ?? GENESIS }
    const hash = ledgerHash(full)
    return db.ledgerEntry.create({ data: { ...full, hash, batchId: opts?.batchId ?? null } })
  }
  const p = appendQueue.then(run, run) // רץ-גם-אם-קודם-נכשל — התור-לא-קורס
  appendQueue = p.catch(() => undefined) // הכישלון-של-הקורא-לא-מזהם-את-התור
  return p
}
