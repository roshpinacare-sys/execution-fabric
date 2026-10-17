import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  proposeAndQueueEvolutionTask,
  proposeLearningTask,
  findUnaddressedHighFindings,
  evolutionBudgetUsed,
  EVOLUTION_BUDGET_PER_HOUR,
} from '@/lib/evolution'

// לופ-ההתפתחות-העצמית (worklog Task 26) + לולאת-הלמידה (worklog Task 28):
// POST = מחזור-אמת אחד (ירי-LLM → ולידציה → שיגור לתור הרגיל). גוף-רשותי: {"mode":"auto"|"propose"|"learn"}.
//   auto   (ברירת-מחדל) — למידה-ראשונה: אם-יש ממצא-HIGH לא-מטופל מביקורת-עצמית אחרונה → מחזור-למידה;
//          אחרת → הצעה-עצמית רגילה. הלב (עורק-ג) קורא כאן בלי-גוף — ומקבל-את-הפעולה-הבעלת-ערך-הגבוה-ביותר.
//   propose — הצעה-עצמית בלבד (מצב-אמת → הצעה; יעד-ריפו רשותי עם אימות-חי).
//   learn   — למידה בלבד; אין ממצא-HIGH לא-מטופל = 404 כן (nothing-to-learn) — לא מומצאת-עבודה.
// תקציב-שעתי כן משותף לשני-המקורות (evolution+learning): 6/שעה — מעבר 429 כן.
// GET  = היסטוריית-המחזורים-העצמיים + תקציב + ספירות (שני-המקורות). הצגת-עצמי מלאה, אפס-הסתרה.

type Mode = 'auto' | 'propose' | 'learn'

const SELF_SOURCES = ['evolution', 'learning']

export async function POST(req: Request) {
  let mode: Mode = 'auto'
  try {
    const body = (await req.json()) as { mode?: string } | null
    if (body && (body.mode === 'propose' || body.mode === 'learn' || body.mode === 'auto')) {
      mode = body.mode
    }
  } catch {
    /* אין-גוף / לא-JSON — ברירת-מחדל auto (כך קורא הלב) */
  }

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

  // auto: הרשת מחליטה-בעצמה — ממצא-HIGH פתוח? → למידה (הפעולה-הבעלת-ערך-הגבוה-ביותר)
  if (mode === 'auto') {
    const highs = await findUnaddressedHighFindings()
    mode = highs.length > 0 ? 'learn' : 'propose'
  }

  let r
  if (mode === 'learn') {
    const highs = await findUnaddressedHighFindings()
    if (highs.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'nothing-to-learn: אין ממצאי-HIGH לא-מטופלים בביקורות האחרונות (48h) — כנות, לא המצאת-עבודה',
          errorClass: 'nothing-to-learn',
          highFindingsOpen: 0,
        },
        { status: 404 }
      )
    }
    r = await proposeLearningTask(highs[0])
  } else {
    r = await proposeAndQueueEvolutionTask()
  }

  if (!r.ok) {
    return NextResponse.json(
      {
        ok: false,
        mode,
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
      mode,
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
      where: { source: { in: SELF_SOURCES } },
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
        source: true,
        repo: true,
      },
    }),
    evolutionBudgetUsed(),
  ])

  const [total, done, failed, queued, learning, highOpen] = await Promise.all([
    db.task.count({ where: { source: { in: SELF_SOURCES } } }),
    db.task.count({ where: { source: { in: SELF_SOURCES }, status: 'DONE' } }),
    db.task.count({ where: { source: { in: SELF_SOURCES }, status: 'FAILED' } }),
    db.task.count({ where: { source: { in: SELF_SOURCES }, status: 'QUEUED' } }),
    db.task.count({ where: { source: 'learning' } }),
    findUnaddressedHighFindings().then((f) => f.length),
  ])

  return NextResponse.json({
    ok: true,
    budget: { used, cap: EVOLUTION_BUDGET_PER_HOUR },
    counts: { total, done, failed, queued, learning },
    highFindingsOpen,
    recent,
  })
}
