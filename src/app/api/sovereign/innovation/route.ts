import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { runInnovationCycle } from '@/lib/innovation'

// מסילת-החדשנות (Task 60): POST מריץ מחזור-חדשנות אמיתי —
// מדידת קו-בסיס → אופטימיזציה → הוכחת-שקילות → מדידה → חתימת INNOVATION בשרשרת.
// GET גוזר את היסטוריית-החדשנות מהשרשרת עצמה (אפס-טבלה-חדשה, אפס-מונים).

export const dynamic = 'force-dynamic'

export async function GET() {
  const entries = await db.ledgerEntry.findMany({
    where: { kind: 'INNOVATION' },
    orderBy: { id: 'desc' },
    take: 20,
    select: { id: true, worker: true, durationMs: true, outputHash: true, createdAt: true },
  })
  return NextResponse.json({
    ok: true,
    innovationEntries: entries.length,
    recent: entries.map((e) => ({
      id: e.id,
      worker: e.worker,
      durationMs: e.durationMs,
      outputHash: e.outputHash,
      at: e.createdAt.toISOString(),
    })),
  })
}

export async function POST(req: NextRequest) {
  const m = await runInnovationCycle()

  // אם-השקילות-לא-הוכחה — זה כשל-כן (fail-closed): נרשם FAILED, לא נחגוג שיפור.
  const status = m.equivalenceProven ? 'DONE' : 'FAILED'

  const entry = await appendLedger({
    taskId: null,
    kind: 'INNOVATION',
    status,
    worker: 'innovation-cycle',
    attempts: 1,
    durationMs: Math.round((m.baseline.minMs + m.fullFast.minMs + m.delta.minMs) * 1000),
    errorClass: m.equivalenceProven ? null : 'equivalence-mismatch',
    // ההוכחה עצמה: המדידה הקנונית — שינוי-במדידה = hash אחר = ניכר
    outputHash: sha256Short(
      JSON.stringify({
        chainEntries: m.chainEntries,
        runs: m.runs,
        baselineMinMs: m.baseline.minMs,
        fullFastMinMs: m.fullFast.minMs,
        deltaMinMs: m.delta.minMs,
        deltaChecked: m.delta.checkedEntries,
        speedupFullFast: m.speedupFullFast,
        speedupDelta: m.speedupDelta,
        equivalenceProven: m.equivalenceProven,
        adoptionScope: m.adoptionScope,
      })
    ),
  })

  return NextResponse.json({ ok: true, status, measurement: m, ledgerEntryId: entry.id })
}
