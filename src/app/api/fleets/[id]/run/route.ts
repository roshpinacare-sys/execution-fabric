import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import {
  runContractChain,
  runTaskChain,
  type ChainCandidate,
  callLlm,
  type TaskKind,
  withContractFeedback,
} from '@/lib/llm-chain'
import { nvidiaChat, nvidiaConfigured } from '@/lib/providers'
import {
  FLEET_SYNTHESIS_COMPACT,
  FLEET_SYNTHESIS_SYSTEM,
  fleetSynthesisSchema,
  fleetWorkerSchema,
  buildSynthesisUserPrompt,
  buildWorkerUserPrompt,
  lensPrimarySystem,
  type FleetLens,
} from '@/lib/fleet'

// הרצת-צי (worklog Task 15):
// 1. claim אטומי של השורש נגד הרצה-כפולה.
// 2. כל העדשות שאינן DONE נתבעות ונורות במקביל אמיתי (Promise.allSettled) — כל אחת עם סולם-מועמדים מלא.
// 3. כל עדשה נכתבת מיד כשהיא מסתיימת (הלוח רואה את המקביליות חי).
// 4. אחרי-כיבוי-כל-העדשות: חתימות-שרשרת בטור (מניעת-מירוץ prev/head).
// 5. סינתזה ע"י מנהל-הצי — מקבלת רק תוצרי-עובדים מאומתים, נחתמת kind=FLEET.
// 6. אפס עדשות DONE → כשל כן. אף פלט לא מומצא.

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const root = await db.task.findUnique({ where: { id } })
  if (!root || root.role !== 'fleet-root') {
    return NextResponse.json({ ok: false, error: 'צי לא נמצא' }, { status: 404 })
  }

  // claim אטומי של השורש
  const claim = await db.task.updateMany({
    where: { id, status: { not: 'RUNNING' } },
    data: { status: 'RUNNING', error: null, errorClass: null },
  })
  if (claim.count === 0) {
    return NextResponse.json({ ok: false, error: 'הצי כבר רץ כרגע' }, { status: 409 })
  }

  const t0 = Date.now()
  const children = await db.task.findMany({
    where: { parentId: id, role: 'worker' },
    orderBy: { createdAt: 'asc' },
  })
  if (children.length === 0) {
    await db.task.update({
      where: { id },
      data: {
        status: 'FAILED',
        worker: 'exhausted',
        error: 'לצי אין עדשות — אין מה לבצע',
        errorClass: 'empty-output',
      },
    })
    await appendLedger({
      taskId: id,
      kind: 'FLEET',
      status: 'FAILED',
      worker: 'exhausted',
      attempts: 0,
      durationMs: Date.now() - t0,
      errorClass: 'empty-output',
      outputHash: sha256Short(''),
    })
    const failed = await db.task.findUnique({ where: { id } })
    return NextResponse.json({ ok: true, root: failed, children: [], executed: false })
  }

  // עדשות להרצה: כל מה שאינו DONE (ניצול עדשות-DONE קיימות בהרצה-חוזרת)
  const toRun = children.filter((c) => c.status !== 'DONE')
  const claimed: string[] = []
  for (const c of toRun) {
    const cClaim = await db.task.updateMany({
      where: { id: c.id, status: { not: 'RUNNING' } },
      data: { status: 'RUNNING', error: null, errorClass: null },
    })
    if (cClaim.count > 0) claimed.push(c.id)
  }

  // ירי מקבילי אמיתי — כל עדשה כותבת את עצמה מיד כשהיא מסתיימת
  const childResults = new Map<
    string,
    { ok: boolean; worker: string; attempts: number; durationMs: number; errorClass: string | null; outputHash: string; output: unknown }
  >()

  await Promise.allSettled(
    children.map(async (child) => {
      if (!claimed.includes(child.id)) return // DONE קיים או נתבע ע"י הרצה אחרת
      const res = await runTaskChain(
        child.kind as TaskKind,
        child.title,
        child.prompt,
        { primarySystem: lensPrimarySystem(child.lens as FleetLens) }
      )
      if (res.ok) {
        await db.task.update({
          where: { id: child.id },
          data: {
            status: 'DONE',
            worker: res.worker,
            output: JSON.stringify(res.output),
            attempts: res.attempts,
            durationMs: res.durationMs,
            error: null,
            errorClass: null,
          },
        })
      } else {
        await db.task.update({
          where: { id: child.id },
          data: {
            status: 'FAILED',
            worker: 'exhausted',
            error: res.error,
            errorClass: res.errorClass,
            attempts: res.attempts,
            durationMs: res.durationMs,
          },
        })
      }
      childResults.set(child.id, {
        ok: res.ok,
        worker: res.ok ? res.worker : 'exhausted',
        attempts: res.attempts,
        durationMs: res.durationMs,
        errorClass: res.ok ? null : res.errorClass,
        outputHash: res.ok ? res.outputHash : sha256Short(''),
        output: res.ok ? res.output : null,
      })
    })
  )

  // עדשות-DONE מהרצה-קודמת: שימוש-חוזר מאומת (ולידציה מחדש מול חוזה-AUDIT)
  for (const child of children) {
    if (claimed.includes(child.id)) continue
    if (child.status !== 'DONE' || !child.output) continue
    try {
      const parsed = JSON.parse(child.output)
      const revalidated = fleetWorkerSchema.safeParse(parsed)
      if (!revalidated.success) continue
      childResults.set(child.id, {
        ok: true,
        worker: child.worker ?? 'reused',
        attempts: child.attempts,
        durationMs: child.durationMs ?? 0,
        errorClass: null,
        outputHash: sha256Short(child.output),
        output: revalidated.data,
      })
    } catch {
      /* תוצר לא-ניתן-לשימוש — לא נכנס לסינתזה */
    }
  }

  // חתימות-שרשרת בטור — בסדר המקורי של העדשות
  for (const child of children) {
    const r = childResults.get(child.id)
    if (!r) continue
    await appendLedger({
      taskId: child.id,
      kind: child.kind,
      status: r.ok ? 'DONE' : 'FAILED',
      worker: r.worker,
      attempts: r.attempts,
      durationMs: r.durationMs,
      errorClass: r.errorClass,
      outputHash: r.outputHash,
    })
  }

  // איסוף תוצרי-עובדים מאומתים לסינתזה
  const workerResults = children
    .map((c) => {
      const r = childResults.get(c.id)
      return r?.ok ? { lens: c.lens as string, output: r.output } : null
    })
    .filter((x): x is { lens: string; output: unknown } => x !== null)

  if (workerResults.length === 0) {
    await db.task.update({
      where: { id },
      data: {
        status: 'FAILED',
        worker: 'exhausted',
        error: 'אף עדשה לא החזירה תוצר מאומת — אין חומר לסינתזה',
        errorClass: 'empty-output',
        attempts: 0,
        durationMs: Date.now() - t0,
      },
    })
    await appendLedger({
      taskId: id,
      kind: 'FLEET',
      status: 'FAILED',
      worker: 'exhausted',
      attempts: 0,
      durationMs: Date.now() - t0,
      errorClass: 'empty-output',
      outputHash: sha256Short(''),
    })
    const failed = await db.task.findUnique({ where: { id } })
    const fresh = await db.task.findMany({
      where: { parentId: id, role: 'worker' },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ ok: true, root: failed, children: fresh, executed: false })
  }

  // סינתזת-הקונסנזוס: מנהל-הצי בלבד, חומר מאומת בלבד — סולם רב-ספקי כמו המשימות
  const synthesisUserMsg = buildSynthesisUserPrompt(root.prompt, workerResults)
  const synthesisCandidates: ChainCandidate[] = [
    { name: 'zai-synthesis', call: (fb) => callLlm(FLEET_SYNTHESIS_SYSTEM, withContractFeedback(synthesisUserMsg, fb)) },
  ]
  if (nvidiaConfigured()) {
    synthesisCandidates.push({
      name: 'nvidia-synthesis',
      call: (fb) => nvidiaChat(FLEET_SYNTHESIS_SYSTEM, withContractFeedback(synthesisUserMsg, fb)),
    })
  }
  synthesisCandidates.push({
    name: 'zai-synthesis-compact-retry',
    call: (fb) => callLlm(FLEET_SYNTHESIS_COMPACT, withContractFeedback(synthesisUserMsg, fb)),
  })
  const synthesis = await runContractChain(
    synthesisUserMsg,
    synthesisCandidates,
    fleetSynthesisSchema
  )

  if (synthesis.ok) {
    await db.task.update({
      where: { id },
      data: {
        status: 'DONE',
        worker: synthesis.worker,
        output: JSON.stringify(synthesis.output),
        attempts: synthesis.attempts,
        durationMs: Date.now() - t0,
        error: null,
        errorClass: null,
      },
    })
    await appendLedger({
      taskId: id,
      kind: 'FLEET',
      status: 'DONE',
      worker: synthesis.worker,
      attempts: synthesis.attempts,
      durationMs: Date.now() - t0,
      errorClass: null,
      outputHash: synthesis.outputHash,
    })
  } else {
    await db.task.update({
      where: { id },
      data: {
        status: 'FAILED',
        worker: 'exhausted',
        error: synthesis.error,
        errorClass: synthesis.errorClass,
        attempts: synthesis.attempts,
        durationMs: Date.now() - t0,
      },
    })
    await appendLedger({
      taskId: id,
      kind: 'FLEET',
      status: 'FAILED',
      worker: 'exhausted',
      attempts: synthesis.attempts,
      durationMs: Date.now() - t0,
      errorClass: synthesis.errorClass,
      outputHash: sha256Short(''),
    })
  }

  const freshRoot = await db.task.findUnique({ where: { id } })
  const freshChildren = await db.task.findMany({
    where: { parentId: id, role: 'worker' },
    orderBy: { createdAt: 'asc' },
  })
  return NextResponse.json({
    ok: true,
    root: freshRoot,
    children: freshChildren,
    executed: synthesis.ok,
  })
}
