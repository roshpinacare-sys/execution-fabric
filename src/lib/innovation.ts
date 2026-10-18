import type { LedgerEntry } from '@prisma/client'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { GENESIS, verifyChain, ledgerHash, type VerifyResult } from '@/lib/ledger'

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
    return { ok: brokenAt === null, head, brokenAt, verified, mode: 'delta', checkedEntries: suffixVerified }
  }
  // fallback כן: אין-checkpoint תקף → אימות-מלא (הקו-המהיר-המלא) ובניית-checkpoint חדש
  const full = verifyChainFullFast(entries)
  const next: ChainCheckpoint | null = full.ok
    ? { count: full.verified, headHash: full.head, at: new Date().toISOString() }
    : null
  return { ...full, mode: 'full-fallback', checkedEntries: full.verified, ...(next ? {} : {}) }
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
// reviewArtifact דטרמיניסטי לחלוטין — קנה-מידה לפי (handoffId + artifactHash).
// מפתח-טיק: בדוח מופרד "חידוש" מ"ידוע" — הבעלים רואה במבט-אחד מה-חדש.
const verdictCache = new Map<string, { deliverable: boolean; reasons: string[]; at: number }>()
const VERDICT_TTL_MS = 60 * 60_000 // שעה

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
  const v = compute()
  verdictCache.set(key, { ...v, at: now })
  return { ...v, cached: false }
}

export function verdictCacheSize(): number {
  return verdictCache.size
}
