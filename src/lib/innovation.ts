import type { LedgerEntry } from '@prisma/client'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { GENESIS, verifyChain, verifyChainStreamed, ledgerHash, type VerifyResult } from '@/lib/ledger'

// מסילת-החדשנות (Task 60 — הוראת-בעלים: "בחן תכנן ישם בצע דחוף")
//
// העיקרון: הארכיטקטורה לא רק עובדת — היא מוכיחה שהיא עשתה את עצמה טובה יותר.
// כל-מחזור-חדשנות: מודד את הלופה-החמה (verifyChain) → מיישם אופטימיזציה אמיתית
// → מוכיח שקילות-תוצאה מול קו-הבסיס → מודד שוב → חותם את המדידה בשרשרת (INNOVATION).
//
// כנות-מדידה: אסור להצהיר שיפור שלא נמדד. אם-האופטימיזציה איטית-יותר — זה נרשם בכנות.
// כנות-ביטחון: אימות-דלתא (checkpoint) מחליף מודל-אמון — הוא מזהה חדירה-לזנב וכתיבה-חוזרת
// של-הקידומת, אך לא שינוי-in-place בתוך קידומת מאומתת. לכן: census (המפקח-הריבוני)
// נשאר על אימות-מלא מה-Genesis — לנצח. הדלתא מיועדת לבדיקות-חיות בתדירות-גבוהה בלבד.

// ===== אופטימיזציה 1: סריאליזציה ידנית (אותו-קנון, פחות-עבודה למנוע-V8) =====
// קנון-זהה ביט-ביט ל-ledgerRecordString — אותם-מפתחות, אותו-סדר, בריחה-זהה.
// שדות-מספריים לא-דורשים בריחה; שדות-מחרוזת עוברים JSON.stringify בודד.
export function canonicalRecordString(e: LedgerEntry): string {
  return (
    '{"taskId":' + JSON.stringify(e.taskId) +
    ',"kind":' + JSON.stringify(e.kind) +
    ',"status":' + JSON.stringify(e.status) +
    ',"worker":' + JSON.stringify(e.worker) +
    ',"attempts":' + String(e.attempts) +
    ',"durationMs":' + String(e.durationMs) +
    ',"errorClass":' + JSON.stringify(e.errorClass) +
    ',"outputHash":' + JSON.stringify(e.outputHash) +
    ',"prev":' + JSON.stringify(e.prev) +
    '}'
  )
}

