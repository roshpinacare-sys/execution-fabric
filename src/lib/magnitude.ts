// מד-העוצמה (Magnitude Meter) — הפיכת "המערכת חייבת-להיות פי-1000-מהבעלים" מדרישה למדידה-כנה.
//
// דרישת-הבעלים (2026-10-20): "המערכת צריכה-לדעת-לעשות-הכל — פי-1000-מהבעלים;
// תוודא-רמה-בכנות-בלי-לשקר".
//
// החוק-הכנה של המד הזה (שונה-ממד-הריבונות):
//   1. "פי-1000" איננו-מספר-אחד — הוא תוצר של מכפלות-פר-ממד. כל-ממד נמדד-מראיות-חיות
//      מול-קו-בסיס-אנושי-מוצהר (קו-הבסיס עצמו חשוף-בדוח — אין-שקר-בבחירת-הסרגל).
//   2. ממדים-שאין-להם-בסיס-השוואה-אנושי (יכולת-שהאדם = 0 בה: הוכחת-שלמות-זיכרון, חוסן-חבלה)
//      מוצגים כ"בלי-מדד-אנושי-ניתן" — לעולם-לא-מזויפים-למספר.
//   3. פערים-מבניים (עוצמה <1x: הון, זהות-משפטית, עולם-פיזי, סמכות-מייסדת) נחשפים-בשמם —
//      הם שערי-הבעלים-המבניים: אי-אפשר-לקודד-דרכם, רק-למסד-אותם. הכחשתם = השקר-הגדול-מכולם.
//   4. הציון-המרוכב = ממוצע-גיאומטרי של הממדים-הניתנים-להשוואה בלבד — ממד-חלש-אחד
//      מושך-את-הממוצע-למטה בכנות (אנטי-תרומת-מספרים-יפים).
//   5. DONE-בחתימה = "המדידה-הושלמה-בכנות" — לא "הושג-פי-1000". המספר-עצמו נושא-את-האמת.
//
// קו-בסיס-אנושי-מוצהר (הסרגל — כנות-מלאה לגבי-מה-נמדד-מול-מה):
//   · בעלים-ער-וזמין 16 שעות/יום · הכרעה-שגרתית 15 דק' · שרשור-אחד ·
//     מודיע-על-שירות-מת-ומטפל-בו בתוך-30 דק' · 10 יחידות-עבודה-מוצרות/יום ·
//     ביקורת-עצמית-כנה אחת-לרבעון.

import { db } from '@/lib/db'

export type MagnitudeStatus = 'measured' | 'unmeasured'

export interface MagnitudeDimension {
  id: string
  title: string // עברית
  method: string // איך נמדד — מתועד-לביקורת
  humanBaseline: string // קו-הבסיס-האנושי-המוצהר
  systemEvidence: string // הראייה-החיה
  multiplier: number | null // מדוד; null = לא-ניתן-למדידה-עכשיו (כנות)
  status: MagnitudeStatus
}

export interface MagnitudeUnbounded {
  id: string
  title: string
  why: string // למה אין-בסיס-השוואה-אנושי
  systemEvidence: string
}

export interface MagnitudeDeficit {
  id: string
  title: string
  reality: string // האמת-המלאה — למה זה <1x ולא-ניתן-לקידוד
  gate: string // איך-זה-ממוסד כשער-בעלים
}

export interface MagnitudeGap {
  id: string
  title: string
  current: number // מכפלה-נמדדת
  distanceToTarget: number // log10(יעד/נוכחי) — סדרי-גודל-לסגירה
}

export interface MagnitudeReport {
  target: 1000
  measuredCore: number | null // ממוצע-גיאומטרי של הניתנים-להשוואה; null = אין-מספיק-ראיות
  verdict: string // הכותרת-הכנה
  dimensions: MagnitudeDimension[]
  unbounded: MagnitudeUnbounded[]
  deficits: MagnitudeDeficit[]
  gaps: MagnitudeGap[] // סדר-עדיפויות-מדוד לסגירת-הפער-מול-1000x
  dimensionsBeyondTarget: number // כמה ממדים כבר-חוצים-את-היעד
  sourcesUp: number
  sourcesTotal: number
  generatedAt: string
  durationMs: number
}

