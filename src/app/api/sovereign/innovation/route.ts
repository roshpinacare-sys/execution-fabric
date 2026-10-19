import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { runInnovationCycle, runCensusCycle, type CensusCycleMeasurement } from '@/lib/innovation'
import { runRestoreDrill, type RestoreDrillResult } from '@/lib/restore-drill'
import { runHistoryDrill, type HistoryDrillResult } from '@/lib/history-drill'
import { runDocsDrill, type DocsDrillResult } from '@/lib/docs-drill'
import { buildMetricsStreamed } from '@/lib/metrics'
import { buildCensus } from '@/lib/census'
import { verifyChainStreamed } from '@/lib/ledger'

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
//
// Task 76 — מחזור-חדשנות #9: ?subject=metrics — הזרמת-מסלולי-הקריאה-הציבוריים (metrics+ledger
// — ה-O(n)-האחרון-שנותר): מימוש-האגרגציות-החדש-ב-SQL מוצלב-מול-ה-census-מ-#7 (כבר-חתום) —
// שני-מימושים-בלתי-תלויים-שחייבים-להסכים-על-כל-הפלטים-המשותפים (קנון-ממוין — לקח-#7).
//
// Task 78 — מחזור-חדשנות #11: ?subject=snapshot-drill — מקור-שחזור-שני, התמונה-השעתית
// (VACUUM INTO). עד-היום ההוכחה-הקבועה-נשענה-על-מקור-אחד (clone-גיט, מחזור-#8). אם-הגיט-
// עצמו-נפגע — אין-הוכחה-שהמקור-השני-באמת-משחזר. מעתה: העתקת-התמונה-הטרייה-ביותר →
// אימות-עצמאי-בזרימה על-העותק → הצלבת-קידומת-מול-הייצור → חתימה ב-worker משלו.
// שני-מקורות-בלתי-תלויים, אותו-קנון-אמת, שניהם-מוכחים-ריצה.
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

  // מחזור-#11 (Task 78): תרגיל-שחזור-מהמקור-השני — התמונה-השעתית. אותו-קנון-אמת של #8
  // (ran + ok + prefixMatch = תנאי-אימוץ-מוחלט), מקור-בלתי-תלוי: VACUUM INTO טרייה-ביותר.
  // תמונה-חסרה/ישנה-מ-90דק' = כשל-כן-חתום (snapshot-missing / snapshot-stale) — אפס-המצאה.
  if (subject === 'snapshot-drill') {
    let drill: RestoreDrillResult
    try {
      drill = await runRestoreDrill(true, 'snapshot') // כפייה-במסילה בלבד: המחזור-חייב-לרוץ-בפועל
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
      worker: 'innovation-cycle-snapshot-drill',
      attempts: 1,
      durationMs: drill.durationMs ?? 0,
      errorClass: adoptionProven ? null : (drill.errorClass ?? 'drill-not-proven'),
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'snapshot-restore-drill-forced',
          source: drill.source ?? 'snapshot',
          snapshotName: drill.snapshotName ?? null,
          snapshotAgeMs: drill.snapshotAgeMs ?? null,
          verified: drill.verified ?? null,
          total: drill.total ?? null,
          copyHead: drill.cloneHead ?? null,
          prodHead: drill.prodHead ?? null,
          prefixMatch: drill.prefixMatch ?? null,
          drillLedgerId: drill.ledgerId ?? null,
          reason: drill.reason ?? null,
          adoptionRationale: 'independent-backup-source-proven',
        })
      ),
    })
    return NextResponse.json({ ok: true, status, drill, ledgerEntryId: entry.id })
  }

  // מחזור-#13 (Task 80): תרגיל-שחזור-מהמקור-השלישי-מגוון-הפורמט — ייצוא-JSONL-בגיט.
  // אותו-קנון-אמת של-#8/#11 (ran + ok + prefixMatch = תנאי-אימוץ-מוחלט), אך-המקור-שונה-
  // מהותית: טקסט-חתום-מחוץ-ל-SQLite — התרגיל-מחשב-מחדש את-כל-שרשרת-ה-hash מה-Genesis
  // בזיכרון-טהור. פגיעה-לוגית-בקובץ-SQLite (האיום-שלא-היה-מכוסה — שני-המקורות-הקיימים
  // נגזרים-ממנו) כבר-אינה-משתקת-את-יכולת-השחזור. קובץ-חסר/פגום = כשל-כן-חתום.
  if (subject === 'chain-export-drill') {
    let drill: RestoreDrillResult
    try {
      drill = await runRestoreDrill(true, 'export') // כפייה-במסילה בלבד: המחזור-חייב-לרוץ-בפועל
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
      worker: 'innovation-cycle-chain-export-drill',
      attempts: 1,
      durationMs: drill.durationMs ?? 0,
      errorClass: adoptionProven ? null : (drill.errorClass ?? 'drill-not-proven'),
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'chain-export-restore-drill-forced',
          source: drill.source ?? 'export',
          verified: drill.verified ?? null,
          total: drill.total ?? null,
          copyHead: drill.cloneHead ?? null,
          prodHead: drill.prodHead ?? null,
          prefixMatch: drill.prefixMatch ?? null,
          drillLedgerId: drill.ledgerId ?? null,
          reason: drill.reason ?? null,
          adoptionRationale: 'format-diversified-text-source-proven',
        })
      ),
    })
    return NextResponse.json({ ok: true, status, drill, ledgerEntryId: entry.id })
  }

  // מחזור-#14 (Task 81): תרגיל-אטימות-ההיסטוריה — ההווה-מוכח-שחזור (תרגילי-#8/#11/#13);
  // העבר-מוכח-מעתה-שלא-נשכתה: הייצוא-מהקומיט-העתיק-ביותר-במראה-ה-bare נחשב-מחדש-מה-Genesis
  // (מאמת-הקנון) ומוצלב-כקידומת-ביט-ביט-מול-הייצור-החי. שכתוב-היסטוריה-שקט = כשל-חתום.
  // אותו-קנון-אמת-של-#8/#11/#13 (ran + ok + prefixMatch = תנאי-אימוץ-מוחלט).
  if (subject === 'history-drill') {
    let drill: HistoryDrillResult
    try {
      drill = await runHistoryDrill(true) // כפייה-במסילה בלבד: המחזור-חייב-לרוץ-בפועל
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
      worker: 'innovation-cycle-history-drill',
      attempts: 1,
      durationMs: drill.durationMs ?? 0,
      errorClass: adoptionProven ? null : (drill.errorClass ?? 'drill-not-proven'),
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'history-immutability-drill-forced',
          commitSha: drill.commitSha ?? null,
          commitDate: drill.commitDate ?? null,
          verified: drill.verified ?? null,
          total: drill.total ?? null,
          historyHead: drill.historyHead ?? null,
          prodHead: drill.prodHead ?? null,
          prefixMatch: drill.prefixMatch ?? null,
          drillLedgerId: drill.ledgerId ?? null,
          reason: drill.reason ?? null,
          adoptionRationale: 'append-only-history-proven-across-time',
        })
      ),
    })
    return NextResponse.json({ ok: true, status, drill, ledgerEntryId: entry.id })
  }

  // מחזור-#15 (Task 82): תרגיל-אטימות-המסמכים — חיבור-פסיפס-המסמכים-אל-השרשרת.
  // ארבעת-התרגילים-הקודמים מוכיחים-את-השרשרת-עצמה; הזה-מוכיח-את-הארטיפקטים-שהרשת-בונה-
  // בעצמה (sovereign/site/*.md): row→file, file→frontMatter-תקין, digest-קנוני-ממוין-
  // של-כל-הפסיפס נחתם-בשרשרת. פגיעה-שקטה-בקובץ = digest-שונה-בתרגיל-הבא = חתום.
  // אותו-קנון: ran + ok + files>0 = תנאי-אימוץ-מוחלט.
  if (subject === 'docs-drill') {
    let drill: DocsDrillResult
    try {
      drill = await runDocsDrill(true) // כפייה-במסילה בלבד: המחזור-חייב-לרוץ-בפועל
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: 'drill-unreachable', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      )
    }
    const adoptionProven = drill.ran === true && drill.ok === true && (drill.files ?? 0) > 0
    const status = adoptionProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-docs-drill',
      attempts: 1,
      durationMs: drill.durationMs ?? 0,
      errorClass: adoptionProven ? null : (drill.errorClass ?? 'drill-not-proven'),
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'docs-mosaic-provenance-forced',
          files: drill.files ?? null,
          bound: drill.bound ?? null,
          orphans: drill.orphans ?? null,
          mosaicDigest: drill.mosaicDigest ?? null,
          drillLedgerId: drill.ledgerId ?? null,
          reason: drill.reason ?? null,
          adoptionRationale: 'mosaic-provenance-proven',
        })
      ),
    })
    return NextResponse.json({ ok: true, status, drill, ledgerEntryId: entry.id })
  }

  // מחזור-#12 (Task 79): אוטונומיזציה של המקור-השני — פעימת-תרגיל-התמונה חיה בתוך-הלב
  // (עורק-ח-bis, כל-שעה, 45ש' אחרי-עליית-הלב). ההוכחה — הצלבת-גופים: הלב (הפועל — מדווח
  // snapshotRestorePulses>=1 ו-ok) מול-השרשרת (הראיה — רשומת-DRILL-טרייה של
  // drill:restore-snapshot, DONE, שזמנה תואם-לפעימה ±2דק'). שני-הגופים-חייבים-להסכים;
  // סתירה = FAILED-חתום (fail-closed) — בדיוק-הלקח-מ-#10 (נאמנות-לגוף) ומ-#8 (תרגיל-כהוכחה).
  if (subject === 'snapshot-pulse') {
    let heart: { ok?: boolean; snapshotRestorePulses?: number; snapshotRestoreOk?: boolean | null; lastSnapshotRestoreAt?: string | null; lastSnapshotRestoreResult?: string | null; startedAt?: string }
    try {
      const res = await fetch('http://127.0.0.1:3031/health', {
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      })
      heart = (await res.json()) as typeof heart
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: 'heartbeat-unreachable', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      )
    }
    const pulse = await db.ledgerEntry.findFirst({
      where: { kind: 'DRILL', worker: 'drill:restore-snapshot' },
      orderBy: { id: 'desc' },
    })
    // הצלבה-מדויקת: לשני-הגופים אותו-סיפור על הפעימה-החיה
    const heartLive = heart.snapshotRestorePulses !== undefined && heart.snapshotRestorePulses >= 1
    const heartOk = heart.snapshotRestoreOk === true
    const chainLive = pulse !== null && pulse.status === 'DONE'
    const timeMatch =
      pulse !== null &&
      heart.lastSnapshotRestoreAt !== null &&
      heart.lastSnapshotRestoreAt !== undefined &&
      Math.abs(new Date(pulse.createdAt).getTime() - new Date(heart.lastSnapshotRestoreAt).getTime()) <= 2 * 60_000

    const equivalenceProven = heartLive && heartOk && chainLive && timeMatch
    const status = equivalenceProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-snapshot-pulse',
      attempts: 1,
      durationMs: pulse?.durationMs ?? 0,
      errorClass: equivalenceProven
        ? null
        : !heartLive
          ? 'heartbeat-pulse-missing'
          : !heartOk
            ? 'heartbeat-pulse-failed'
            : !chainLive
              ? 'chain-drill-missing'
              : 'heartbeat-chain-divergence',
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'snapshot-pulse-autonomous',
          heartPulses: heart.snapshotRestorePulses ?? null,
          heartOk: heart.snapshotRestoreOk ?? null,
          heartResult: heart.lastSnapshotRestoreResult ?? null,
          heartStartedAt: heart.startedAt ?? null,
          chainDrillId: pulse?.id ?? null,
          chainDrillStatus: pulse?.status ?? null,
          chainDrillAt: pulse?.createdAt.toISOString() ?? null,
          timeMatch,
          equivalenceProven,
          adoptionRationale: 'second-source-proven-by-machine',
        })
      ),
    })
    return NextResponse.json({
      ok: true,
      status,
      equivalenceProven,
      heart: {
        pulses: heart.snapshotRestorePulses ?? null,
        ok: heart.snapshotRestoreOk ?? null,
        result: heart.lastSnapshotRestoreResult ?? null,
      },
      chain: pulse ? { id: pulse.id, status: pulse.status, at: pulse.createdAt.toISOString() } : null,
      ledgerEntryId: entry.id,
    })
  }

  // מחזור-#9 (Task 76): הזרמת-מסלולי-הקריאה-הציבוריים. ההוכחה — הצלבה-דו-מימושית:
  // buildMetricsStreamed (האגרגציות-החדשות-ב-SQL) מול buildCensus (מ-#7) — שני-מימושים-
  // בלתי-תלויים, שתי-קבוצות-שאילתות-שונות, שחייבים-להסכים-על-כל-הפלטים-המשותפים.
  // קנון-ממוין למילונים (לקח-#7 — רשומה-775). מהירות = רישום-כן; האימוץ-מנומק-בחסימות-זיכרון.
  if (subject === 'metrics') {
    const canon = (o: Record<string, number>) =>
      JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))
    const t0 = performance.now()
    const m = await buildMetricsStreamed()
    const streamMs = performance.now() - t0
    const t1 = performance.now()
    const c = await buildCensus()
    const censusMs = performance.now() - t1

    const kindDiff = (() => {
      const keys = new Set([...Object.keys(m.byKind), ...Object.keys(c.chain.byKind)])
      for (const k of [...keys].sort()) if ((m.byKind[k] ?? 0) !== (c.chain.byKind[k] ?? 0)) return k
      return null
    })()
    const errDiff = (() => {
      const keys = new Set([...Object.keys(m.errorClasses), ...Object.keys(c.chain.errorClasses)])
      for (const k of [...keys].sort())
        if ((m.errorClasses[k] ?? 0) !== (c.chain.errorClasses[k] ?? 0)) return k
      return null
    })()

    const equivalenceProven =
      m.verify.ok === c.chain.verify.ok &&
      m.verify.verified === c.chain.verify.verified &&
      m.verify.head === c.chain.verify.head &&
      m.total === c.chain.total &&
      m.done === c.chain.done &&
      m.failed === c.chain.failed &&
      canon(m.byKind) === canon(c.chain.byKind) &&
      canon(m.errorClasses) === canon(c.chain.errorClasses)

    const status = equivalenceProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-metrics',
      attempts: 1,
      durationMs: Math.round((streamMs + censusMs) * 1000),
      errorClass: equivalenceProven ? null : 'equivalence-mismatch',
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'metrics-sql-vs-census',
          total: m.total,
          done: m.done,
          failed: m.failed,
          verified: m.verify.verified,
          head: m.verify.head,
          streamMs: Math.round(streamMs * 1000) / 1000,
          censusMs: Math.round(censusMs * 1000) / 1000,
          kindDiff,
          errDiff,
          equivalenceProven,
          adoptionRationale: 'bounded-memory-public-reads',
        })
      ),
    })
    return NextResponse.json({
      ok: true,
      status,
      equivalenceProven,
      streamMs: Math.round(streamMs * 1000) / 1000,
      censusMs: Math.round(censusMs * 1000) / 1000,
      ledgerEntryId: entry.id,
    })
  }

  // מחזור-#10 (Task 77): סגירת-הדלתא + שערי-הקריאה — ops (טעינה-מלאה) ו-registry
  // (דלתא-עם-checkpoint-בזיכרון-תהליך — האמון-הטפילי-שנדחה-בכל-המחזורים) מוזרמים-מעתה
  // ל-verifyChainStreamed; גם-התרגיל-מאמת-את-העותק-בזרימה. ההוכחה — הצלבה-כפולת-תהליכים:
  // העד-העצמאי (:3050, תהליך-נפרד, קוד-בלתי-תלוי) מול-הייצור-המזרים — שני-גופים-שחייבים-
  // להסכים-ברגע-החתימה; שקילות-זו-מכסה-את-כל-השערים-המוזרמים (אותו-קנון-זרימה).
  if (subject === 'chain-sources') {
    let witness: { ok?: boolean; verified?: number; total?: number; head?: string }
    try {
      const res = await fetch('http://127.0.0.1:3050/witness', {
        signal: AbortSignal.timeout(30_000),
        cache: 'no-store',
      })
      witness = (await res.json()) as typeof witness
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: 'witness-unreachable', detail: e instanceof Error ? e.message : String(e) },
        { status: 502 }
      )
    }
    if (witness.ok !== true) {
      return NextResponse.json({ ok: false, error: 'witness-invalid', witness }, { status: 502 })
    }
    const t0 = performance.now()
    const stream = await verifyChainStreamed()
    const streamMs = Math.round((performance.now() - t0) * 1000) / 1000

    const equivalenceProven =
      witness.verified === stream.verified &&
      witness.total === stream.total &&
      witness.head === stream.head

    const status = equivalenceProven ? 'DONE' : 'FAILED'
    const entry = await appendLedger({
      taskId: null,
      kind: 'INNOVATION',
      status,
      worker: 'innovation-cycle-chain-sources',
      attempts: 1,
      durationMs: Math.round(streamMs * 1000),
      errorClass: equivalenceProven ? null : 'witness-production-divergence',
      outputHash: sha256Short(
        JSON.stringify({
          subject: 'witness-vs-streamed-production',
          witnessVerified: witness.verified ?? null,
          witnessTotal: witness.total ?? null,
          witnessHead: witness.head ?? null,
          streamVerified: stream.verified,
          streamTotal: stream.total,
          streamHead: stream.head,
          streamPages: stream.pages,
          streamMs,
          equivalenceProven,
          adoptionRationale: 'no-delta-no-checkpoint-all-gates-streamed',
        })
      ),
    })
    return NextResponse.json({
      ok: true,
      status,
      equivalenceProven,
      witness: { verified: witness.verified, total: witness.total, head: witness.head },
      stream: { verified: stream.verified, total: stream.total, head: stream.head, pages: stream.pages },
      streamMs,
      ledgerEntryId: entry.id,
    })
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
