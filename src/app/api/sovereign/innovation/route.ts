import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { runInnovationCycle, runCensusCycle, type CensusCycleMeasurement } from '@/lib/innovation'
import { runRestoreDrill, type RestoreDrillResult } from '@/lib/restore-drill'

// מסילת-החדשנות (Task 60): POST מריץ מחזור-חדשנות אמיתי —
// מדידת קו-בסיס → אופטימיזציה → הוכחת-שקילות → מדידה → חתימת INNOVATION בשרשרת.
// GET גוזר את היסטוריית-החדשנות מהשרשרת עצמה (אפס-טבלה-חדשה, אפס-מונים).
//
// Task 73 — מחזור-חדשנות #6, מסלול-שני: POST ?subject=witness — מדידת-העד החי
// (chain-witness :3050/bench): אימות-מלא-בזרימה מול טעינה-מלאה, שני-מימושים-בלתי-
// תלויים-שחייבים-להסכים. שקילות = אימוץ; מהירות = רישום-כן (הסיבה-לאימוץ: חסימות-זיכרון).
// Task 74 — מחזור-חדשנות #7: ?subject=census — הזרמת-המפקח-הריבוני מול-המימוש-ההיסטורי
// (runCensusCycle: מדידה-מתחלפת, שקילות-על-כל-8-הפלטים).
//
// Task 75 — מחזור-חדשנות #8: ?subject=restore-drill — תרגיל-שחזור-בכפייה כהוכחה-חתומה:
// clone-רדוד-מ-github → אימות-עצמאי-על-העותק → הצלבת-קידומת-מול-הייצור. הצלבה-אינה-עוברת =
// FAILED. זהו-המחזור-שסוגר-את-הכישלון-החי-מ-06:52 (Engine-not-connected → dbReady).
interface WitnessBench {
  ok?: boolean
  runs?: number
  equivalence?: boolean
  total?: number
  verified?: number
  head?: string
  stream?: { minMs: number; avgMs: number; maxMs: number }
  load?: { minMs: number; avgMs: number; maxMs: number }
  streamOverLoad?: number
}

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
  const subject = req.nextUrl.searchParams.get('subject') ?? 'verifyChain'

  // מסלול-#7 (Task 74): מדידת-ה-census — הזרמה-במפקח-הריבוני מול-המימוש-ההיסטורי.
  // שקילות-כל-8-הפלטים = תנאי-אימוץ-מוחלט; מהירות = רישום-כן; האימוץ-מנומק-בחסימות-זיכרון.
  if (subject === 'census') {
    const m: CensusCycleMeasurement = await runCensusCycle()
    const status = m.equivalenceProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-census',
      attempts: 1,
      durationMs: Math.round((m.baseline.avgMs + m.streamed.avgMs) * 1000),
      errorClass: m.equivalenceProven ? null : 'equivalence-mismatch',
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'census-streamed-vs-baseline',
          runs: m.runs,
          chainEntries: m.chainEntries,
          baselineMinMs: m.baseline.minMs,
          streamedMinMs: m.streamed.minMs,
          streamedPages: m.streamed.pages,
          speedupStreamed: m.speedupStreamed,
          equivalenceProven: m.equivalenceProven,
          mismatch: m.mismatch,
          adoptionScope: m.adoptionScope,
        })
      ),
    })
    return NextResponse.json({ ok: true, status, measurement: m, ledgerEntryId: entry.id })
  }

  // מסלול-#6 (Task 73): מדידת-העד-החי — האמת-על-ביצועי-העד מקורה-בעד-עצמו, לא-בהערכה.
  if (subject === 'witness') {
    let bench: WitnessBench
    try {
      const res = await fetch('http://127.0.0.1:3050/bench?runs=25', {
        signal: AbortSignal.timeout(120_000),
        cache: 'no-store',
      })
      bench = (await res.json()) as WitnessBench
    } catch (e) {
      // fail-honest: עד-דממה = אין-מדידה = אין-חתימה. אפס-המצאה-מספרים.
      return NextResponse.json(
        { ok: false, error: 'bench-unreachable', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      )
    }
    if (bench.ok !== true || !bench.stream || !bench.load) {
      return NextResponse.json({ ok: false, error: 'bench-invalid', bench }, { status: 502 })
    }
    // שקילות-היא-תנאי-אימוץ-מוחלט: שני-מימושים-שלא-מסכימים = FAILED (fail-closed).
    const equivalenceProven = bench.equivalence === true
    const status = equivalenceProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-witness',
      attempts: 1,
      durationMs: Math.round((bench.stream.avgMs + bench.load.avgMs) * 1000),
      errorClass: equivalenceProven ? null : 'equivalence-mismatch',
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'witness-stream-vs-load',
          runs: bench.runs,
          chainEntries: bench.total,
          verified: bench.verified,
          head: bench.head,
          streamMinMs: bench.stream.minMs,
          streamAvgMs: bench.stream.avgMs,
          loadMinMs: bench.load.minMs,
          loadAvgMs: bench.load.avgMs,
          streamOverLoad: bench.streamOverLoad,
          equivalenceProven,
          // הערת-האימוץ הכנה: אימוץ-הזרימה על-בסיס-חסימות-זיכרון (O(מנת-אצווה) מול O(n))
          // בשירות-לנצח; מהירות-בקנה-המידה-הנוכחי נרשמת-כפי-שהיא.
          adoptionRationale: 'bounded-memory',
        })
      ),
    })
    return NextResponse.json({ ok: true, status, bench, ledgerEntryId: entry.id })
  }

  // מחזור-#8 (Task 75): תרגיל-שחזור-בכפייה — ההוכחה-שהכפילות-הרחוקה (GitHub) מחזירה-מערכת-שלמה.
  // תנאי-האימוץ-המוחלט: התרגיל-רץ (ran), עובר (ok), והעותק-מאומת-כקידומת-ביט-ביט של-הייצור
  // (prefixMatch). כל-כישלון-בכל-שלב = FAILED-חתום (fail-honest — הכישלון-עצמו-הוא-ראיה).
  if (subject === 'restore-drill') {
    let drill: RestoreDrillResult
    try {
      drill = await runRestoreDrill(true) // כפייה-מגושמת במסילה-בלבד: המחזור-חייב-לרוץ-בפועל
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: 'drill-unreachable', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      )
    }
    const adoptionProven = drill.ran === true && drill.ok === true && drill.prefixMatch === true
    const status = adoptionProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-restore-drill',
      attempts: 1,
      durationMs: drill.durationMs ?? 0,
      errorClass: adoptionProven ? null : (drill.errorClass ?? 'drill-not-proven'),
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'restore-drill-forced',
          verified: drill.verified ?? null,
          total: drill.total ?? null,
          cloneHead: drill.cloneHead ?? null,
          prodHead: drill.prodHead ?? null,
          prefixMatch: drill.prefixMatch ?? null,
          drillLedgerId: drill.ledgerId ?? null,
          reason: drill.reason ?? null,
          adoptionRationale: 'remote-duplication-proven',
        })
      ),
    })
    return NextResponse.json({ ok: true, status, drill, ledgerEntryId: entry.id })
  }

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
