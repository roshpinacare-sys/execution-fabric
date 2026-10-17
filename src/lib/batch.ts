import { createHash, randomBytes } from 'crypto'
import { z } from 'zod'
import { db } from '@/lib/db'
import { appendLedger } from '@/lib/ledger'
import { executeTaskOnce } from '@/lib/executor'
import { TASK_KINDS } from '@/lib/llm-chain'
import { verifyRepo, ghErrorClass, ghErrorMessage } from '@/lib/github'

// אצווה מקבילית בצד-השרת (worklog Task 24) — השער-התכנות של רשת-הביצוע:
// הארכיטקטורה והריבונות שולחות N משימות בשיגור אחד, השרת מנקז אותן בעצמו
// (בלי תלות בדפדפן-פתוח), כל משימה = ירי-LLM אמיתי או כשל-כן חתום בשרשרת.
//
// כנות: drainBatch חותם רשומת-BATCH מסכמת רק כשהאצווה כולה טרמינלית.
// אם נגמר-הזמן ויש עדיין משימות בתור/רצות — אין רשומה מסכמת (לא ממציאים סיום).

export const BATCH_MAX_TASKS = 8
export const BATCH_MAX_PARALLEL = 4
const DRAIN_TIMEOUT_MS = 6 * 60_000
const GLOBAL_INFLIGHT_CAP = 8

export const batchTaskInputSchema = z.object({
  kind: z.enum(TASK_KINDS),
  title: z.string().min(3).max(120),
  prompt: z.string().min(10).max(4000),
  repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
})

export const batchInputSchema = z.union([
  // מצב-א: רשימת-משימות מפורשת (הצרכן-התכנותי המלא)
  z.object({
    tasks: z.array(batchTaskInputSchema).min(1).max(BATCH_MAX_TASKS),
    parallel: z.number().int().min(1).max(BATCH_MAX_PARALLEL).optional(),
  }),
  // מצב-ב: קיצור — אותה משימה ב-N מופעים (מספור #1..#N)
  z.object({
    kind: z.enum(TASK_KINDS),
    title: z.string().min(3).max(120),
    prompt: z.string().min(10).max(4000),
    repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).optional(),
    count: z.number().int().min(1).max(BATCH_MAX_TASKS),
    parallel: z.number().int().min(1).max(BATCH_MAX_PARALLEL).optional(),
  }),
])

export type BatchInput = z.infer<typeof batchInputSchema>
export type BatchTaskSpec = { kind: string; title: string; prompt: string; repo: string | null }

export function newBatchId(): string {
  return randomBytes(6).toString('hex') // 12 hex — מזהה-ניווט קצר
}

// אימות-חי לכל ריפו ייחודי — לפני יצירת-משימות (כמו /api/tasks: כשל כן, בלי תקוות-שווא)
export async function verifyBatchRepos(specs: BatchTaskSpec[]): Promise<void> {
  const repos = [...new Set(specs.map((s) => s.repo).filter((r): r is string => !!r))]
  for (const repo of repos) {
    try {
      await verifyRepo(repo)
    } catch (e) {
      const cls = ghErrorClass(e)
      const err = new Error(
        cls === 'repo-not-found'
          ? `repo-not-found: הריפו ${repo} לא נמצא בארגון (אימות-חי מול GitHub: 404)`
          : `github-auth/rate: אימות-הריפו ${repo} נכשל (${cls ?? 'provider'}) — ${ghErrorMessage(e)}`
      )
      throw err
    }
  }
}

export interface CreatedBatch {
  batchId: string
  parallel: number
  created: { id: string; title: string; kind: string; repo: string | null }[]
}

export async function createBatch(specs: BatchTaskSpec[], parallel: number): Promise<CreatedBatch> {
  const batchId = newBatchId()
  const created = []
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const task = await db.task.create({
      data: {
        title: specs.length > 1 ? `${s.title} #${i + 1}` : s.title,
        kind: s.kind,
        prompt: s.prompt,
        repo: s.repo,
        batchId,
      },
    })
    created.push({ id: task.id, title: task.title, kind: task.kind, repo: task.repo })
  }
  return { batchId, parallel, created }
}

