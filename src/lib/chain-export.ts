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
import { GENESIS, ledgerHash, verifyChainStreamed } from '@/lib/ledger'

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

// מחזור-רפואה-חי (2026-10-20): שחזור-קנוני-גלוי של-הייצוא אחרי-סתירה.
//
// הלקח-החי: תרגיל-ההתאוששות-הידני (03:38) כתב-את-הייצוא-בסריאליזציה-עצמאית —
// לא-דרך-הכותב-הקנוני — והזנב-יצא-פגום (export-diverges-at-1357). חוק-ה-append-only
// צודק ואינו-מרפא: העורק-מסרב-לגעת-לנצח-בקובץ-שנפגע. מעתה קיים-שער-רפואה-יחיד:
//
//  · מותר-לרוץ רק-כשהייצור-עצמו מאומת-במלואו (verifyChainStreamed ok) — הייצור-הוא-
//    סמכות-האמת; אין-שחזור-מתוך-ייצוא-פגום-לתוך-ייצור-בריא.
//  · מותר-לרוץ רק-כשהייצוא-באמת-סותר (בדיקה-מוקדמת) — בריא-אינו-נוגעים-בו.
//  · הכתיבה: קובץ-זמני → rename אטומי; כל-שורה מהכותב-הקנוני exportLineFromEntry
//    (הלקח-המבני: **אף-סריאליזציה-עצמאית-אף-פעם** — מקור-אחד-לאמת-הטקסט).
//  · ההוכחה: אימות-זרימה-מלא של-הקובץ-החדש (ChainVerifier) + ראש==ראש-הייצור.
//  · הכנות: תקלה-באמצע = הקובץ-הישן-נשאר-על-הדיסק (rename אטומי בסוף-בלבד);
//    הסתירה-המקורית-נשארת-בהיסטוריית-הגיט (הקובץ-הפגום-נדחף-בפעימות-קודמות).
//  · החתימה: רשות-הקורא חותמת-רשומת-REPAIR בשרשרת (כדפוס-תיקון-המזלג-1045).
export interface ChainExportRebuildResult {
  ok: boolean
  reason?: string
  divergedAt?: number
  rebuilt: number
  verifiedAfter?: { verified: number; head: string }
  head: string
  bytes: number
  durationMs: number
  at: string
  errorClass?: string
}

// אסימון-האישור-נגזר-מראש-הייצור-החי: רק-מי-שקורא-עכשיו-את-הראש-האמיתי יכול-לבקש-רפואה.
export async function chainExportRebuildConfirm(confirm: string | null): Promise<boolean> {
  const head = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } })
  return !!head && confirm === `export-rebuild-${head.hash.slice(0, 12)}`
}

export async function rebuildChainExport(): Promise<ChainExportRebuildResult> {
  const t0 = Date.now()
  const at = new Date().toISOString()
  const fail = async (reason: string, errorClass: string, divergedAt?: number) => ({
    ok: false, reason, errorClass, divergedAt, rebuilt: 0,
    head: (await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } }))?.hash ?? GENESIS,
    bytes: 0, durationMs: Date.now() - t0, at,
  })
  // 1) הייצור-חייב-להיות-מאומת-במלואו — אין-רפואה-על-גבי-אמת-פגומה.
  const v = await verifyChainStreamed()
  if (!v.ok) return fail(`production-broken-at-${v.brokenAt}`, 'production-not-verified', v.brokenAt)
  // 2) הייצוא-חייב-להיות-באמת-סותר — בריא-אינו-נוגעים.
  const probe = await syncChainExport()
  if (probe.ok) {
    return { ok: false, reason: 'export-healthy-no-rebuild', errorClass: 'no-op', rebuilt: 0,
      head: v.head, bytes: probe.fileBytes, durationMs: Date.now() - t0, at }
  }
  if (probe.errorClass !== 'export-diverges' && probe.errorClass !== 'export-corrupt-line') {
    return fail(`export-not-diverged: ${probe.errorClass ?? probe.error}`, 'not-diverged-state')
  }
  const divergedAt = Number(/at-(\d+)/.exec(probe.error ?? '')?.[1] ?? 0) || undefined
  // 3) בנייה-קנונית לקובץ-זמני → אימות-עצמי → rename אטומי.
  const tmp = `${EXPORT_PATH}.rebuild-${process.pid}`
  try {
    const h = await open(tmp, 'w')
    let n = 0
    try {
      for await (const e of productionEntries()) {
        await h.write(exportLineFromEntry(e) + '\n')
        n++
      }
    } finally {
      await h.close()
    }
    const self = await verifyJsonlStream(tmp, 'export')
    if (self.verified !== n || (v.total > 0 && self.head !== v.head)) {
      throw new Error(`rebuild-self-check-failed verified:${self.verified}/${n} head:${self.head} prod:${v.head}`)
    }
    await import('node:fs/promises').then((m) => m.rename(tmp, EXPORT_PATH))
    const bytes = (await stat(EXPORT_PATH)).size
    return { ok: true, divergedAt, rebuilt: n, verifiedAfter: { verified: self.verified, head: self.head },
      head: self.head, bytes, durationMs: Date.now() - t0, at }
  } catch (e) {
    await import('node:fs/promises').then((m) => m.rm(tmp, { force: true }).catch(() => undefined))
    const msg = e instanceof Error ? e.message : String(e)
    return fail(msg, 'rebuild-io', divergedAt)
  }
}