function sha256ShortRaw(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

// אימות-מלא מהיר — אותם-סמנטיקה fail-closed של verifyChain, סריאליזציה ידנית.
export function verifyChainFullFast(entries: LedgerEntry[]): VerifyResult {
  let prev = GENESIS
  let brokenAt: number | null = null
  let verified = 0
  for (const e of entries) {
    if (e.prev !== prev) { brokenAt = e.id; break }
    if (e.hash !== sha256ShortRaw(canonicalRecordString(e))) { brokenAt = e.id; break }
    prev = e.hash
    verified++
  }
  const head = verified > 0 ? entries[verified - 1].hash : GENESIS
  return { ok: brokenAt === null, head, brokenAt, verified }
}

// ===== אופטימיזציה 2: אימות-דלתא עם checkpoint (O(n) → O(חדש)) =====
export interface ChainCheckpoint {
  count: number // כמה רשומות-קידומת אומתו-מלא
  headHash: string // ה-hash של הראש-המאומת (GENESIS אם אפס)
  at: string
}

export interface DeltaVerifyResult extends VerifyResult {
  mode: 'delta' | 'full-fallback'
  checkedEntries: number // כמה רשומות נאותו בפועל בקריאה-זו
  /** ה-checkpoint הבא להעביר בקריאה-הבאה (null כשלא-אומת מלא) — Task 61 */
  nextCheckpoint: ChainCheckpoint | null
}

export function verifyChainDelta(
  entries: LedgerEntry[],
  checkpoint: ChainCheckpoint | null
): DeltaVerifyResult {
  // תנאי-שימוש-בדלתא: הקידומת-המאוחסנת קיימת ותואמת בדיוק לראש-הנוכחי שלה.
  if (
    checkpoint &&
    checkpoint.count > 0 &&
    checkpoint.count <= entries.length &&
    entries[checkpoint.count - 1]?.hash === checkpoint.headHash
  ) {
    let prev = checkpoint.headHash
    let brokenAt: number | null = null
    let suffixVerified = 0
    for (let i = checkpoint.count; i < entries.length; i++) {
      const e = entries[i]
      if (e.prev !== prev) { brokenAt = e.id; break }
      if (e.hash !== ledgerHash(e)) { brokenAt = e.id; break }
      prev = e.hash
      suffixVerified++
    }
    const verified = checkpoint.count + suffixVerified
    const head = verified > 0 ? entries[verified - 1].hash : GENESIS
    const ok = brokenAt === null
    const nextCheckpoint: ChainCheckpoint | null =
      ok && verified === entries.length
        ? { count: verified, headHash: head, at: new Date().toISOString() }
        : null
    return { ok, head, brokenAt, verified, mode: 'delta', checkedEntries: suffixVerified, nextCheckpoint }
  }
  // fallback כן: אין-checkpoint תקף → אימות-מלא (הקו-המהיר-המלא) + checkpoint חדש להמשך
  const full = verifyChainFullFast(entries)
  const nextCheckpoint: ChainCheckpoint | null =
    full.ok && full.verified === entries.length
      ? { count: full.verified, headHash: full.head, at: new Date().toISOString() }
      : null
  return { ...full, mode: 'full-fallback', checkedEntries: full.verified, nextCheckpoint }
}

// Task 61: מחסן-checkpoint מודולי — בדיקת-חיים שקוראת שוב-ושוב לא מפסידה את החיסכון.
// כלל-עדכון נשמרני: מתעדכן רק-כשכל-השרשרת אומתה-מלא (ok && verified==length).
let autoCheckpoint: ChainCheckpoint | null = null

export function currentAutoCheckpoint(): ChainCheckpoint | null {
  return autoCheckpoint
}

export function verifyChainAuto(entries: LedgerEntry[]): DeltaVerifyResult {
  const r = verifyChainDelta(entries, autoCheckpoint)
  if (r.ok && r.nextCheckpoint) autoCheckpoint = r.nextCheckpoint
  return r
}

// ===== מחזור-חדשנות: מדידה → הוכחת-שקילות → מדידה → חתימה =====
export interface InnovationMeasurement {
  at: string
  chainEntries: number
  runs: number
  baseline: { minMs: number; medianMs: number; ok: boolean; verified: number; head: string }
  fullFast: { minMs: number; medianMs: number; ok: boolean; verified: number; head: string }
  delta: { minMs: number; medianMs: number; checkedEntries: number; ok: boolean; verified: number; head: string }
  speedupFullFast: number // baseline.min / fullFast.min
  speedupDelta: number // baseline.min / delta.min
  equivalenceProven: boolean // baseline ו-fullFast מסכימים ביט-ביט על השרשרת-החיה
  adoptionScope: string
}

function measure(entries: LedgerEntry[], runs: number): { minMs: number; medianMs: number; result: VerifyResult } {
  const times: number[] = []
  let result: VerifyResult | null = null
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    result = verifyChain(entries)
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  return { minMs: times[0], medianMs: times[Math.floor(times.length / 2)], result: result as VerifyResult }
}

function measureFast(entries: LedgerEntry[], runs: number): { minMs: number; medianMs: number; result: VerifyResult } {
  const times: number[] = []
  let result: VerifyResult | null = null
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    result = verifyChainFullFast(entries)
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  return { minMs: times[0], medianMs: times[Math.floor(times.length / 2)], result: result as VerifyResult }
}

function measureDelta(entries: LedgerEntry[], runs: number): { minMs: number; medianMs: number; result: DeltaVerifyResult } {
  const times: number[] = []
  let result: DeltaVerifyResult | null = null
  // checkpoint חם: קידומת-מלאה מאומתת — מדמה קריאה-שנייה של בדיקת-חיים (התרחיש האמיתי)
  const warm = verifyChainFullFast(entries)
  const checkpoint: ChainCheckpoint = { count: warm.verified, headHash: warm.head, at: new Date().toISOString() }
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    result = verifyChainDelta(entries, checkpoint)
    times.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  times.sort((a, b) => a - b)
  return { minMs: times[0], medianMs: times[Math.floor(times.length / 2)], result: result as DeltaVerifyResult }
}

const RUNS = 9

export async function runInnovationCycle(): Promise<InnovationMeasurement> {
  const entries = await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })

  const base = measure(entries, RUNS)
  const fast = measureFast(entries, RUNS)
  const delta = measureDelta(entries, RUNS)

  // הוכחת-שקילות על השרשרת-החיה: קו-הבסיס והנתיב-המהיר-המלא חייבים-להסכים ביט-ביט
  const eq =
    base.result.ok === fast.result.ok &&
    base.result.head === fast.result.head &&
    base.result.brokenAt === fast.result.brokenAt &&
    base.result.verified === fast.result.verified &&
    delta.result.ok === base.result.ok &&
    delta.result.head === base.result.head &&
    delta.result.verified === base.result.verified

  const m: InnovationMeasurement = {
    at: new Date().toISOString(),
    chainEntries: entries.length,
    runs: RUNS,
    baseline: { minMs: round3(base.minMs), medianMs: round3(base.medianMs), ok: base.result.ok, verified: base.result.verified, head: base.result.head },
    fullFast: { minMs: round3(fast.minMs), medianMs: round3(fast.medianMs), ok: fast.result.ok, verified: fast.result.verified, head: fast.result.head },
    delta: { minMs: round3(delta.minMs), medianMs: round3(delta.medianMs), checkedEntries: delta.result.checkedEntries, ok: delta.result.ok, verified: delta.result.verified, head: delta.result.head },
    speedupFullFast: round3(base.minMs / Math.max(fast.minMs, 1e-9)),
    speedupDelta: round3(base.minMs / Math.max(delta.minMs, 1e-9)),
    equivalenceProven: eq,
    // גבול-האימוץ (כנות-ביטחון): census נשאר אימות-מלא לנצח; הדלתא לבדיקות-חיות בלבד
    adoptionScope: 'census=full-forever; delta=liveness-probes-only',
  }
  return m
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

