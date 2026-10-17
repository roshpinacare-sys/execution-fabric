import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { runTaskChain, type TaskKind } from '@/lib/llm-chain'
import { buildRepoContext, renderRepoContext, ghErrorClass, ghErrorMessage } from '@/lib/github'

// המבצע-האמיתי (Task 23 — ריפקטור מ-run-route לשימוש-משותף):
// claim אטומי RUNNING → (יעד-ריפו? הקשר-חי מ-GitHub) → סולם-מועמדים חי
// → כתיבת תוצאה → חתימה בשרשרת. אין פלט מדומה: או תוצר מאומת או FAILED עם errorClass כן.
// משמש גם ידנית (כפתור-הרץ) וגם עובד-הרקע (tick).

// משימה-תקועה ב-RUNNING מעל 10 דקות (למשל הפסקת-שרת באמצע-ירי) ניתנת-לתביעה-מחדש — כמו-שער-ההעברה.
const STALE_RUNNING_MS = 10 * 60_000

export interface ExecuteResult {
  claimed: boolean
  executed: boolean
  status?: string
  errorClass?: string | null
  error?: string | null
  note?: string
}

export async function executeTaskOnce(id: string): Promise<ExecuteResult> {
  const task = await db.task.findUnique({ where: { id } })
  if (!task) {
    return { claimed: false, executed: false }
  }

  // claim אטומי — מונע הרצה כפולה; ריצה-תקועה מעל-10-דקות נחשבת-מתה ונתבעת-מחדש
  const claim = await db.task.updateMany({
    where: {
      id,
      OR: [
        { status: { not: 'RUNNING' } },
        { status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      ],
    },
    data: { status: 'RUNNING', error: null, errorClass: null },
  })
  if (claim.count === 0) {
    return { claimed: false, executed: false }
  }

  // יעד-ריפו: משיכת-הקשר חי אמיתית. כשל-גיטהאב = כשל-כן חתום-בשרשרת (בלי ירי-LLM שווא)
  let context: string | null = null
  if (task.repo) {
    try {
      const ctx = await buildRepoContext(task.repo)
      context = renderRepoContext(ctx)
    } catch (e) {
      const errorClass = ghErrorClass(e) ?? 'provider'
      const error = ghErrorMessage(e)
      await db.task.update({
        where: { id },
        data: {
          status: 'FAILED',
          worker: 'github-context',
          error,
          errorClass,
          attempts: 0,
          durationMs: 0,
        },
      })
      await appendLedger({
        taskId: id,
        kind: task.kind,
        status: 'FAILED',
        worker: 'github-context',
        attempts: 0,
        durationMs: 0,
        errorClass,
        outputHash: sha256Short(''),
      })
      return { claimed: true, executed: false, status: 'FAILED', errorClass, error, note: 'כשל-הקשר: לא ירה LLM בכנות' }
    }
  }

  const result = await runTaskChain(
    task.kind as TaskKind,
    task.title,
    task.prompt,
    context ? { context } : undefined
  )

  if (result.ok) {
    await db.task.update({
      where: { id },
      data: {
        status: 'DONE',
        worker: result.worker,
        output: JSON.stringify(result.output),
        attempts: result.attempts,
        durationMs: result.durationMs,
        error: null,
        errorClass: null,
      },
    })
    await appendLedger({
      taskId: id,
      kind: task.kind,
      status: 'DONE',
      worker: result.worker,
      attempts: result.attempts,
      durationMs: result.durationMs,
      errorClass: null,
      outputHash: result.outputHash,
    })
    return { claimed: true, executed: true, status: 'DONE' }
  }

  await db.task.update({
    where: { id },
    data: {
      status: 'FAILED',
      worker: 'exhausted',
      error: result.error,
      errorClass: result.errorClass,
      attempts: result.attempts,
      durationMs: result.durationMs,
    },
  })
  await appendLedger({
    taskId: id,
    kind: task.kind,
    status: 'FAILED',
    worker: 'exhausted',
    attempts: result.attempts,
    durationMs: result.durationMs,
    errorClass: result.errorClass,
    outputHash: sha256Short(''),
  })
  return { claimed: true, executed: false, status: 'FAILED', errorClass: result.errorClass, error: result.error }
}
