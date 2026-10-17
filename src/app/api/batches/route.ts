import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  batchInputSchema,
  createBatch,
  drainBatch,
  verifyBatchRepos,
  type BatchTaskSpec,
} from '@/lib/batch'

// שער-האצוות (worklog Task 24) — הנקודה-שבה הארכיטקטורה והריבונות שולחות עבודה:
// POST = שיגור N משימות + ניקוז-צד-שרת נדלק ברקע (תשובה מיידית — לא ממתינה לסיום).
// GET = אצוות אחרונות עם התקדמות.

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  const parsed = batchInputSchema.safeParse(body)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    return NextResponse.json({ ok: false, error: `קלט-אצווה לא תקין: ${issues}` }, { status: 400 })
  }

  const input = parsed.data
  const parallel = input.parallel ?? 3
  const specs: BatchTaskSpec[] =
    'tasks' in input
      ? input.tasks.map((t) => ({ kind: t.kind, title: t.title, prompt: t.prompt, repo: t.repo ?? null }))
      : Array.from({ length: input.count }, () => ({
          kind: input.kind,
          title: input.title,
          prompt: input.prompt,
          repo: input.repo ?? null,
        }))

  // אימות-חי של ריפו-יעדים לפני יצירה — כשל = כל-האצווה נדחית, לא נבראות משימות
  try {
    await verifyBatchRepos(specs)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg.startsWith('repo-not-found') ? 400 : 502
    return NextResponse.json(
      { ok: false, error: `אימות-הריפו נכשל — האצווה לא נשלחה בכנות: ${msg}` },
      { status }
    )
  }

  const batch = await createBatch(specs, parallel)
  // ניקוז ברקע — fire-and-forget: התשובה מידית, הביצוע חי (או כשל-כן חתום)
  void drainBatch(batch.batchId, parallel).catch((e) => {
    console.error(`saos.batch.drain_crashed batch=${batch.batchId} err=${e instanceof Error ? e.message : String(e)}`)
  })

  return NextResponse.json(
    { ok: true, batchId: batch.batchId, parallel, created: batch.created },
    { status: 201 }
  )
}

export async function GET() {
  const tasks = await db.task.findMany({
    where: { batchId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 400,
    select: { batchId: true, status: true, kind: true, createdAt: true },
  })
  // קיבוץ לפי batchId — 8 האחרונות (לפי משימת-השיגור המאוחרת)
  const map = new Map<
    string,
    { batchId: string; total: number; done: number; failed: number; pending: number; kinds: string[]; createdAt: string }
  >()
  for (const t of tasks) {
    if (!t.batchId) continue
    let b = map.get(t.batchId)
    if (!b) {
      b = { batchId: t.batchId, total: 0, done: 0, failed: 0, pending: 0, kinds: [], createdAt: t.createdAt.toISOString() }
      map.set(t.batchId, b)
    }
    b.total++
    if (t.status === 'DONE') b.done++
    else if (t.status === 'FAILED') b.failed++
    else b.pending++
    if (!b.kinds.includes(t.kind)) b.kinds.push(t.kind)
    if (t.createdAt.toISOString() > b.createdAt) b.createdAt = t.createdAt.toISOString()
  }
  const batches = [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 8)
  // קבלות-מסכמות כשקיימות (קישור-ניווט batchId בלדג'ר)
  const summaries = await db.ledgerEntry.findMany({
    where: { batchId: { in: batches.map((b) => b.batchId) } },
    orderBy: { id: 'desc' },
    select: { batchId: true, hash: true, status: true },
  })
  const summaryByBatch = new Map(summaries.map((s) => [s.batchId, { hash: s.hash, status: s.status }]))
  return NextResponse.json({
    ok: true,
    batches: batches.map((b) => ({ ...b, summary: summaryByBatch.get(b.batchId) ?? null })),
  })
}
