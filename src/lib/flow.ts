import { db } from '@/lib/db'

// איבר-אבחון-הזרימה (Task 104): תשובה-אחת-כנה לשאלה "איפה-הזרימה-נחסמת-עכשיו".
// עד-היום כל-סתימה התגלתה-רק-כשמישהו-הבחין (או כשהבעלים אמר "אני-לא-רואה-תנועה").
// הארכיטקטורה-היא-הבעלים: האבחון-חי-בכל-רגע, מנמק-במספרים, ומציע-את-העורק-הנדרש.
// אפס-מונחים-מילוליים: כל-פסק-דין נתמך-בעדות-מדודה-ישירה-מהמסד.

export type FlowState = 'flowing' | 'degraded' | 'blocked'

export interface FlowDiagnosis {
  ok: true
  at: string
  state: FlowState
  bottleneck: {
    code: string | null // null = אין-סתימה
    human: string // נימוק-אנושי-עברי מדויק
    evidence: Record<string, number | string | null> // העדויות המדודות
  }
  queue: {
    queued: number
    running: number
    runningStale: number // RUNNING שחרגו-מחוזה-הזמן (10דק')
    transientFailed: number // נכשלים-חוזרים-על-ניתנים-להחזרה
    permanentFailed: number
  }
  movement: {
    lastLedgerAt: string | null
    lastMovementSec: number | null // מאז-הרשומה-האחרונה-בשרשרת או-עדכון-משימה
  }
  organs: Array<{ name: string; up: boolean; detail: string }>
  actions: string[] // עורקים-מומלצים-לירי-מיידי
  diagnosisMs: number
}

const STALE_RUNNING_MS = 10 * 60_000
const TRANSIENT_CLASSES = ['rate-limit', 'provider', 'timeout', 'network', 'empty-output', 'unknown']
const ORGANS: Array<{ name: string; url: string }> = [
  { name: 'heart', url: 'http://127.0.0.1:3031/health' },
  { name: 'witness', url: 'http://127.0.0.1:3050/health' },
  { name: 'keeper', url: 'http://127.0.0.1:3051/health' },
  { name: 'metrics', url: 'http://127.0.0.1:3060/health' },
]

async function probeOrgan(name: string, url: string): Promise<{ name: string; up: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_500) })
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const detail = res.ok && d.ok !== false ? `חי (${res.status})` : `פגום (${res.status})`
    return { name, up: res.ok && d.ok !== false, detail }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { name, up: false, detail: `לא-עונה: ${msg.slice(0, 60)}` }
  }
}

export async function flowDiagnosis(): Promise<FlowDiagnosis> {
  const t0 = Date.now()
  const staleBefore = new Date(t0 - STALE_RUNNING_MS)

  const [
    queued,
    running,
    runningStale,
    transientFailed,
    permanentFailed,
    lastLedger,
    lastTask,
    organs,
  ] = await Promise.all([
    db.task.count({ where: { status: 'QUEUED' } }),
    db.task.count({ where: { status: 'RUNNING', updatedAt: { gte: staleBefore } } }),
    db.task.count({ where: { status: 'RUNNING', updatedAt: { lt: staleBefore } } }),
    db.task.count({
      where: { status: 'FAILED', errorClass: { in: TRANSIENT_CLASSES }, attempts: { lte: 5 }, role: null, parentId: null },
    }),
    db.task.count({ where: { status: 'FAILED', errorClass: { notIn: TRANSIENT_CLASSES } } }),
    db.ledgerEntry.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true, kind: true, status: true } }),
    db.task.findFirst({ orderBy: { updatedAt: 'desc' }, select: { updatedAt: true, status: true } }),
    Promise.all(ORGANS.map((o) => probeOrgan(o.name, o.url))),
  ])

  const lastMovementMs = Math.max(
    lastLedger?.createdAt.getTime() ?? 0,
    lastTask?.updatedAt.getTime() ?? 0,
  )
  const lastMovementSec = lastMovementMs > 0 ? Math.round((t0 - lastMovementMs) / 1000) : null

  const downOrgans = organs.filter((o) => !o.up)

  // סולם-פסיקה: ההתאמה-הראשונה-מכריעה. כל-פסיקה-נתמכת-בעדויות-מדודות.
  let code: string | null = null
  let human = ''
  let state: FlowState = 'flowing'
  let actions: string[] = []

  if (downOrgans.length > 0) {
    code = 'organ-down'
    state = 'blocked'
    human = `איבר-שקט: ${downOrgans.map((o) => `${o.name} (${o.detail})`).join(' · ')} — הזקיפה-תזניק; עד-אז-הזרימה-עיוורת-באיבר-זה`
    actions = []
  } else if (lastMovementSec !== null && lastMovementSec > 360 && (queued > 0 || running > 0)) {
    code = 'no-movement-with-work'
    state = 'blocked'
    human = `אין-תנועה ${Math.floor(lastMovementSec / 60)} דק' למרות עבודה-בטור (תור=${queued}, רצות=${running}) — זרימה-חסומה-בפועל`
    actions = ['tick', 'recovery']
  } else if (runningStale > 0) {
    code = 'stale-running'
    state = 'degraded'
    human = `${runningStale} משימות-רצות-חרגו-מחוזה-הזמן (10דק') — הסוואף-יתבוע-אותן-תוך-דקות; אם-חוזר-כל-פעימה, הביצוע-נתלה`
    actions = ['tick']
  } else if (transientFailed >= 5) {
    code = 'provider-storm'
    state = 'degraded'
    human = `סערת-ספק: ${transientFailed} משימות-נכשלו-כשל-חוזר-על (rate-limit/provider) — מחסן-עבודה-תקפה-ממתין-לניקוז-מצב-סערה`
    actions = ['recovery', 'tick']
  } else {
    code = null
    state = 'flowing'
    human =
      lastMovementSec !== null && lastMovementSec < 300
        ? `הזרימה שוטפת — תנועה-אחרונה לפני ${lastMovementSec}ש'`
        : 'הזרימה שוטפת — אין-סתימה-מדודה (הרשת-ברגיעה-חוקית, עורקי-האספקה-מזינים)'
  }

  return {
    ok: true,
    at: new Date().toISOString(),
    state,
    bottleneck: {
      code,
      human,
      evidence: {
        lastLedgerKind: lastLedger?.kind ?? null,
        lastLedgerStatus: lastLedger?.status ?? null,
        lastTaskStatus: lastTask?.status ?? null,
        downOrgans: downOrgans.map((o) => o.name).join(',') || null,
        staleThresholdMin: STALE_RUNNING_MS / 60_000,
      },
    },
    queue: { queued, running, runningStale, transientFailed, permanentFailed },
    movement: { lastLedgerAt: lastLedger?.createdAt.toISOString() ?? null, lastMovementSec },
    organs,
    actions,
    diagnosisMs: Date.now() - t0,
  }
}
