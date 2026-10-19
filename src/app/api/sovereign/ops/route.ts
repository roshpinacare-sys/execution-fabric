import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyChainStreamed } from '@/lib/ledger'
import { extractArtifact } from '@/lib/handoff'
import { reviewArtifact } from '@/lib/review-policy'
import { evolutionBudgetUsed, EVOLUTION_BUDGET_PER_HOUR } from '@/lib/evolution'

// שער-התפעול-האוטונומי (Task 43 + Task 45): הדף לא רק-תצוגה-לבעלים — הוא משטח-תפעול-מלא
// לארכיטקטורה/הנדסה/ריבונות-האוטונומית עצמן.
//
//   GET  /api/sovereign/ops       → תמונת-מצב קריאה-למכונה: פסקי-דין חיים על כל-PROPOSED,
//                                    תקציב, שרשרת, היסטוריית-טיקים, מפת-פעולות מלאה.
//
//   POST /api/sovereign/ops/tick  → הטיק-הריבונות חי בלבד ב ops/tick/route.ts
//                                    (Task 45: הסרת-היגיון-משוכפל — חוק-אחד, מקום-אחד).
//
// הסף-לא-יורד: review-policy.ts הוא החוק. ביטחון מלא — אפס-דמו, אפס-קיצורי-דרך.

export const dynamic = 'force-dynamic'

export async function GET() {
  const t0 = Date.now()
  const [proposed, ticks, verification, budgetUsed, taskStats] = await Promise.all([
    db.handoff.findMany({ where: { status: 'PROPOSED' }, orderBy: { createdAt: 'asc' } }),
    db.ledgerEntry.findMany({
      where: { worker: 'sovereignty-ops-tick' },
      orderBy: { id: 'desc' },
      take: 8,
    }),
    // מחזור-#10 (Task 77): ההיסטוריה — השער-טען-את-כל-השורות ואימת בטעינה-מלאה בכל-קריאה.
    // מעתה: אימות-מלא-מה-Genesis-בקריאה-בדפים — בלי-טעינת-שורות-שרשרת, בלי-אמון-טפילי.
    verifyChainStreamed(),
    evolutionBudgetUsed(),
    db.task.groupBy({ by: ['status'], _count: { _all: true } }),
  ])

  const verdicts = []
  for (const h of proposed) {
    const task = await db.task.findUnique({ where: { id: h.taskId } })
    const code = extractArtifact(task?.output ?? '', h.field)
    const v = reviewArtifact(code, h.artifactHash)
    verdicts.push({
      id: h.id,
      taskId: h.taskId,
      repo: h.repo,
      path: h.path,
      artifactHash: h.artifactHash,
      artifactSize: h.artifactSize,
      ageMs: Date.now() - h.createdAt.getTime(),
      verdict: v.deliverable ? 'DELIVERABLE' : 'SUSPENDED',
      reasons: v.reasons,
      actions: {
        approve: `POST /api/handoffs/${h.id}/approve`,
        execute: `POST /api/handoffs/${h.id}/execute`,
      },
    })
  }

  const chain = verification
  const remaining = Math.max(0, EVOLUTION_BUDGET_PER_HOUR - budgetUsed)

  return NextResponse.json({
    ok: true,
    ops: {
      generatedAt: new Date().toISOString(),
      computedMs: Date.now() - t0,
      machineContract: {
        description:
          'משטח-התפעול של האוטונומיה — כל-סוכן (ארכיטקטורה/הנדסה/ריבונות) מוזמן לקרוא ולפעול',
        snapshot: 'GET /api/sovereign/ops',
        autonomyTick: 'POST /api/sovereign/ops/tick',
        selftest: 'POST /api/sovereign/ops/selftest',
        handoffApprove: 'POST /api/handoffs/{id}/approve',
        handoffExecute: 'POST /api/handoffs/{id}/execute',
        improvementApply: 'POST /api/sovereign/improvements/{id}/apply',
        sitebuild: 'POST /api/sovereign/build',
        workerTick: 'POST /api/worker/tick',
        drill: 'POST /api/drill',
        dbReconnect: 'POST /api/admin/db-reconnect',
        census: 'GET /api/census',
      },
      reviewLaw: 'review-policy.ts — הסף-לא-יורד-גם-כשהבעלים-ישן',
      pending: {
        count: verdicts.length,
        deliverable: verdicts.filter((v) => v.verdict === 'DELIVERABLE').length,
        suspended: verdicts.filter((v) => v.verdict === 'SUSPENDED').length,
        verdicts,
      },
      budget: { used: budgetUsed, cap: EVOLUTION_BUDGET_PER_HOUR, remaining },
      chain: {
        total: chain.verified,
        ok: chain.ok,
        head: chain.head,
        brokenAt: chain.brokenAt,
      },
      tasks: Object.fromEntries(taskStats.map((s) => [s.status, s._count._all])),
      ticks: ticks.map((t) => ({
        id: t.id,
        status: t.status,
        outputHash: t.outputHash,
        errorClass: t.errorClass,
        createdAt: t.createdAt,
      })),
    },
  })
}