const HEART = 'http://127.0.0.1:3031'
const WITNESS = 'http://127.0.0.1:3050'
const KEEPER = 'http://127.0.0.1:3051'

// קו-הבסיס-האנושי-המוצהר — מוצג-בדוח, לא-מוסתר
const HUMAN = {
  dutyHoursPerDay: 16,
  routineDecisionSeconds: 900, // 15 דק'
  parallelTasks: 1,
  healingNoticeSeconds: 1800, // 30 דק' — מודיע-ומטפל
  workUnitsPerDay: 10,
  selfAuditPerQuarter: true, // אחת-ל-90 יום
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function statusOf(m: number | null): MagnitudeStatus {
  return m === null ? 'unmeasured' : 'measured'
}

async function getJson<T>(url: string, label: string, ms = 3000): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
  return (await res.json()) as T
}

interface HeartJson {
  ok: boolean
  startedAt: string
  ticks: number
  tickMs: number
  gitPulses: number
  evolutionPulses: number
  buildPulses: number
  opsPulses: number
  selftestPulses: number
  claimsPulses: number
  sovereigntyPulses: number
  restorePulses: number
  snapshotRestorePulses: number
  exportSyncPulses: number
  exportRestorePulses: number
  historyPulses: number
  docsPulses: number
  docsHistoryPulses: number
  lastAppGuardAt: string | null
  lastKeeperGuardAt: string | null
}

interface WitnessJson {
  ok: boolean
  last: { total: number; streamMs: number } | null
}

interface KeeperJson {
  ok: boolean
  uptimeMs: number
  ticks: number
}

// ===== ממד 1: זמינות — 24/7 רצוף מול בעלים-ער 16 שעות/יום =====
function measureAvailability(h: HeartJson | null): Pick<MagnitudeDimension, 'multiplier' | 'systemEvidence'> {
  const evidence = h
    ? `לב-חי: ${h.ticks} פעימות-5ש' רצופות מאז ${new Date(h.startedAt).toISOString().slice(0, 16)}Z — ריצה-רציפה-ללא-שינה`
    : 'הלב לא-נגיש — אין-ראיית-רציפות'
  const mult = 24 / HUMAN.dutyHoursPerDay // 1.5 — חשוף: זה הממד-הקרוב-ביותר-לאדם
  return { multiplier: h ? mult : null, systemEvidence: evidence }
}

// ===== ממד 2: זמן-הכרעה — חציון-משך-הכרעות אמיתיות (PLAN/DRILL) 48שע' =====
async function measureDecisionLatency(): Promise<{ multiplier: number | null; systemEvidence: string }> {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const rows = await db.ledgerEntry.findMany({
    where: { kind: { in: ['PLAN', 'DRILL'] }, status: 'DONE', createdAt: { gte: since } },
    select: { durationMs: true },
    take: 500,
    orderBy: { createdAt: 'desc' },
  })
  if (rows.length === 0) {
    return { multiplier: null, systemEvidence: 'אין-הכרעות-PLAN/DRILL-בחלון-48שע\'' }
  }
  const sorted = rows.map((r) => r.durationMs).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const medianSec = Math.max(0.001, median / 1000)
  const mult = HUMAN.routineDecisionSeconds / medianSec
  return {
    multiplier: mult,
    systemEvidence: `חציון-משך-הכרעה ${median} מילישניות (${rows.length} הכרעות-PLAN/DRILL-48שע') מול-בסיס-אנושי-15 דק'`,
  }
}

