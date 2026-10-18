import fs from 'fs'
import path from 'path'
import { db } from '@/lib/db'
import { verifyChain, type VerifyResult } from '@/lib/ledger'
import { railsReport } from '@/lib/providers'
import { EVOLUTION_BUDGET_PER_HOUR, evolutionBudgetUsed, findUnaddressedHighFindings, type HighFinding } from '@/lib/evolution'

// census.ts — פקח-הריבונות (worklog Task 30)
//
// עקרונות-ארכיטקטורה שאומצו מ-tobi/disktree (ננתח — Task 30):
//   1. "Totals are derived, never tracked" — כל-מספר כאן נגזר ממקור-אמת (DB/קבצים) בזמן-הבקשה.
//      אפס-מונים-מקבילים, אפס-סכימה-חדשה — השרשרת-הקנונית נשארת קפואה.
//   2. "Marking is never destructive" — הפקח מסמן ("שווה-מבט"), לעולם לא מוחק ולא מציע מחיקה.
//      בעלים-ריבוני מחליט מה עושים עם ממצא; האינטליגנציה קודמת לפעולה.
//   3. "Classification by kind" — כל-נכס מסווג לסוג וממופה בגודל-אמת (פסיפס-האחזות).
//   4. "The status bar never claims a saving it cannot measure" — לא-נמדד = לא-נטען;
//      לב-לא-נגיש = { reachable:false } בכנות, לא 0 מדומה.
//
// חוק-סודות: הכספת נסקרת בנוכחות-שמות בלבד — אף ערך לא נקרא לכאן ולא יוצא מכאן.

const RUNNING_STUCK_MS = 10 * 60_000 // זהה-ל-threshold-ריפוי-העצמה של ה-tick (Task 28)
const PROPOSED_STALE_MS = 6 * 60 * 60_000 // הצעה-מוגשת-לבעלים-שממתינה-מעל-6-שעות
const QUEUED_ORPHAN_MS = 5 * 60_000 // משימה-בתור-שלא-נתבעה-עדיין
const HEARTBEAT_URL = process.env.FABRIC_HEARTBEAT_URL ?? 'http://127.0.0.1:3031'
const HEARTBEAT_TIMEOUT_MS = 2_000

export type Severity = 'info' | 'watch' | 'attention'

// סיווג-סוגים (disktree classify.rs — ממופה לאחזות-הרשת)
export type EstateKind = 'execution' | 'ops' | 'delivery' | 'self-origin' | 'access' | 'memory'

export interface CensusFinding {
  id: string
  severity: Severity
  kind: EstateKind
  title: string
  detail: string
  /** איפה להסתכל — לעולם לא "מה למחוק" */
  pointer?: string
}

export interface MosaicItem {
  label: string
  kind: EstateKind
  /** המדידה האמיתית שקובעת-את-הגודל (ספירה/בתים) */
  value: number
  unit: string
  hint?: string
}

export interface MemoryDigest {
  learned: { total: number; recent: { id: string; title: string; repo: string | null; at: string }[] }
  produced: { total: number; artifacts: { id: string; title: string; repo: string; bytes: number }[] }
  delivered: { total: number; commits: { id: string; repo: string; path: string; commitSha: string | null; verified: boolean | null; at: string }[] }
  openLoops: { total: number | null; severityTop: { title: string }[] }
  note: string
}

export interface Census {
  generatedAt: string
  chain: {
    total: number
    done: number
    failed: number
    verify: VerifyResult
    head: string | null
    headAgeMs: number | null
    byKind: Record<string, number>
    errorClasses: Record<string, number>
  }
  tasks: {
    total: number
    byStatus: Record<string, number>
    byKind: Record<string, number>
    bySource: Record<string, number>
    byWorker: Record<string, number>
    stuckRunning: number
    exhausted: number
    queuedOrphans: number
  }
  handoff: {
    byStatus: Record<string, number>
    pendingApprovals: { id: string; repo: string; path: string; auto: boolean; ageMs: number }[]
    delivered: number
  }
  budget: { used: number; cap: number; remaining: number }
  access: {
    rails: ReturnType<typeof railsReport>
    vaultKeys: string[] // שמות-מפתחות בלבד — אף ערך לא עובר מכאן
  }
  heartbeat: { reachable: boolean; arteries?: Record<string, unknown> }
  storage: { dbBytes: number | null }
  worklog: { taskIdsSeen: number; lastTaskId: string | null }
  mosaic: MosaicItem[]
  worthALook: CensusFinding[]
  memory: MemoryDigest
}

