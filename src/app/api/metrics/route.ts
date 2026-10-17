import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyChain } from '@/lib/ledger'

// מדדי-הרשת (worklog Task 26) — הרשת מדווחת על עצמה מהדאטה-בלבד:
// אימות-שרשרת fail-closed + פילוחי-יעילות אמת (סוגים/עובדים/מחלקות-שגיאה/סולם/תור/מוצא).
// אפס-השערות: כל מספר כאן נגזר מה-DB בזמן-בקשה.

export async function GET() {
  const entries = await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })
  const verification = verifyChain(entries)

  const [total, done, failed] = [
    entries.length,
    entries.filter((e) => e.status === 'DONE').length,
    entries.filter((e) => e.status === 'FAILED').length,
  ]

  const groupCount = <K extends keyof (typeof entries)[number]>(key: K): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const e of entries) {
      const k = String(e[key] ?? 'unknown')
      out[k] = (out[k] ?? 0) + 1
    }
    return out
  }

  const byKind = groupCount('kind')
  const errorClasses: Record<string, number> = {}
  for (const e of entries) {
    if (e.errorClass) errorClasses[e.errorClass] = (errorClasses[e.errorClass] ?? 0) + 1
  }

  const doneEntries = entries.filter((e) => e.status === 'DONE')
  const workerMap = new Map<string, { shots: number; totalMs: number }>()
  for (const e of doneEntries) {
    const prev = workerMap.get(e.worker) ?? { shots: 0, totalMs: 0 }
    workerMap.set(e.worker, { shots: prev.shots + 1, totalMs: prev.totalMs + e.durationMs })
  }
  const workers = [...workerMap.entries()]
    .map(([name, v]) => ({ name, shots: v.shots, avgMs: Math.round(v.totalMs / v.shots) }))
    .sort((a, b) => b.shots - a.shots)

  const ladderActivations = entries.filter((e) => e.attempts > 1).length
  const firstTry = doneEntries.filter((e) => e.attempts === 1).length

  const avgByKind = Object.keys(byKind)
    .map((kind) => {
      const ds = doneEntries.filter((e) => e.kind === kind)
      return {
        kind,
        done: ds.length,
        avgMs: ds.length ? Math.round(ds.reduce((s, e) => s + e.durationMs, 0) / ds.length) : null,
      }
    })
    .sort((a, b) => b.done - a.done)

  const [queueQueued, queueRunning] = await Promise.all([
    db.task.count({ where: { status: 'QUEUED' } }),
    db.task.count({ where: { status: 'RUNNING' } }),
  ])

  const [tasksTotal, tasksEvolution, tasksLearning, tasksHuman] = await Promise.all([
    db.task.count(),
    db.task.count({ where: { source: 'evolution' } }),
    db.task.count({ where: { source: 'learning' } }), // Task 28: לולאת-הלמידה — מוצא-עצמי שני
    db.task.count({ where: { source: null } }),
  ])

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    ledger: {
      total,
      done,
      failed,
      verify: verification,
      byKind,
      avgByKind,
      errorClasses,
      ladder: {
        firstTry,
        activations: ladderActivations,
        activationRatePct: doneEntries.length
          ? Math.round((ladderActivations / entries.length) * 1000) / 10
          : 0,
      },
    },
    queue: { queued: queueQueued, running: queueRunning },
    tasks: {
      total: tasksTotal,
      fromEvolution: tasksEvolution,
      fromLearning: tasksLearning,
      fromHuman: tasksHuman,
    },
    workers,
  })
}
