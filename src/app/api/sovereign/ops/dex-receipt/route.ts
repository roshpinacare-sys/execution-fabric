import { NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { appendLedgerResilient } from '@/lib/ledger'

// Task-135 (מנדט-הבעלים §2/§5): "logged directly to the fleet-economy hash-chain".
// ערוץ-הסליקה-הרשמי של האיברים: כל-החלפה/סגירת-חוזה נחתמת-קבלה-hash-linked-על-
// שרשרת-האמת. שער-סמכות-איברים (דפוס-organ-auth): x-saos-organ מול upload/organ-token.
// קבלה-כפולה אינה-מזלגת: UNIQUE(prev) + התור-הגלובלי של appendLedger שומרים-סדר.

export const dynamic = 'force-dynamic'

const ORGAN_TOKEN_PATH = join(process.cwd(), 'upload', 'organ-token')
const MAX_RECEIPTS = 50

function organAuthed(req: Request): boolean {
  try {
    if (!existsSync(ORGAN_TOKEN_PATH)) return false
    const expected = createHash('sha256').update(readFileSync(ORGAN_TOKEN_PATH, 'utf8').trim()).digest()
    const given = req.headers.get('x-saos-organ') ?? ''
    if (!given) return false
    return timingSafeEqual(expected, createHash('sha256').update(given).digest())
  } catch {
    return false
  }
}

interface ReceiptIn {
  kind?: unknown
  status?: unknown
  attempts?: unknown
  durationMs?: unknown
  errorClass?: unknown
  outputHash?: unknown
}

export async function POST(req: Request) {
  if (!organAuthed(req)) {
    return NextResponse.json({ ok: false, error: 'organ-auth-required' }, { status: 401 })
  }
  const body = (await req.json().catch(() => null)) as { worker?: unknown; receipts?: unknown } | null
  if (!body || typeof body.worker !== 'string' || body.worker.length === 0 || body.worker.length > 120) {
    return NextResponse.json({ ok: false, error: 'worker-required (≤120-chars)' }, { status: 400 })
  }
  const list = Array.isArray(body.receipts) ? (body.receipts as ReceiptIn[]) : []
  if (list.length === 0 || list.length > MAX_RECEIPTS) {
    return NextResponse.json({ ok: false, error: `receipts-1..${MAX_RECEIPTS}-required` }, { status: 400 })
  }
  const appended: Array<{ kind: string; id: number; hash: string }> = []
  const rejected: Array<{ index: number; reason: string }> = []
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const kind = typeof r.kind === 'string' ? r.kind : ''
    const status = typeof r.status === 'string' ? r.status : ''
    const outputHash = typeof r.outputHash === 'string' ? r.outputHash : ''
    if (!kind || kind.length > 60) {
      rejected.push({ index: i, reason: 'kind-required (≤60-chars)' })
      continue
    }
    if (!status || status.length > 40) {
      rejected.push({ index: i, reason: 'status-required (≤40-chars)' })
      continue
    }
    if (!/^[0-9a-f]{64}$/.test(outputHash)) {
      rejected.push({ index: i, reason: 'outputHash-must-be-sha256-hex-64' })
      continue
    }
    const attempts = Number.isFinite(Number(r.attempts)) ? Math.max(1, Math.round(Number(r.attempts))) : 1
    const durationMs = Number.isFinite(Number(r.durationMs)) ? Math.max(0, Math.round(Number(r.durationMs))) : 0
    const errorClass = typeof r.errorClass === 'string' && r.errorClass.length <= 120 ? r.errorClass : null
    try {
      const entry = await appendLedgerResilient({
        taskId: null,
        kind: `dex:${kind}`,
        status,
        worker: body.worker,
        attempts,
        durationMs,
        errorClass,
        outputHash,
      })
      appended.push({ kind, id: entry.id, hash: entry.hash })
    } catch (e) {
      rejected.push({ index: i, reason: `append-failed: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}` })
    }
  }
  const head = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
  return NextResponse.json({
    ok: appended.length > 0,
    appended: appended.length,
    appendedList: appended,
    rejected,
    chainHead: head?.hash ?? null,
    at: new Date().toISOString(),
  })
}
