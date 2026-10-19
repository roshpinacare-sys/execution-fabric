// מחזור-חדשנות #13 (Task 80): מקור-שחזור-שלישי מגוון-פורמט — ייצוא-JSONL של-השרשרת לגיט.
//
// הפער-הכן-שנסגר: שני-מקורות-השחזור-הקיימים (clone-גיט מ-#8, תמונה-שעתית מ-#11) נגזרים-
// שניהם-מאותו-ארטיפקט-פיזי — קובץ-SQLite אחד. פגיעה-לוגית-בקובץ-עצמו (מיגרציה-רעה,
// כתיבה-סוררת, חצי-כתיבה-שנדחפה-בפעימה-האוטומטית) הייתה-מועתקת-נאמנה לשני-המקורות —
// העד-היה-זועק-אך-השחזור-היה-משיב-את-הפגיעה. הייצוא: **טקסט-חתום, קריא-אדם, מחוץ-
// ל-SQLite-כליל** — כל-שורה נושאת-את-מלוא-הרשומה-הקנונית+hash, והתרגיל-מחשב-מחדש-
// את-כל-שרשרת-ה-hash מה-Genesis בזיכרון, בלי-מנוע-DB, בלי-עותק-עבודה.
//
// יתרון-היסטוריית-הגיט: הקובץ-append-only-בלבד (אף-שכתוב-אף-פעם) — קובץ-פגום-היום
// אינו-יכול-לשחוק-את-הייצוא-שנחתם-אתמול; סנכרון-מאמת-את-כל-הקידומת-הקיימת-מול-
// הייצור לפני-הוספת-זנב, וכל-סתירה = כשל-כן-חתום (export-diverges-at-N), לא-תיקון-שקט.
//
// חוק-ה-workpath: הנתיב-נגזר-מ-process.cwd() — sovereign/chain-export/ledger.jsonl
// בתוך-העץ (כמו sovereign/site/), נקרא-בלבד; הלב-מכניס-אותו-לגיט-בפעימת-הדופק.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, open, stat, type FileHandle } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import path from 'node:path'
import type { LedgerEntry } from '@prisma/client'
import { db } from '@/lib/db'
import { GENESIS, ledgerHash } from '@/lib/ledger'

export const EXPORT_PATH = path.join(process.cwd(), 'sovereign', 'chain-export', 'ledger.jsonl')

// שורת-הייצוא: הרשומה-הקנונית (המוטבעת-ב-hash) + מטא שאינו-מוטבע (id, createdAt).
// ה-id-חיוני לתרגיל (רצף-ללא-פערים) ולהצלבת-הקידומת; createdAt לקריאות-אדם.
export interface ExportLine {
  id: number
  taskId: string | null
  kind: string
  status: string
  worker: string
  attempts: number
  durationMs: number
  errorClass: string | null
  outputHash: string
  prev: string
  hash: string
  createdAt: string
}

export function exportLineFromEntry(e: LedgerEntry): string {
  const line: ExportLine = {
    id: e.id,
    taskId: e.taskId,
    kind: e.kind,
    status: e.status,
    worker: e.worker,
    attempts: e.attempts,
    durationMs: e.durationMs,
    errorClass: e.errorClass,
    outputHash: e.outputHash,
    prev: e.prev,
    hash: e.hash,
    createdAt: e.createdAt.toISOString(),
  }
  return JSON.stringify(line)
}

export interface ChainExportResult {
  ok: boolean
  fileExisted: boolean
  fileLines: number // שורות-קיימות-שנאותו-והוצלבו-מול-הייצור
  appended: number // שורות-שנוספו (הזנב-החסר)
  exportedTotal: number // אורך-הקובץ-אחרי-הסנכרון
  fileBytes: number
  errorClass?: string
  error?: string
}

// זרם-הייצור בסדר-id — cursor-pagination, אותו-דגם-אמונים של-#7 (מה-Genesis, בלי-דלתא,
// בלי-checkpoint): זיכרון-חסום-ב-O(מנת-דף) גם-בשרשרת-צומחת-לנצח.
async function* productionEntries(): AsyncGenerator<LedgerEntry> {
  const PAGE = 500
  let cursorId: number | undefined
  let exhausted = false
  while (!exhausted) {
    const page = await db.ledgerEntry.findMany({
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursorId !== undefined ? { cursor: { id: cursorId }, skip: 1 } : {}),
    })
    if (page.length === 0) return
    for (const e of page) yield e
    if (page.length < PAGE) exhausted = true
    cursorId = page[page.length - 1].id
  }
}