// אימות-המקור-השלישי-בזיכרון: כל-השרשרת-מה-Genesis — רצף-id-ללא-פערים, קישוריות-prev,
// וחישוב-מחדש של-כל-hash (ledgerHash הקנוני). בלי-Prisma, בלי-SQLite, בלי-עותק-עבודה —
// טקסט-בזרימה. זה-ההבדל-האמיתי-משני-המקורות-האחרים: שחזור-שרשרת-האמת-מטקסט-בלבד.
// זריקות-בטרמינולוגיה-המאוחדת של-מחזור-#11 (copy-*) כדי-שהסיווג-בשרשרת-יישאר-קנון-אחד.
//
// מחזור-חדשנות #14 (Task 81): כלל-האמת-חולץ-למחלקה-קנונית אחת (ChainVerifier) — הייצוא-החי
// וההיסטוריה-החתומה (תרגיל-האטימות) שני-צרכנים-של-אותו-כלל-בדיוק. אפס-שכפול-קוד-שעלול-
// לסטות (הלקח-הכפול-מ-#13: מימוש-כפול-שסוטה = שתי-אמיתות).
export class ChainVerifier {
  private prev = GENESIS
  private verified = 0
  private lineNo = 0
  constructor(private readonly label: 'export' | 'history') {}

  // שורה-אחת-קנונית: parse → רצף → prev → חישוב-מחדש-של-ה-hash. זריקה = פגיעה-חתומה.
  consume(raw: string): void {
    this.lineNo++
    let parsed: ExportLine
    try {
      parsed = JSON.parse(raw) as ExportLine
    } catch {
      throw new Error(`${this.label}-corrupt-line-${this.lineNo}`)
    }
    this.verified++
    if (parsed.id !== this.verified) throw new Error(`${this.label}-gap-at-${this.lineNo}`)
    if (parsed.prev !== this.prev) throw new Error(`copy-chain-broken-at-${parsed.id}`)
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
    this.prev = parsed.hash
  }

  finish(): { verified: number; total: number; head: string } {
    return { verified: this.verified, total: this.verified, head: this.verified > 0 ? this.prev : GENESIS }
  }
}

// אימות-זרימה-על-קובץ-JSONL (הייצוא-החי או-היסטוריה-שהוקרנה-לקובץ-זמני): O(1) זיכרון.
export async function verifyJsonlStream(
  filePath: string,
  label: 'export' | 'history' = 'export'
): Promise<{ verified: number; total: number; head: string }> {
  if (!existsSync(filePath)) throw new Error(`${label}-missing`)
  const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity })
  const v = new ChainVerifier(label)
  for await (const raw of rl) v.consume(raw)
  return v.finish()
}

export async function verifyExportStream(): Promise<{ verified: number; total: number; head: string }> {
  return verifyJsonlStream(EXPORT_PATH, 'export')
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