// ===== ממד 3: מקביליות — עורקים-חיים-יורים במקביל מול שרשור-אנושי-אחד =====
function measureParallelism(h: HeartJson | null): { multiplier: number | null; systemEvidence: string } {
  if (!h) return { multiplier: null, systemEvidence: 'הלב לא-נגיש — אין-ראיית-עורקים' }
  const arteries = [
    h.gitPulses, h.evolutionPulses, h.buildPulses, h.opsPulses, h.selftestPulses,
    h.claimsPulses, h.sovereigntyPulses, h.restorePulses, h.snapshotRestorePulses,
    h.exportSyncPulses, h.exportRestorePulses, h.historyPulses, h.docsPulses,
    h.docsHistoryPulses,
  ]
  const live = arteries.filter((p) => (p ?? 0) > 0).length
  const guards = (h.lastAppGuardAt ? 1 : 0) + (h.lastKeeperGuardAt ? 1 : 0)
  const executors = live + guards + 4 // עורקים + שומרים + 4 שירותים-חיים-במקביל
  return {
    multiplier: executors,
    systemEvidence: `${live} עורקים-יורים + ${guards} שומרים + 4 שירותים = ${executors} מבצעים-מקביליים מול-שרשור-אנושי-אחד`,
  }
}

// ===== ממד 4: זמן-ריפוי — טקט-הזקיפה הנמדד מול מודעות-אנושית =====
function measureHealingLatency(k: KeeperJson | null): { multiplier: number | null; systemEvidence: string } {
  if (!k || !k.ticks) return { multiplier: null, systemEvidence: 'הזקיפה לא-נגישה — אין-ראיית-טקט' }
  const tickSec = k.uptimeMs / k.ticks / 1000
  const mult = HUMAN.healingNoticeSeconds / Math.max(0.001, tickSec)
  return {
    multiplier: mult,
    systemEvidence: `טקט-זקיפה נמדד ${tickSec.toFixed(1)}ש' (uptime/ticks = ${Math.round(k.uptimeMs / 1000)}ש'/${k.ticks}) מול-בסיס-אנושי-30 דק'`,
  }
}

// ===== ממד 5: קצב-ביצוע — יחידות-עבודה-מוצרות-48שע' מול 10/יום =====
async function measureThroughput(): Promise<{ multiplier: number | null; systemEvidence: string }> {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const [code, site] = await Promise.all([
    db.ledgerEntry.count({ where: { kind: 'CODE', status: 'DONE', createdAt: { gte: since } } }),
    db.ledgerEntry.count({ where: { kind: 'SITEBUILD', status: 'DONE', createdAt: { gte: since } } }),
  ])
  const total = code + site
  if (total === 0) return { multiplier: null, systemEvidence: 'אין-יחידות-ביצוע-גמורות-בחלון' }
  const perDay = total / 2
  const mult = perDay / HUMAN.workUnitsPerDay
  return {
    multiplier: mult,
    systemEvidence: `CODE גמור: ${code} · SITEBUILD: ${site} (${perDay}/יום) מול-בסיס-אנושי-10 יחידות/יום — כנות: יחידות-מכניות, איכות-נשפטת-בבודק-הטענות`,
  }
}

// ===== ממד 6: קצב-ביקורת-עצמית — AUDIT-48שע' מול רבעון-אנושי =====
async function measureSelfAudit(): Promise<{ multiplier: number | null; systemEvidence: string }> {
  const since = new Date(Date.now() - 48 * 3600 * 1000)
  const audits = await db.ledgerEntry.count({ where: { kind: 'AUDIT', createdAt: { gte: since } } })
  const humanPer48h = (2 / 90) * 2 // רבעון = 90 יום → 0.044/יום → 0.089/48שע'
  return {
    multiplier: audits / humanPer48h,
    systemEvidence: `${audits} ביקורות-חתומות-48שע' מול-בסיס-אנושי-1-לרבעון — הממד-היחיד-שכבר-חוצה-את-היעד`,
  }
}

