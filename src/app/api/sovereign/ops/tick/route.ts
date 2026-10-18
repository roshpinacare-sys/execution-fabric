import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { extractArtifact } from '@/lib/handoff'
import { reviewArtifact } from '@/lib/review-policy'
import { evolutionBudgetUsed, EVOLUTION_BUDGET_PER_HOUR } from '@/lib/evolution'

// טיק-ריבונות (Task 43): POST /api/sovereign/ops/tick
// סריקה → פסק-דין (חוק review-policy) → פעולה אמיתית דרך השער הקיים
// (approve+execute עם כל-השערים שלהם: סריקת-סודות, אכיפת-hash, נתיבים-חדשים-בלבד,
// read-back) → חתימת-שרשרת AUDIT. הסף-לא-יורד-גם-כשהבעלים-ישן.

export const dynamic = 'force-dynamic'

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

    // הפעולה דרך השער הקיים — הטיק לא מקצר-דרך ולא מקל על הסף
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