function groupCount<T, K extends string>(items: T[], key: (t: T) => K): Record<K, number> {
  const out = {} as Record<K, number>
  for (const it of items) {
    const k = key(it)
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

// חומר-הזיכרון הנגזר (disktree: totals-are-derived) — מה-הרשת-זוכרת-מהשטח בלבד:
// מה-נלמד, מה-נוצר, מה-נאסף-לגיט, מה-פתוח. זו-תשתית-ניהול-הזיכרון של-העתיד —
// נגזרת-מאמת, ללא-טבלה-חדשה, ללא-מחיקה.
export async function memoryDigest(): Promise<MemoryDigest> {
  const [learnedTasks, producedTasks, delivered, highFindings] = await Promise.all([
    db.task.findMany({
      where: { source: 'learning', status: 'DONE' },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, title: true, repo: true, updatedAt: true },
    }),
    db.task.findMany({
      where: { kind: 'CODE', status: 'DONE', repo: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 25,
      select: { id: true, title: true, repo: true, output: true },
    }),
    db.handoff.findMany({
      where: { status: 'DONE' },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, repo: true, path: true, commitSha: true, verified: true, updatedAt: true },
    }),
    findUnaddressedHighFindings().catch(() => null), // כשל-כן: openLoops.total = null
  ])

  const producedTotal = await db.task.count({ where: { kind: 'CODE', status: 'DONE', repo: { not: null } } })
  const deliveredTotal = await db.handoff.count({ where: { status: 'DONE' } })
  const learnedTotal = await db.task.count({ where: { source: 'learning', status: 'DONE' } })

  // גודל-אמת של ארטיפקטים — מהתוצר עצמו (bytes של output), לא מהערכה
  const artifacts = producedTasks.map((t) => ({
    id: t.id,
    title: t.title,
    repo: t.repo as string,
    bytes: t.output ? Buffer.byteLength(t.output, 'utf8') : 0,
  }))

  return {
    learned: {
      total: learnedTotal,
      recent: learnedTasks.map((t) => ({
        id: t.id,
        title: t.title,
        repo: t.repo,
        at: t.updatedAt.toISOString(),
      })),
    },
    produced: { total: producedTotal, artifacts },
    delivered: {
      total: deliveredTotal,
      commits: delivered.map((h) => ({
        id: h.id,
        repo: h.repo,
        path: h.path,
        commitSha: h.commitSha,
        verified: h.verified,
        at: h.updatedAt.toISOString(),
      })),
    },
    openLoops: highFindings
      ? {
          total: highFindings.length,
          severityTop: highFindings.slice(0, 5).map((f: HighFinding) => ({ title: f.title })),
        }
      : { total: null, severityTop: [] },
    note: 'זיכרון-נגזר-מאמת בזמן-בקשה (ללא-מונים, ללא-סכימה-חדשה) — תשתית-ניהול-זיכרון עתידי; אף-דבר-לא-נמחק-מאף-מקור',
  }
}

// "שווה-מבט" (disktree: Worth-a-look) — הגדולים-והבולטים-שכדאי-להביט-בהם.
// מסמן-בלבד: אף-ממצא כאן לא מבצע, לא מוחק, ולא מציע מחיקה.
async function worthALook(input: {
  stuckRunning: { id: string; title: string; updatedAt: Date }[]
  failedByClass: Record<string, number>
  failedRecent: { id: string; title: string; errorClass: string | null; updatedAt: Date }[]
  staleProposals: { id: string; repo: string; path: string; ageMs: number }[]
  exhausted: { id: string; title: string }[]
  queuedOrphans: { id: string; title: string; createdAt: Date }[]
  budgetUsed: number
  highOpen: number | null
  heartbeatReachable: boolean
  verify: VerifyResult
}): Promise<CensusFinding[]> {
  const f: CensusFinding[] = []

  for (const t of input.stuckRunning.slice(0, 3)) {
    f.push({
      id: `stuck:${t.id}`,
      severity: 'attention',
      kind: 'execution',
      title: `משימה תקועה ב-RUNNING: ${t.title}`,
      detail: 'מעל 10 דק׳ בהרצה — ה-tick ירפא אוטומטית (ריפוי-עצמי), ראוי להביט',
      pointer: `/api/tasks/${t.id}`,
    })
  }

  const worstClass = Object.entries(input.failedByClass)
    .sort((a, b) => b[1] - a[1])
    .find(([, n]) => n >= 2)
  if (worstClass) {
    f.push({
      id: `errors:${worstClass[0]}`,
      severity: worstClass[1] >= 5 ? 'attention' : 'watch',
      kind: 'execution',
      title: `ריכוז-כשלים במחלקה "${worstClass[0]}" (${worstClass[1]})`,
      detail: 'חתומים-בכנות בשרשרת — ראוי להבין-תבנית',
      pointer: '/api/metrics',
    })
  }

  for (const h of input.staleProposals.slice(0, 3)) {
    f.push({
      id: `stale-proposal:${h.id}`,
      severity: 'watch',
      kind: 'delivery',
      title: `הצעת-העברה ממתינה לאישורך (${Math.round(h.ageMs / 3600_000)} שעות): ${h.repo}/${h.path}`,
      detail: 'השער-ממתין-ריבוני — אף-פריסה בלי-אישור-בעלים',
      pointer: `/api/handoffs/${h.id}`,
    })
  }

  for (const t of input.exhausted.slice(0, 2)) {
    f.push({
      id: `exhausted:${t.id}`,
      severity: 'watch',
      kind: 'execution',
      title: `סולם-מוצה: ${t.title}`,
      detail: 'כל-המועמדים נוסו ונדחו בכנות — ניסיון-חוזר הוא החלטת-בעלים',
      pointer: `/api/tasks/${t.id}`,
    })
  }

  for (const t of input.queuedOrphans.slice(0, 2)) {
    f.push({
      id: `orphan:${t.id}`,
      severity: 'info',
      kind: 'execution',
      title: `משימה בתור ${Math.round((Date.now() - t.createdAt.getTime()) / 60_000)} דק׳: ${t.title}`,
      detail: 'עובד-הלב יתבע בפעימה-הבאה — אינפורמטיבי',
      pointer: `/api/tasks/${t.id}`,
    })
  }

  if (input.budgetUsed >= EVOLUTION_BUDGET_PER_HOUR) {
    f.push({
      id: 'budget:exhausted',
      severity: 'info',
      kind: 'self-origin',
      title: `תקציב-ההתפתחות השעתי מוצה (${input.budgetUsed}/${EVOLUTION_BUDGET_PER_HOUR})`,
      detail: 'הפעימה-הבאה תנסה שוב בשעה-החדשה — כנות-תקציב',
      pointer: '/api/evolution',
    })
  }

  if (input.highOpen != null && input.highOpen > 0) {
    f.push({
      id: 'high:open',
      severity: input.highOpen >= 10 ? 'attention' : 'watch',
      kind: 'memory',
      title: `${input.highOpen} ממצאי-HIGH פתוחים מביקורות-עצמיות`,
      detail: 'לולאת-הלמידה מעכלת-בקצב-התקציב — עדשת-מציאות על-הרשת-עצמה',
      pointer: '/api/evolution',
    })
  }

  if (!input.heartbeatReachable) {
    f.push({
      id: 'heartbeat:down',
      severity: 'attention',
      kind: 'ops',
      title: 'הלב (fabric-heartbeat) לא נגיש',
      detail: 'עורקי-tick/גיט/התפתחות/שומר-לא-נמדדו — כנות: לא 0, לא-נגיש',
      pointer: HEARTBEAT_URL,
    })
  }

  if (!input.verify.ok) {
    f.push({
      id: 'chain:broken',
      severity: 'attention',
      kind: 'memory',
      title: `שרשרת-האמת שבורה ב-(${input.verify.brokenAt})`,
      detail: 'fail-closed — זו-העדות-הקריטית ביותר להביט-בה-מיד',
      pointer: '/api/ledger',
    })
  }

  return f
}

async function heartbeatState(): Promise<Census['heartbeat']> {
  try {
    const res = await fetch(HEARTBEAT_URL, { signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) })
    if (!res.ok) return { reachable: false }
    const d = (await res.json()) as Record<string, unknown>
    return { reachable: true, arteries: d }
  } catch {
    return { reachable: false } // כנות: לא-נגיש — לא-מדומה
  }
}

