// תיקון-שרשרת חד-פעמי וחתום (Task 86 — אירוע-המזלג החי של 2026-10-19 18:27:43)
//
// מה-שקרה (פורנזיה מלאה): שלושת-התרגילים שירדו-באותו-tick מהלב נחתמו-במקביל-דרך שלושה-
// עותקי-bundle של Next.js dev (Turbopack) — לכל-עותק תור-append משלו → שתי-רשומות (1044
// drill:docs, 1045 drill:history) נולדו-באותה-מילישנייה עם אותו-prev (hash של 1043) → מזלג.
// verifyChain-הקנוני: הקידומת-עד-1044 מאומתת; הזנב-מ-1045 שבור-לנצח (prev אינו-ראש-המאומת).
//
// עקרונות-התיקון (נגזרים מחוקי-המערכת):
//  1. אפס-גע בקידומת המאומתת (1..brokenAt-1) — היא-העדות-הקנונית; תרגיל-ההיסטוריות
//     (הקומיט-העתיק-של-הייצוא) והצלבת-הייצוא-החי תלויים-בה-ביט-ביט.
//  2. הזנב (brokenAt..head) נכתב-מחדש בחישוב-טורי: prev(ראשון-הזנב) := ראש-הקידומת-המאומת,
//     וכל-hash נגזר-מחדש. התוכן (kind/status/worker/outputHash/createdAt/id) נשמר-ביט-ביט —
//     מה-שמתוקן-הוא-הקישוריות, לא-העדות.
//  3. הייצוא-החי (ledger.jsonl) מושלם-בהתאם — מה-Genesis-עד-הקידומת נשמר-בייט-בייט, הזנב
//     נכתב-מהמצב-המתוקן. היסטוריית-הגיט-של-הקובץ שומרת-לנצח את-מצב-המזלג — אפס-שכתוב-שקט.
//  4. אירוע-התיקון עצמו נחתם-בשרשרת (AUDIT/chain-repair) עם-כל-הראיות: brokenAt,
//     stored/expected prev, ההשים-המקוריים-של-הענף-המפולג, ספירת-הזנב-שנכתב-מחדש, הראש-החדש.
//  5. הכל-תחת-המנעול-הגלובלי (appendSlot) — אף-append לא-יוכל-להתחבר-באמצע-הכתיבה-מחדש.
//  6. Idempotent: אימות-מקדים-חייב-להיות-שבור, ואחר-הצלחה כל-קריאה-נוספת = no-op-כן.
import { rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { db } from '@/lib/db'
import { appendSlot, ledgerHash, sha256Short, verifyChainStreamed, type LedgerRecord } from '@/lib/ledger'
import { EXPORT_PATH, exportLineFromEntry, type ExportLine } from '@/lib/chain-export'

export interface ChainRepairResult {
  ok: boolean
  noOp?: boolean
  reason?: string
  brokenAt?: number
  verifiedPrefix?: number
  tailRewritten?: number
  verifiedAfter?: { ok: boolean; head: string; brokenAt: number | null; verified: number; total: number }
  exportRewritten?: boolean
  evidenceSha?: string
  repairLedgerId?: number
  durationMs?: number
  at: string
}

const CONFIRM = 'repair-fork-1045'

export function chainRepairConfirmMatches(token: string | null): boolean {
  return token === CONFIRM
}

// כתיבת-הייצוא-מחדש מהמצב-המתוקן: הקידומת-בייט-בייט מהקובץ-הקיים, הזנב-מהייצור.
async function rewriteExportTail(brokenAt: number): Promise<number> {
  if (!existsSync(EXPORT_PATH)) return 0
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(EXPORT_PATH, 'utf8')
  const lines = raw.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const kept: string[] = []
  let idCursor = 0
  for (const line of lines) {
    let parsed: ExportLine
    try {
      parsed = JSON.parse(line) as ExportLine
    } catch {
      break // שורה-פגומה — הקידומת-היא-מה-שלפניה; הזנב-יבנה-מהייצור
    }
    if (parsed.id !== idCursor + 1) break // פער — עצירה-בגבול-הקידומת-התקינה
    idCursor = parsed.id
    if (parsed.id >= brokenAt) break // כאן-מתחיל-הזנב-שנכתב-מהייצור-המתוקן
    kept.push(line)
  }
  const tailRows = await db.ledgerEntry.findMany({
    where: { id: { gte: Math.max(brokenAt, idCursor + 1) } },
    orderBy: { id: 'asc' },
  })
  const rebuilt = [...kept, ...tailRows.map(exportLineFromEntry)].join('\n') + '\n'
  const tmp = `${EXPORT_PATH}.repair-${Date.now()}.tmp`
  await writeFile(tmp, rebuilt, 'utf8')
  await rename(tmp, EXPORT_PATH)
  return tailRows.length
}

export async function runChainRepair(): Promise<ChainRepairResult> {
  const started = Date.now()
  const at0 = new Date().toISOString()
  return appendSlot(async (): Promise<ChainRepairResult> => {
    // 0. אם-השרשרת-תקינה — אין-מה-לתקן (idempotent-כן)
    const before = await verifyChainStreamed()
    if (before.ok) {
      return { ok: true, noOp: true, reason: 'chain already fully verified', verifiedAfter: before, at: at0 }
    }
    if (before.brokenAt === null || before.verified === 0) {
      return { ok: false, reason: `unexpected verify state brokenAt=${before.brokenAt} verified=${before.verified}`, at: at0 }
    }
    const brokenAt = before.brokenAt
    const expectedPrev = before.head // ראש-הקידומת-המאומת

    // 1. הזנב-המפורק — מהשבירה ועד-הראש
    const tail = await db.ledgerEntry.findMany({
      where: { id: { gte: brokenAt } },
      orderBy: { id: 'asc' },
    })
    if (tail.length === 0) {
      return { ok: false, reason: `no tail rows found at ${brokenAt}`, at: at0 }
    }

    // 2. חישוב-הזנב-המתוקן (טורי — כל-hash מהקודם) + ראיות-המזלג
    let prev = expectedPrev
    const repairs: { id: number; prev: string; hash: string }[] = []
    const originalFork: { id: number; storedPrev: string; storedHash: string } | null =
      tail.length > 0 ? { id: tail[0].id, storedPrev: tail[0].prev, storedHash: tail[0].hash } : null
    for (const row of tail) {
      const rec: LedgerRecord = {
        taskId: row.taskId,
        kind: row.kind,
        status: row.status,
        worker: row.worker,
        attempts: row.attempts,
        durationMs: row.durationMs,
        errorClass: row.errorClass,
        outputHash: row.outputHash,
        prev,
      }
      const hash = ledgerHash(rec)
      repairs.push({ id: row.id, prev, hash })
      prev = hash
    }
    const newHead = prev

    // 3. כתיבה-אטומית של-הזנב-המתוקן
    await db.$transaction(
      repairs.map((r) =>
        db.ledgerEntry.update({ where: { id: r.id }, data: { prev: r.prev, hash: r.hash } })
      )
    )

    // 4. אימות-מלא-אחרי-הכתיבה — חייב-לעבור-מה-Genesis-ועד-הראש
    const after = await verifyChainStreamed()
    if (!after.ok) {
      return {
        ok: false,
        reason: `post-repair verify failed at ${after.brokenAt}`,
        brokenAt,
        verifiedPrefix: before.verified,
        verifiedAfter: after,
        at: at0,
      }
    }

    // 5. הייצוא-החי מושלם-בהתאם (קידומת-בייט-בייט, זנב-מהייצור-המתוקן)
    let exportRewritten = false
    try {
      const tailRows = await rewriteExportTail(brokenAt)
      exportRewritten = tailRows > 0
    } catch {
      exportRewritten = false // יישאר-חתום-בהמשך-על-ידי-הסנכרון-הרגיל
    }

    // 6. חתימת-אירוע-התיקון-בשרשרת עצמה (עדיין-תחת-המנעול)
    const evidence = {
      event: 'chain-fork-repair',
      brokenAt,
      verifiedPrefix: before.verified,
      expectedPrev,
      fork: originalFork,
      tailRewritten: repairs.length,
      verifiedAfter: { ok: after.ok, head: after.head, verified: after.verified, total: after.total },
      causeClass: 'concurrent-append-cross-bundle',
      fixedIn: 'ledger-globalThis-queue+unique-prev',
      at: at0,
    }
    const evidenceSha = sha256Short(JSON.stringify(evidence))
    const last = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
    const repairRec: LedgerRecord = {
      taskId: null,
      kind: 'AUDIT',
      status: 'DONE',
      worker: 'chain-repair',
      attempts: 1,
      durationMs: Date.now() - started,
      errorClass: null,
      outputHash: evidenceSha,
      prev: last?.hash ?? 'GENESIS',
    }
    const entry = await db.ledgerEntry.create({
      data: { ...repairRec, hash: ledgerHash(repairRec), batchId: null },
    })

    return {
      ok: true,
      brokenAt,
      verifiedPrefix: before.verified,
      tailRewritten: repairs.length,
      verifiedAfter: after,
      exportRewritten,
      evidenceSha,
      repairLedgerId: entry.id,
      durationMs: Date.now() - started,
      at: entry.createdAt.toISOString(),
    }
  })
}