// ===== טיק: מוניזציית פסקי-דין (אותו-ארטיפקט → אותו-פסק-דין, אפס-חישוב-חוזר) =====
// reviewArtifact דטרמיניסטי לחלוטין — קנה-מידה לפי (handoffId + artifactHash + codeHash).
// Task 61 תיקון-תקינות: המפתח חייב-לכלול את hash-הקוד עצמו — אם task.output השתנה
// (הרצה-חוזרת), אותו-artifactHash לא מספיק: פסק-דין-ישן על קוד-חדש הוא שקר. בלי-codeHash
// במפתח המוניז היה לא-בטוח — תוקן.
const verdictCache = new Map<string, { deliverable: boolean; reasons: string[]; at: number }>()
const VERDICT_TTL_MS = 60 * 60_000 // שעה
const VERDICT_CACHE_CAP = 1000 // תקרה-קשיחה — אפס-נפיחות-לא-חסומה

export function memoizedVerdict(
  key: string,
  compute: () => { deliverable: boolean; reasons: string[] }
): { deliverable: boolean; reasons: string[]; cached: boolean } {
  const hit = verdictCache.get(key)
  const now = Date.now()
  if (hit && now - hit.at < VERDICT_TTL_MS) {
    return { ...hit, cached: true }
  }
  if (hit) verdictCache.delete(key) // פינוי-פג-תוקף
  if (verdictCache.size >= VERDICT_CACHE_CAP) verdictCache.clear() // תקרה-קשיחה
  const v = compute()
  verdictCache.set(key, { ...v, at: now })
  return { ...v, cached: false }
}

export function verdictCacheSize(): number {
  return verdictCache.size
}

// ===== מחזור-חדשנות #7 (Task 74): הזרמה-במפקח-הריבוני =====
// קו-הבסיס: המימוש-ההיסטורי (Task 30) — findMany-מלא של-כל-השרשרת + כל-האגרגציות-ב-JS.
// הנתיב-המאומץ: verifyChainStreamed (אותו-אימות-מלא-מה-Genesis, קריאה-בדפים) +
// groupBy/count/findFirst-ב-SQL. שקילות = כל-8-הפלטים מסכימים ביט-ביט.
// כנות: אפילו-אם-הזרימה-איטית-יותר-בקנה-המידה-הנוכחי — המדידה-נרשמת-כפי-שהיא;
// האימוץ-על-בסיס-חסימות-הזיכרון (O(דף)+O(קרדינליות) במקום O(n)-שורות-שנטענות-כל-30ש-לנצח).
export interface CensusCycleMeasurement {
  at: string
  chainEntries: number
  runs: number
  baseline: { minMs: number; avgMs: number }
  streamed: { minMs: number; avgMs: number; pages: number }
  speedupStreamed: number
  equivalenceProven: boolean
  mismatch: string | null
  adoptionScope: string
}

// קו-הבסיס — העתק-נאמן-של-המימוש-ההיסטורי (לא-נוגעים-בו; הוא-הבסיס-להשוואה-לנצח)
async function censusBaselineOnce() {
  const entries = await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })
  const verify = verifyChain(entries)
  const byKind: Record<string, number> = {}
  for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
  const entryByStatus: Record<string, number> = {}
  for (const e of entries) entryByStatus[e.status] = (entryByStatus[e.status] ?? 0) + 1
  const errorClasses: Record<string, number> = {}
  for (const e of entries) if (e.errorClass) errorClasses[e.errorClass] = (errorClasses[e.errorClass] ?? 0) + 1
  const head = entries.at(-1)?.hash ?? null
  return {
    verify: { ok: verify.ok, head: verify.head, brokenAt: verify.brokenAt, verified: verify.verified },
    total: entries.length,
    done: entryByStatus['DONE'] ?? 0,
    failed: entryByStatus['FAILED'] ?? 0,
    byKind,
    errorClasses,
    head,
  }
}

