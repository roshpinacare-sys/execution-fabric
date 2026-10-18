import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short, verifyChain } from '@/lib/ledger'
import { extractArtifact } from '@/lib/handoff'
import { reviewArtifact } from '@/lib/review-policy'
import { evolutionBudgetUsed, EVOLUTION_BUDGET_PER_HOUR } from '@/lib/evolution'

// שער-התפעול-האוטונומי (Task 43): הדף לא רק-תצוגה-לבעלים — הוא משטח-תפעול-מלא
// לארכיטקטורה/הנדסה/ריבונות-האוטונומית עצמן.
//
//   GET  /api/sovereign/ops       → תמונת-מצב קריאה-למכונה: פסקי-דין חיים על כל-PROPOSED,
//                                    תקציב, שרשרת, היסטוריית-טיקים, מפת-פעולות מלאה.
//   POST /api/sovereign/ops/tick  → טיק-ריבונות: סריקה → פסק-דין → פעולה אמיתית
//                                    (approve+execute דרך השער הקיים עם כל-השערים שלו)
//                                    → חתימת-שרשרת AUDIT.
//
// הסף-לא-יורד: review-policy.ts הוא החוק. ביטחון מלא — אפס-דמו, אפס-קיצורי-דרך.

export const dynamic = 'force-dynamic'

export async function GET() {
  const t0 = Date.now()
  const [proposed, ticks, entries, budgetUsed, taskStats] = await Promise.all([
    db.handoff.findMany({ where: { status: 'PROPOSED' }, orderBy: { createdAt: 'asc' } }),
    db.ledgerEntry.findMany({
      where: { worker: 'sovereignty-ops-tick' },
      orderBy: { id: 'desc' },
      take: 8,
    }),
    db.ledgerEntry.findMany({ orderBy: { id: 'asc' } }),
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

  const chain = verifyChain(entries)
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

interface TickOutcome {
  id: string
  verdict: 'DELIVERABLE' | 'SUSPENDED' | 'SKIP'
  reasons: string[]
  approved: boolean
  executed: boolean
  status?: string
  commitSha?: string | null
  verified?: boolean | null
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const origin = req.nextUrl.origin

  const [proposed, budgetUsed] = await Promise.all([
    db.handoff.findMany({ where: { status: 'PROPOSED' }, orderBy: { createdAt: 'asc' } }),
    evolutionBudgetUsed(),
  ])
  const remaining = Math.max(0, EVOLUTION_BUDGET_PER_HOUR - budgetUsed)

  const outcomes: TickOutcome[] = []
  let deliverableSeen = 0

  for (const h of proposed) {
    const task = await db.task.findUnique({ where: { id: h.taskId } })
    const code = extractArtifact(task?.output ?? '', h.field)
    const v = reviewArtifact(code, h.artifactHash)

    if (!v.deliverable) {
      outcomes.push({
        id: h.id,
        verdict: 'SUSPENDED',
        reasons: v.reasons,
        approved: false,
        executed: false,
      })
      continue
    }

    // הסף-תקציב: אל-תרוקן את תקציב-ההתפתחות — השאר לפחות 1 ל-drill/חירום
    if (remaining - deliverableSeen <= 1) {
      outcomes.push({
        id: h.id,
        verdict: 'SKIP',
        reasons: ['budget-guard'],
        approved: false,
        executed: false,
      })
      continue
    }
    deliverableSeen += 1

    // הפעולה דרך השער הקיים — כל-השערים שלו נשמרים (סריקת-סודות, אכיפת-hash,
    // נתיבים-חדשים-בלבד, read-back). הטיק לא מקצר-דרך ולא מקל על הסף.
    const approveRes = await fetch(`${origin}/api/handoffs/${h.id}/approve`, {
      method: 'POST',
    })
    if (!approveRes.ok) {
      outcomes.push({
        id: h.id,
        verdict: 'SKIP',
        reasons: [`approve-failed:${approveRes.status}`],
        approved: false,
        executed: false,
      })
      continue
    }
    const executeRes = await fetch(`${origin}/api/handoffs/${h.id}/execute`, {
      method: 'POST',
    })
    const ej = (await executeRes.json().catch(() => ({}))) as {
      handoff?: { status: string; commitSha: string | null; verified: boolean | null }
    }
    outcomes.push({
      id: h.id,
      verdict: 'DELIVERABLE',
      reasons: [],
      approved: true,
      executed: executeRes.ok && ej.handoff?.status === 'DONE',
      status: ej.handoff?.status,
      commitSha: ej.handoff?.commitSha ?? null,
      verified: ej.handoff?.verified ?? null,
    })
  }

  const delivered = outcomes.filter((o) => o.executed).length
  const suspended = outcomes.filter((o) => o.verdict === 'SUSPENDED').length
  const skipped = outcomes.filter((o) => o.verdict === 'SKIP').length

  const report = {
    at: new Date().toISOString(),
    scanned: proposed.length,
    delivered,
    suspended,
    skipped,
    durationMs: Date.now() - t0,
    budgetRemaining: remaining - delivered,
  }

  // חתימת-שרשרת על הטיק עצמו — ההחלטות נשמרות לנצח (אפס-מחיקה)
  await appendLedger({
    taskId: null,
    kind: 'AUDIT',
    status: 'DONE',
    worker: 'sovereignty-ops-tick',
    attempts: 1,
    durationMs: report.durationMs,
    errorClass: null,
    outputHash: sha256Short(JSON.stringify({ report, outcomes })),
  })

  return NextResponse.json({ ok: true, tick: report, outcomes })
}
