import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  proposeAndQueueEvolutionTask,
  evolutionBudgetUsed,
  EVOLUTION_BUDGET_PER_HOUR,
} from '@/lib/evolution'

// לופ-התפתחות-עצמית (worklog Task 26):
// POST = מחזור-הצעה אחד אמיתי (מצב-אמת → ירי-LLM → ולידציה → שיגור לתור הרגיל).
//        תקציב-שעתי כן: 3 הצעות/שעה — מעבר לזה 429 כן (אין-עומס-סודי על הספקים).
// GET  = היסטוריית-ההצעות + תקציב + ספירות. הצגת-עצמי מלאה, אפס-הסתרה.

export async function POST() {
  const used = await evolutionBudgetUsed()
  if (used >= EVOLUTION_BUDGET_PER_HOUR) {
    return NextResponse.json(
      {
        ok: false,
        error: `budget: תקציב-ההתפתחות השעתי מוצה (${used}/${EVOLUTION_BUDGET_PER_HOUR}) — הפעימה-הבאה תנסה שוב`,
        errorClass: 'rate-limit',
        budget: { used, cap: EVOLUTION_BUDGET_PER_HOUR },
      },
      { status: 429 }
    )
  }

  const r = await proposeAndQueueEvolutionTask()
  if (!r.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: r.error,
        errorClass: r.errorClass,
        attempts: r.attempts,
        durationMs: r.durationMs,
      },
      { status: 502 }
    )
  }

  const usedAfter = await evolutionBudgetUsed()
  return NextResponse.json(
    {
      ok: true,
      taskId: r.taskId,
      proposal: r.proposal,
      worker: r.worker,
      attempts: r.attempts,
      durationMs: r.durationMs,
      budget: { used: usedAfter, cap: EVOLUTION_BUDGET_PER_HOUR },
    },
    { status: 201 }
  )
}

export async function GET() {
  const [recent, used] = await Promise.all([
    db.task.findMany({
      where: { source: 'evolution' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        kind: true,
        status: true,
        worker: true,
        errorClass: true,
        durationMs: true,
        createdAt: true,
      },
    }),
    evolutionBudgetUsed(),
  ])

  const [total, done, failed, queued] = await Promise.all([
    db.task.count({ where: { source: 'evolution' } }),
    db.task.count({ where: { source: 'evolution', status: 'DONE' } }),
    db.task.count({ where: { source: 'evolution', status: 'FAILED' } }),
    db.task.count({ where: { source: 'evolution', status: 'QUEUED' } }),
  ])

  return NextResponse.json({
    ok: true,
    budget: { used, cap: EVOLUTION_BUDGET_PER_HOUR },
    counts: { total, done, failed, queued },
    recent,
  })
}