// ---- מנקז-צד-השרת ----

// שמירה-עצמית בזיכרון: מנקז אחד לכל אצווה (מול-תהליך יחיד; מול ריבוי-תהליכים ה-claim האטומי הוא קו-ההגנה)
const activeDrains = new Set<string>()

// שער-עומס גלובלי: מגביל יריות-LLM במקביל מכל-האצוות יחד
let globalInFlight = 0
async function withGlobalSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (globalInFlight >= GLOBAL_INFLIGHT_CAP) {
    await new Promise((r) => setTimeout(r, 500))
  }
  globalInFlight++
  try {
    return await fn()
  } finally {
    globalInFlight--
  }
}

export interface DrainOutcome {
  terminal: boolean
  done: number
  failed: number
  pending: number
  summaryHash: string | null
}

export async function drainBatch(batchId: string, parallel = 3): Promise<DrainOutcome> {
  if (activeDrains.has(batchId)) {
    return { terminal: false, done: 0, failed: 0, pending: -1, summaryHash: null }
  }
  activeDrains.add(batchId)
  const t0 = Date.now()
  try {
    for (;;) {
      if (Date.now() - t0 > DRAIN_TIMEOUT_MS) {
        console.error(`saos.batch.drain_timeout batch=${batchId} elapsedMs=${Date.now() - t0}`)
        return { terminal: false, done: 0, failed: 0, pending: -1, summaryHash: null } // אין סיום מדומה
      }
      const queued = await db.task.findMany({
        where: { batchId, status: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        take: parallel,
        select: { id: true },
      })
      if (queued.length === 0) {
        const running = await db.task.count({ where: { batchId, status: 'RUNNING' } })
        if (running === 0) break // האצווה טרמינלית (כולל משימות שנקטפו מחוץ-למנקז — לא נתבעות כפול)
        await new Promise((r) => setTimeout(r, 1000))
        continue
      }
      // סבב מקבילי — claim אטומי בתוך executeTaskOnce מונע כפל-מול עובד-הדפדפן
      await Promise.all(
        queued.map((t) =>
          withGlobalSlot(() => executeTaskOnce(t.id)).catch((e) => {
            console.error(`saos.batch.task_threw batch=${batchId} taskId=${t.id} err=${e instanceof Error ? e.message : String(e)}`)
          })
        )
      )
    }

    const tasks = await db.task.findMany({
      where: { batchId },
      select: { id: true, status: true, attempts: true, errorClass: true },
    })
    const done = tasks.filter((t) => t.status === 'DONE').length
    const failed = tasks.filter((t) => t.status === 'FAILED').length
    const pending = tasks.length - done - failed
    if (pending > 0 || tasks.length === 0) {
      // לא טרמינלי (למשל פג-זמן בדיוק בין-סבבים) — בלי רשומה מסכמת
      return { terminal: false, done, failed, pending, summaryHash: null }
    }

    // קבלת-האצווה: outputHash = sha256 של סיכום קנוני; errorClass כן ("X/Y-failed") כשיש כשלים
    const allDone = failed === 0
    const summaryPayload = JSON.stringify({
      batchId,
      total: tasks.length,
      done,
      failed,
      status: allDone ? 'DONE' : 'FAILED',
    })
    const entry = await appendLedger(
      {
        taskId: null,
        kind: 'BATCH',
        status: allDone ? 'DONE' : 'FAILED',
        worker: 'batch-drain',
        attempts: tasks.reduce((a, t) => a + t.attempts, 0),
        durationMs: Date.now() - t0,
        errorClass: allDone ? null : `${failed}/${tasks.length}-failed`,
        outputHash: createHash('sha256').update(summaryPayload).digest('hex').slice(0, 32),
      },
      { batchId }
    )
    console.error(
      `saos.batch.drained batch=${batchId} total=${tasks.length} done=${done} failed=${failed} summarySeq=#${entry.id}`
    )
    return { terminal: true, done, failed, pending: 0, summaryHash: entry.hash }
  } finally {
    activeDrains.delete(batchId)
  }
}