// סנכרון-append-only: שני-זרמים-בנעילה (קובץ-שורה-שורה מול-ייצור-דף-דף):
// - כל-שורה-קיימת-חייבת-להסכים-ביט-ביט עם-רשומת-הייצור-באותו-id — סתירה = export-diverges-at-N
//   (אף-שכתוב-אף-פעם: סתירה-היא-עדות-לפגיעה, לא-דבר-לתקן-בשקט).
// - הזנב-החסר (רשומות-הייצור-שנולדו-אחרי-הייצוא-האחרון) מצורף-דף-דף — זיכרון-חסום.
// - הקובץ-הקדים-את-הייצור = export-ahead-of-production (הייצור-הוא-סמכות-האמת).
export async function syncChainExport(): Promise<ChainExportResult> {
  const fileExisted = existsSync(EXPORT_PATH)
  const startedFileBytes = fileExisted ? (await stat(EXPORT_PATH)).size : 0
  let fileLines = 0
  let appended = 0
  let handle: FileHandle | null = null
  try {
    await mkdir(path.dirname(EXPORT_PATH), { recursive: true })
    const rl = fileExisted
      ? createInterface({ input: createReadStream(EXPORT_PATH, 'utf8'), crlfDelay: Infinity })
      : null
    const lineIter = rl ? rl[Symbol.asyncIterator]() : null
    const prod = productionEntries()
    for (;;) {
      const dbEntry = (await prod.next()).value as LedgerEntry | undefined
      const fileRes = lineIter ? await lineIter.next() : { done: true, value: undefined }
      const fileLine: string | undefined = fileRes.done ? undefined : (fileRes.value as string)

      if (dbEntry === undefined) {
        if (fileLine !== undefined) throw new Error('export-ahead-of-production')
        break // שני-הזרמים-אזלו — הקובץ-מסונכרן-במלואו
      }
      if (fileLine === undefined) {
        // זנב-חסר: מצרף-דף-דף-עד-אזלת-הייצור
        if (!handle) handle = await open(EXPORT_PATH, 'a')
        await handle.write(exportLineFromEntry(dbEntry) + '\n')
        appended++
        continue
      }
      fileLines++
      let parsed: ExportLine
      try {
        parsed = JSON.parse(fileLine) as ExportLine
      } catch {
        throw new Error(`export-corrupt-line-${fileLines}`)
      }
      if (parsed.id !== dbEntry.id || parsed.hash !== dbEntry.hash) {
        throw new Error(`export-diverges-at-${dbEntry.id}`)
      }
    }
    const fileBytes = (await stat(EXPORT_PATH)).size
    return {
      ok: true,
      fileExisted,
      fileLines,
      appended,
      exportedTotal: fileLines + appended,
      fileBytes,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const errorClass = msg.startsWith('export-ahead')
      ? 'export-ahead-of-production'
      : msg.startsWith('export-diverges')
        ? 'export-diverges'
        : msg.startsWith('export-corrupt')
          ? 'export-corrupt-line'
          : 'export-io'
    return {
      ok: false,
      fileExisted,
      fileLines,
      appended, // שורות-שהספיקו-להיכתב-לפני-הכשל — הכתיבה-עצמה-append-only-ולכן-בטוחה
      exportedTotal: fileLines + appended,
      fileBytes: startedFileBytes,
      errorClass,
      error: msg,
    }
  } finally {
    await handle?.close()
  }
}

// אימות-המקור-השלישי-בזיכרון: כל-השרשרת-מה-Genesis — רצף-id-ללא-פערים, קישוריות-prev,
// וחישוב-מחדש של-כל-hash (ledgerHash הקנוני). בלי-Prisma, בלי-SQLite, בלי-עותק-עבודה —
// טקסט-בזרימה. זה-ההבדל-האמיתי-משני-המקורות-האחרים: שחזור-שרשרת-האמת-מטקסט-בלבד.
// זריקות-בטרמינולוגיה-המאוחדת של-מחזור-#11 (copy-*) כדי-שהסיווג-בשרשרת-יישאר-קנון-אחד.
export async function verifyExportStream(): Promise<{ verified: number; total: number; head: string }> {
  if (!existsSync(EXPORT_PATH)) throw new Error('export-missing')
  const rl = createInterface({ input: createReadStream(EXPORT_PATH, 'utf8'), crlfDelay: Infinity })
  let prev = GENESIS
  let verified = 0
  let lineNo = 0
  for await (const raw of rl) {
    lineNo++
    let parsed: ExportLine
    try {
      parsed = JSON.parse(raw) as ExportLine
    } catch {
      throw new Error(`export-corrupt-line-${lineNo}`)
    }
    verified++
    if (parsed.id !== verified) throw new Error(`export-gap-at-${lineNo}`)
    if (parsed.prev !== prev) throw new Error(`copy-chain-broken-at-${parsed.id}`)
    const rec = {
      taskId: parsed.taskId,
      kind: parsed.kind,
      status: parsed.status,
      worker: parsed.worker,
      attempts: parsed.attempts,
      durationMs: parsed.durationMs,
      errorClass: parsed.errorClass,
      outputHash: parsed.outputHash,
      prev: parsed.prev,
    }
    if (parsed.hash !== ledgerHash(rec)) throw new Error(`copy-chain-broken-at-${parsed.id}`)
    prev = parsed.hash
  }
  return { verified, total: verified, head: verified > 0 ? prev : GENESIS }
}

// תקציר-קובץ-זול (stat-בלבד) לשער-הקריאה-ולתצוגה — אפס-קריאת-תוכן.
export function exportFileBrief(): { exists: boolean; bytes: number; mtimeMs: number | null } {
  try {
    const s = statSync(EXPORT_PATH)
    return { exists: true, bytes: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return { exists: false, bytes: 0, mtimeMs: null }
  }
}