// הנתיב-המאומץ — זהה-לוגיקה-שה-buildCensus משתמש-בו מעתה
async function censusStreamedOnce() {
  const verify = await verifyChainStreamed()
  const [headEntry, kindRows, statusRows, errorRows] = await Promise.all([
    db.ledgerEntry.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } }),
    db.ledgerEntry.groupBy({ by: ['kind'], _count: { _all: true } }),
    db.ledgerEntry.groupBy({ by: ['status'], _count: { _all: true } }),
    db.ledgerEntry.groupBy({ by: ['errorClass'], _count: { _all: true }, where: { errorClass: { not: null } } }),
  ])
  const byKind: Record<string, number> = {}
  for (const r of kindRows) byKind[r.kind] = r._count._all
  const entryByStatus: Record<string, number> = {}
  for (const r of statusRows) entryByStatus[r.status] = r._count._all
  const errorClasses: Record<string, number> = {}
  for (const r of errorRows) if (r.errorClass) errorClasses[r.errorClass] = r._count._all
  return {
    verify: { ok: verify.ok, head: verify.head, brokenAt: verify.brokenAt, verified: verify.verified },
    total: verify.total,
    done: entryByStatus['DONE'] ?? 0,
    failed: entryByStatus['FAILED'] ?? 0,
    byKind,
    errorClasses,
    head: headEntry?.hash ?? null,
    pages: verify.pages,
  }
}

const CENSUS_RUNS = 9

export async function runCensusCycle(): Promise<CensusCycleMeasurement> {
  const baseTimes: number[] = []
  const streamTimes: number[] = []
  let baseline: Awaited<ReturnType<typeof censusBaselineOnce>> | null = null
  let streamed: Awaited<ReturnType<typeof censusStreamedOnce>> | null = null
  let mismatch: string | null = null
  // השוואה-קנונית-ממוינת (לקח-המחזור-הראשון, חתום-כ-FAILED-רשומה 775): JSON.stringify
  // רגיש-לסדר-מפתחות — groupBy-SQL מחזיר-בסדר-אחר-מסדר-ההיתקלות; שוויון-ערכים = מה-שנמדד.
  const canon = (o: Record<string, number>) =>
    JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]))
  const firstDiff = (b: Record<string, number>, s: Record<string, number>) => {
    const keys = new Set([...Object.keys(b), ...Object.keys(s)])
    for (const k of [...keys].sort()) if ((b[k] ?? 0) !== (s[k] ?? 0)) return k
    return null
  }
  for (let i = 0; i < CENSUS_RUNS; i++) {
    // מדידה-מתחלפת (בסיס ← זרימה ← בסיס...) — הוגנות-תרמית/מטמון-בין-המימושים
    let t0 = performance.now()
    const b = await censusBaselineOnce()
    baseTimes.push(performance.now() - t0)
    t0 = performance.now()
    const s = await censusStreamedOnce()
    streamTimes.push(performance.now() - t0)
    baseline = b
    streamed = s
    if (mismatch === null) {
      const eqBase =
        b.verify.ok === s.verify.ok &&
        b.verify.head === s.verify.head &&
        b.verify.brokenAt === s.verify.brokenAt &&
        b.verify.verified === s.verify.verified &&
        b.total === s.total &&
        b.done === s.done &&
        b.failed === s.failed &&
        b.head === s.head &&
        canon(b.byKind) === canon(s.byKind) &&
        canon(b.errorClasses) === canon(s.errorClasses)
      if (!eqBase) {
        const kindDiff = firstDiff(b.byKind, s.byKind)
        const errDiff = firstDiff(b.errorClasses, s.errorClasses)
        mismatch =
          `baseline{ok:${b.verify.ok},total:${b.total},done:${b.done},failed:${b.failed},verified:${b.verify.verified},kindDiff:${kindDiff ?? '-'},errDiff:${errDiff ?? '-'}} != ` +
          `streamed{ok:${s.verify.ok},total:${s.total},done:${s.done},failed:${s.failed},verified:${s.verify.verified}}`
      }
    }
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const min = (xs: number[]) => r3(Math.min(...xs))
  const avg = (xs: number[]) => r3(xs.reduce((s, x) => s + x, 0) / xs.length)
  return {
    at: new Date().toISOString(),
    chainEntries: streamed?.total ?? 0,
    runs: CENSUS_RUNS,
    baseline: { minMs: min(baseTimes), avgMs: avg(baseTimes) },
    streamed: { minMs: min(streamTimes), avgMs: avg(streamTimes), pages: streamed?.pages ?? 0 },
    speedupStreamed: r3(min(baseTimes) / Math.max(min(streamTimes), 1e-9)),
    equivalenceProven: mismatch === null,
    mismatch,
    adoptionScope:
      'census-stays-full-forever (streaming=full-verification, not delta); memory O(page)+O(cardinality) instead of O(all-rows)',
  }
}
