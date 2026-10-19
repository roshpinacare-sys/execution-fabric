import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { buildMetricsStreamed } from '@/lib/metrics'

// מדדי-הרשת (worklog Task 26) — הרשת מדווחת על עצמה מהדאטה-בלבד:
// אימות-שרשרת fail-closed + פילוחי-יעילות אמת (סוגים/עובדים/מחלקות-שגיאה/סולם/תור/מוצא).
// אפס-השערות: כל מספר כאן נגזר מה-DB בזמן-בקשה.
//
// Task 76 (מחזור-חדשנות #9): ההיסטוריה — המסלול-טען-את-כל-שורות-השרשרת בכל-קריאה והריץ-את-
// האגרגציות-ב-JS (ה-O(n)-האחרון-שנותר). מעתה: buildMetricsStreamed — אימות-מלא-מה-Genesis
// בקריאה-בדפים + כל-האגרגציות-ב-SQL; מבנה-ה-JSON-נשמר-ביט-ביט; זיכרון O(דף)+O(קרדינליות).

export async function GET() {
  const m = await buildMetricsStreamed()

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
      total: m.total,
      done: m.done,
      failed: m.failed,
      verify: m.verify,
      byKind: m.byKind,
      avgByKind: m.avgByKind,
      errorClasses: m.errorClasses,
      ladder: m.ladder,
    },
    queue: { queued: queueQueued, running: queueRunning },
    tasks: {
      total: tasksTotal,
      fromEvolution: tasksEvolution,
      fromLearning: tasksLearning,
      fromHuman: tasksHuman,
    },
    workers: m.workers,
  })
}