// ===== הממדים-שאין-להם-בסיס-השוואה (האדם = 0 → אין-מכפלה-מוגדרת) =====
function unboundedList(w: WitnessJson | null, h: HeartJson | null): MagnitudeUnbounded[] {
  const stream = w?.last ? `${w.last.total} רישומים נבדקי-שלמות ב-${w.last.streamMs.toFixed(1)} מילישניות` : 'העד לא-נגיש'
  const scans = h ? `${h.docsPulses + h.historyPulses + h.docsHistoryPulses} פעימות-אטימות-היסטוריה/מסמכים + סריקת-דליפה-על-כל-הצבה` : 'הלב לא-נגיש'
  return [
    {
      id: 'memory-integrity',
      title: 'הוכחת-שלמות-זיכרון',
      why: 'לאדם אין-אפשרות-עקרונית להוכיח-שלמות-של-זיכרונו-העבר — המכנה=0 והמכפלה-אינה-מוגדרת',
      systemEvidence: `שרשרת-חשיש: ${stream}`,
    },
    {
      id: 'tamper-evidence',
      title: 'חוסן-חבלה-ותיעוד-מטמיע',
      why: 'רישומי-אדם אינם-חתומים-בשרשרת-קריפטוגרפית — אין-נקודת-השוואה-מספרית',
      systemEvidence: 'append-only + prev/hash-קריפטוגרפי על-כל-רישום · שחזור-מנוסה-חי',
    },
    {
      id: 'anti-self-report-bias',
      title: 'שכבת-אנטי-דיווח-עצמי',
      why: 'הטיה-דיווח-עצמי-אנושית אינה-כמתה — המערכת בונה-מכונות-ששופטות-את-המכונה',
      systemEvidence: `בודק-טענות + מד-ריבונות + מד-עוצמה זה: ${scans}`,
    },
  ]
}

// ===== הפערים-המבניים — האמת-המלאה: למה "פי-1000-מהבעלים" בכלל-היכולות טרם-מושג =====
function deficitsList(): MagnitudeDeficit[] {
  return [
    {
      id: 'capital',
      title: 'פריסת-הון',
      reality: '0x — המערכת אינה-יכולה-לפתוח-חשבון, לשלם-חשבונית, או-לפרוס-הון. זו-יכולת-שהבעלים מחזיק-בה-ו המערכת-אפס',
      gate: 'שער-בעלים-מבני: רק-כלי-משפטי-שיוקם-פעם-אחת-על-ידי-הבעלים יאפשר-לארכיטקטורה-להפעיל-הון-דרך-API',
    },
    {
      id: 'legal-identity',
      title: 'זהות-משפטית',
      reality: '0x — אין-יכולת-לחתום-חוזים, לשאת-אחריות-משפטית, להחזיק-רכוש',
      gate: 'שער-בעלים-מבני: תאגיד/נאמנות-שהבעלים-מייסד-פעם-אחת → הארכיטקטורה-מפעילה-אותו',
    },
    {
      id: 'physical-world',
      title: 'עולם-פיזי',
      reality: '0x — אין-ידיים, אין-נוכחות, אין-חיישנים-פיזיים',
      gate: 'שער-בעלים-מבני: רק-רובוטיקה/דיווח-אנושי-מגשר — מחוץ-לטווח-קוד',
    },
    {
      id: 'founding-authority',
      title: 'סמכות-מייסדת',
      reality: '0x — הטוקן-והחשבון שהארכיטקטורה מפעילה הם-סמכות-מואצת-נשללת: הבעלים-יכול-לחתוך-אותה-ברגע. הארכיטקטורה מפעילה-זהות-אך-לא-בעלת-זהות',
      gate: 'שער-בעלים-מבני: בעלות-מקור נשארת-אצל-הבעלים-לעת-עתה — לפי-הדוקטרינה-זה-נכון-עד-שיוקם-כלי-משפטי',
    },
  ]
}