function vaultKeyNames(): string[] {
  // נוכחות-שמות בלבד — אף ערך לא נקרא/נפרס (חוק-אפס-סודות)
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'upload', 'llm.env'), 'utf8')
    return [...raw.matchAll(/^([A-Za-z0-9_]+)=/gm)].map((m) => m[1])
  } catch {
    return []
  }
}

function worklogTasks(): { taskIdsSeen: number; lastTaskId: string | null } {
  // נגזר-מהקובץ בזמן-בקשה — אין-מסד-משימות מקביל (disktree: derived)
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'worklog.md'), 'utf8')
    const ids = [...raw.matchAll(/^Task ID:\s*(\S+)$/gm)].map((m) => m[1])
    return { taskIdsSeen: ids.length, lastTaskId: ids.at(-1) ?? null }
  } catch {
    return { taskIdsSeen: 0, lastTaskId: null }
  }
}

export async function buildCensus(): Promise<Census> {
  const [entries, tasks, handoffs, budgetUsed, heart, memory, highOpen] = await Promise.all([
    db.ledgerEntry.findMany({ orderBy: { id: 'asc' } }),
    db.task.findMany({
      select: {
        id: true, title: true, kind: true, status: true, source: true, worker: true,
        repo: true, createdAt: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    }),
    db.handoff.findMany({ orderBy: { updatedAt: 'desc' }, select: { id: true, repo: true, path: true, status: true, auto: true, updatedAt: true } }),
    evolutionBudgetUsed(),
    heartbeatState(),
    memoryDigest(),
    findUnaddressedHighFindings().catch(() => null),
  ])

  const verify = verifyChain(entries)
  const head = entries.at(-1)?.hash ?? null
  const headAgeMs = head ? Date.now() - (entries.at(-1)?.createdAt.getTime() ?? 0) : null

  const byStatus = groupCount(tasks, (t) => t.status)
  const stuck = tasks.filter(
    (t) => t.status === 'RUNNING' && Date.now() - t.updatedAt.getTime() > RUNNING_STUCK_MS
  )
  const exhausted = tasks.filter((t) => t.worker === 'exhausted')
  const queuedOrphans = tasks.filter(
    (t) => t.status === 'QUEUED' && Date.now() - t.createdAt.getTime() > QUEUED_ORPHAN_MS
  )
  const failedRecent = tasks
    .filter((t) => t.status === 'FAILED')
    .slice(0, 25)
  const failedByClass = groupCount(
    failedRecent,
    (t) => t.errorClass ?? 'unknown'
  )

  const pending = handoffs.filter((h) => h.status === 'PROPOSED')
  const staleProposals = pending
    .map((h) => ({ id: h.id, repo: h.repo, path: h.path, ageMs: Date.now() - h.updatedAt.getTime() }))
    .filter((h) => h.ageMs > PROPOSED_STALE_MS)

  const handoffByStatus = groupCount(handoffs, (h) => h.status)

  // פסיפס-האחזות (disktree treemap) — גודל=מדידת-אמת, סוג=סיווג
  const byKind = groupCount(entries, (e) => e.kind)
  const executionCount = (byKind.CODE ?? 0) + (byKind.AUDIT ?? 0) + (byKind.PLAN ?? 0)
  const opsCount = (byKind.DRILL ?? 0) + (byKind.BATCH ?? 0) + (byKind.FLEET ?? 0)
  const deliveryCount = byKind.HANDOFF ?? 0
  const selfOrigin = tasks.filter((t) => t.source === 'evolution' || t.source === 'learning').length
  const mosaic: MosaicItem[] = [
    { label: 'ביצוע (CODE/AUDIT/PLAN)', kind: 'execution', value: executionCount, unit: 'רשומות-שרשרת', hint: 'משימות-פיתוח שבוצעו ונחתמו' },
    { label: 'תפעול (DRILL/BATCH/FLEET)', kind: 'ops', value: opsCount, unit: 'רשומות-שרשרת', hint: 'בדיקות-חיות וציי-ביקורת' },
    { label: 'אספקה-לגיט (HANDOFF)', kind: 'delivery', value: deliveryCount, unit: 'רשומות-שרשרת', hint: 'פריסות-מאושרות-בעלים' },
    { label: 'מוצא-עצמי (evolution+learning)', kind: 'self-origin', value: selfOrigin, unit: 'משימות', hint: 'הרשת-מציעה-לעצמה-עבודה' },
    { label: 'זיכרון-פתוח (ממצאי-HIGH)', kind: 'memory', value: highOpen?.length ?? 0, unit: 'ממצאים', hint: 'לולאת-הלמידה בעיכול' },
    { label: 'מסילות-גישה', kind: 'access', value: 1 + (railsReport().nvidia.present ? 1 : 0), unit: 'מסילות-פעילות', hint: 'zai תמיד; nvidia אם-מוגדר' },
  ]

  const worthALookFindings = await worthALook({
    stuckRunning: stuck.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })),
    failedByClass,
    failedRecent: failedRecent.map((t) => ({ id: t.id, title: t.title, errorClass: t.errorClass, updatedAt: t.updatedAt })),
    staleProposals,
    exhausted: exhausted.map((t) => ({ id: t.id, title: t.title })),
    queuedOrphans: queuedOrphans.map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt })),
    budgetUsed,
    highOpen: highOpen?.length ?? null,
    heartbeatReachable: heart.reachable,
    verify,
  })

  let dbBytes: number | null = null
  try {
    dbBytes = fs.statSync(path.join(process.cwd(), 'db', 'custom.db')).size
  } catch {
    dbBytes = null // לא-נמדד = לא-נטען
  }

  const vaultKeys = vaultKeyNames()

  return {
    generatedAt: new Date().toISOString(),
    chain: {
      total: entries.length,
      done: entries.filter((e) => e.status === 'DONE').length,
      failed: entries.filter((e) => e.status === 'FAILED').length,
      verify,
      head,
      headAgeMs,
      byKind,
      errorClasses: groupCount(entries.filter((e) => e.errorClass), (e) => e.errorClass as string),
    },
    tasks: {
      total: tasks.length,
      byStatus,
      byKind: groupCount(tasks, (t) => t.kind),
      bySource: groupCount(tasks, (t) => t.source ?? 'human'),
      byWorker: groupCount(tasks.filter((t) => t.worker), (t) => t.worker as string),
      stuckRunning: stuck.length,
      exhausted: exhausted.length,
      queuedOrphans: queuedOrphans.length,
    },
    handoff: {
      byStatus: handoffByStatus,
      pendingApprovals: pending.map((h) => ({
        id: h.id, repo: h.repo, path: h.path, auto: h.auto, ageMs: Date.now() - h.updatedAt.getTime(),
      })),
      delivered: handoffByStatus.DONE ?? 0,
    },
    budget: { used: budgetUsed, cap: EVOLUTION_BUDGET_PER_HOUR, remaining: Math.max(0, EVOLUTION_BUDGET_PER_HOUR - budgetUsed) },
    access: { rails: railsReport(), vaultKeys },
    heartbeat: heart,
    storage: { dbBytes },
    worklog: worklogTasks(),
    mosaic,
    worthALook: worthALookFindings,
    memory,
  }
}
