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
export async function appendLedger(
  rec: Omit<LedgerRecord, 'prev'>,
  opts?: { batchId?: string }
): Promise<LedgerEntry> {
  const last = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
  const full: LedgerRecord = { ...rec, prev: last?.hash ?? GENESIS }
  const hash = ledgerHash(full)
  return db.ledgerEntry.create({ data: { ...full, hash, batchId: opts?.batchId ?? null } })
}