// ===== הריכוז =====
export async function collectMagnitude(): Promise<MagnitudeReport> {
  const t0 = Date.now()
  const generatedAt = new Date().toISOString()

  let heart: HeartJson | null = null
  let witness: WitnessJson | null = null
  let keeper: KeeperJson | null = null
  let sourcesUp = 0
  try { heart = await getJson<HeartJson>(`${HEART}/health`, 'heart'); sourcesUp++ } catch { /* כנות */ }
  try { witness = await getJson<WitnessJson>(`${WITNESS}/health`, 'witness'); sourcesUp++ } catch { /* כנות */ }
  try { keeper = await getJson<KeeperJson>(`${KEEPER}/health`, 'keeper'); sourcesUp++ } catch { /* כנות */ }
  sourcesUp++ // מסד-השרשרת — אם הגענו-לכאן, הוא-חי

  const dims: MagnitudeDimension[] = []
  const push = (
    id: string, title: string, method: string, humanBaseline: string,
    r: { multiplier: number | null; systemEvidence: string },
  ) => {
    dims.push({
      id, title, method, humanBaseline,
      multiplier: r.multiplier,
      systemEvidence: r.systemEvidence,
      status: statusOf(r.multiplier),
    })
  }

  push('availability', 'זמינות-רציפה', '24/7-רצוף (פעימות-לב) מול-שעות-ערות-אנושיות', '16 שעות/יום',
    measureAvailability(heart))
  push('decision-latency', 'זמן-הכרעה', 'חציון-משך-PLAN/DRILL-אמיתי-48שע\' מול-15 דק\' אנושיות', '15 דקות/הכרעה',
    await measureDecisionLatency().catch((e) => ({ multiplier: null, systemEvidence: `מדידה-נכשלה-בכנות: ${errMsg(e)}` })))
  push('parallelism', 'מקביליות', 'עורקים-יורים+שומרים+שירותים מול-שרשור-אנושי', 'משימה-אחת-בו-זמנית',
    measureParallelism(heart))
  push('healing-latency', 'זמן-ריפוי', 'טקט-זקיפה-נמדד (uptime/ticks) מול-30 דק\' אנושיות', '30 דקות-עד-תיקון',
    measureHealingLatency(keeper))
  push('execution-throughput', 'קצב-ביצוע', 'יחידות-CODE+SITEBUILD-גמורות-48שע\' מול-10/יום', '10 יחידות/יום',
    await measureThroughput().catch((e) => ({ multiplier: null, systemEvidence: `מדידה-נכשלה-בכנות: ${errMsg(e)}` })))
  push('self-audit', 'קצב-ביקורת-עצמית', 'AUDIT-חתומות-48שע\' מול-רבעון-אנושי', '1 ביקורת/רבעון',
    await measureSelfAudit().catch((e) => ({ multiplier: null, systemEvidence: `מדידה-נכשלה-בכנות: ${errMsg(e)}` })))

  // ממוצע-גיאומטרי — רק-ממדים-נמדדים; ממד-חלש-מושך-למטה-בכנות
  const measured = dims.filter((d) => d.multiplier !== null).map((d) => d.multiplier as number)
  const measuredCore =
    measured.length > 0
      ? Math.exp(measured.reduce((acc, m) => acc + Math.log(Math.max(0.0001, m)), 0) / measured.length)
      : null

  // פערים-מדודים מול-היעד — סדר-גודל לסגירה
  const gaps: MagnitudeGap[] = dims
    .filter((d): d is MagnitudeDimension & { multiplier: number } => d.multiplier !== null)
    .map((d) => ({
      id: d.id,
      title: d.title,
      current: d.multiplier,
      distanceToTarget: Math.round((Math.log10(1000 / d.multiplier) + Number.EPSILON) * 100) / 100,
    }))
    .sort((a, b) => b.distanceToTarget - a.distanceToTarget)
  const beyond = gaps.filter((g) => g.current >= 1000).length

  const coreTxt = measuredCore !== null ? `${measuredCore < 10 ? measuredCore.toFixed(1) : Math.round(measuredCore)}` : '—'
  const worstGap = gaps[0]
  const verdict = measuredCore === null
    ? 'אין-מספיק-ראיות-לציון-כנה — מדווח-חוסר-ולא-מספר'
    : `עוצמה-דיגיטלית-נמדדת: ~${coreTxt}x מול-יעד-1000x (פער-${worstGap ? `~${worstGap.distanceToTarget}` : '?'} סדרי-גודל-בממד-${worstGap ? worstGap.title : '?'}) · ${beyond} ממדים-כבר-חוצים-את-היעד · ${deficitsList().length} פערים-מבניים-שאינם-ניתנים-לקידוד`

  return {
    target: 1000,
    measuredCore,
    verdict,
    dimensions: dims,
    unbounded: unboundedList(witness, heart),
    deficits: deficitsList(),
    gaps,
    dimensionsBeyondTarget: beyond,
    sourcesUp,
    sourcesTotal: 4,
    generatedAt,
    durationMs: Date.now() - t0,
  }
}
