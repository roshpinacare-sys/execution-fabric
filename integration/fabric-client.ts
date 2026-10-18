// fabric-client — חוזה-הצריכה היציב של רשת-הביצוע (Task 27b)
//
// לקוח-ייחוס לצרכנים חיצוניים: **הארכיטקטורה** ו**הריבונות** (וכל-מערכת שצריכה
// כוח-ביצוע). אפס-תלות — fetch בלבד; עובד ב-bun/node/דפדפן ללא-שינוי.
//
// עקרונות-החוזה (זהים-לרשת עצמה):
//   · שיגור = מיידי (201 + batchId) — הביצוע חי ברקע (עובד-השרת קולט לבד).
//   · אף-תוצר לא מדומה: כל-משימה = ירי-LLM אמיתי, כשל = חתום בכנות (errorClass).
//   · אימות-שרשרת fail-closed — הלדג'ר הוא-עד-האמת.
//   · סודות-אפס: הלקוח הזה אף-פעם לא נוגע במפתחות — רק בחוזה-ה-REST.
//
// שימוש:
//   import { FabricClient } from './fabric-client'
//   const fabric = new FabricClient('http://127.0.0.1:3000')
//   const { batchId } = await fabric.dispatchBatch({ title: '...', kind: 'PLAN', prompt: '...', count: 3 })
//   const done = await fabric.waitForBatch(batchId) // סקר-עד-סוף-חיים (timeout כן)
//   const chain = await fabric.ledger()             // אימות-שרשרת מלא

export type TaskKind = 'CODE' | 'AUDIT' | 'PLAN'

export interface DispatchTaskSpec {
  title: string
  kind: TaskKind
  prompt: string
  /** ריפו-יעד אופציונלי (owner/name) — נאמת-חי לפני-קבלה; לא-קיים = דחייה-כנה */
  repo?: string
}

export interface DispatchBatchInput {
  tasks: DispatchTaskSpec[]
  /** מקביליות-מרבית של ניקוז-האצווה (ברירת-מחדל 3) */
  parallel?: number
}

export interface DispatchBulkInput {
  title: string
  kind: TaskKind
  prompt: string
  count: number
  repo?: string
  parallel?: number
}

export interface DispatchResult {
  ok: true
  batchId: string
  parallel: number
  created: number
}

export interface TaskStatus {
  id: string
  kind: TaskKind
  title: string
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'
  worker: string | null
  errorClass: string | null
  attempts: number
  /** JSON-מקודד לפי-חוזה-ה-kind (למשל PLAN: {"steps":[{title,detail}]}) — null בכשל */
  output: string | null
  durationMs: number | null
  batchId: string | null
  outputHash: string | null
  error?: string | null
  createdAt?: string
  updatedAt?: string
}

/** פענוח-כן של-תוצר: JSON לא-תקין = זריקה (אף-שקר) */
export function parseOutput<T = Record<string, unknown>>(task: TaskStatus): T | null {
  if (task.output == null) return null
  return JSON.parse(task.output) as T
}

export interface BatchStatus {
  batchId: string
  terminal: boolean
  counts: { DONE: number; FAILED: number; RUNNING: number; QUEUED: number }
  tasks: TaskStatus[]
  receipt?: unknown
}

export interface LedgerVerify {
  ok: boolean
  head: string | null
  brokenAt: string | number | null
  verified: number
}

export interface HealthResult {
  ok: boolean
  db: boolean
  time: string
}

export class FabricError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `fabric API ${status}`)
    this.name = 'FabricError'
    this.status = status
    this.body = body
  }
}

export class FabricTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`fabric: ${what} לא הושלם תוך ${timeoutMs}ms — כנות: לא-נמתין-לנצח`)
    this.name = 'FabricTimeoutError'
  }
}

export interface FabricClientOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export class FabricClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly f: typeof fetch

  constructor(baseUrl = 'http://127.0.0.1:3000', opts: FabricClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.f = opts.fetchImpl ?? fetch
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const b = body as { error?: string } | null
      throw new FabricError(res.status, body, b?.error ?? `fabric API ${res.status}`)
    }
    return body as T
  }

  /** דופק הרשת — {ok, db, time} */
  async health(): Promise<HealthResult> {
    return this.call<HealthResult>('/api/health')
  }

  /** שיגור-משימה-בודדת לתור — העובד-החי קולט לבד */
  async dispatchTask(spec: DispatchTaskSpec): Promise<{ ok: true; task: TaskStatus }> {
    return this.call('/api/tasks', { method: 'POST', body: JSON.stringify(spec) })
  }

  /** שיגור-אצווה מקבילה — 201 מיידי עם batchId; הביצוע חי ברקע */
  async dispatchBatch(input: DispatchBatchInput | DispatchBulkInput): Promise<DispatchResult> {
    return this.call('/api/batches', { method: 'POST', body: JSON.stringify(input) })
  }

  /** סקר-מצב אצווה: ספירות + משימות + קבלה */
  async batchStatus(batchId: string): Promise<BatchStatus> {
    return this.call<BatchStatus>(`/api/batches/${encodeURIComponent(batchId)}`)
  }

  /** תוצר-מלא של משימה (כולל output חתום) */
  async task(id: string): Promise<{ ok: true; task: TaskStatus }> {
    return this.call(`/api/tasks/${encodeURIComponent(id)}`)
  }

  /** השרשרת המלאה + אימות fail-closed */
  async ledger(): Promise<{ entries: unknown[]; verify: LedgerVerify }> {
    return this.call('/api/ledger')
  }

  /** מדדי-הרשת מהדאטה בלבד (אימות + פילוחי-יעילות) */
  async metrics(): Promise<Record<string, unknown>> {
    return this.call('/api/metrics')
  }

  /**
   * לופ-ההתפתחות/הלמידה של הרשת (Task 28) — גם הארכיטקטורה והריבונות יכולות להפעיל אותו:
   *  - 'auto' (ברירת-מחדל): הרשת מחליטה — ממצא-HIGH לא-מטופל → מחזור-למידה; אחרת → הצעה-עצמית.
   *  - 'propose': הצעה-עצמית בלבד.
   *  - 'learn': למידה בלבד — אין ממצא-HIGH פתוח = 404 {errorClass:'nothing-to-learn'} (כנות).
   * כל מחזור = ירי-LLM אמיתי; תקציב-שעתי 12 (429 = מוצה; Task 29). המשימה שנשגרת מבוצעת-ונחתמת בשרשרת.
   */
  async evolution(
    mode: 'auto' | 'propose' | 'learn' = 'auto'
  ): Promise<{ ok: true; mode: string; taskId: string; proposal: Record<string, unknown> }> {
    return this.call('/api/evolution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
  }

  /** היסטוריית-המחזורים-העצמיים + תקציב + ממצאי-HIGH פתוחים */
  async evolutionStatus(): Promise<Record<string, unknown>> {
    return this.call('/api/evolution')
  }

  /**
   * שער-ההעברה (Task 20 + Task 29) — פריסה-מאושרת-לגיט:
   * הארכיטקטורה/הריבונות שוגרות משימה (dispatchTask/waitForBatch), ממתינות ל-DONE,
   * ומציעות את התוצר לפריסה לריפו-יעד. ההצעה נולדת PROPOSED — אישור-בעלים מחייב
   * (approve → execute → putContents + read-back-אומת). תוצר-CODE של למידה/התפתחות
   * עם יעד-ריפו נכנס לשער אוטומטית (auto=true).
   */
  async proposeHandoff(
    input: { taskId: string; repo: string; path: string; message: string; branch?: string; field?: string }
  ): Promise<{ ok: true; handoff: Record<string, unknown>; org: string }> {
    return this.call('/api/handoffs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  }

  /** רשימת-ההצעות-והקבלות של שער-ההעברה (20 אחרונות) */
  async handoffs(): Promise<{ ok: true; handoffs: Record<string, unknown>[] }> {
    return this.call('/api/handoffs')
  }

  /** סקר-הצעת-העברה בודדת (מצב/קומיט/אימות) */
  async handoffStatus(id: string): Promise<{ ok: true; handoff: Record<string, unknown> }> {
    return this.call(`/api/handoffs/${encodeURIComponent(id)}`)
  }

  /** אישור-בעלים על הצעת-העברה (PROPOSED → APPROVED) — השער-הריבוני */
  async approveHandoff(id: string): Promise<{ ok: true; handoff: Record<string, unknown> }> {
    return this.call(`/api/handoffs/${encodeURIComponent(id)}/approve`, { method: 'POST' })
  }

  /** ביצוע-העברה מאושרת (APPROVED → putContents + read-back מאומת → DONE) */
  async executeHandoff(id: string): Promise<{ ok: boolean; handoff?: Record<string, unknown>; error?: string }> {
    return this.call(`/api/handoffs/${encodeURIComponent(id)}/execute`, { method: 'POST' })
  }

  /**
   * פקח-הריבונות (Task 30) — אינטליגנציית-אחזות מלאה, נגזרת-מאמת בזמן-הקריאה:
   * שרשרת/משימות/שער/תקציב/מסילות/לב/פסיפס-סוגים/שווה-מבט (ממצאים-לא-הרסניים) + חומר-הזיכרון.
   * עקרונות (tobi/disktree): נגזר-לעולם-לא-נעקב; מסמן-ולא-מוחק; לא-נמדד = לא-נטען.
   */
  async census(): Promise<{ ok: true; census: Record<string, unknown> }> {
    return this.call('/api/census')
  }

  /** חומר-הזיכרון הנגזר בלבד (מה-נלמד/נוצר/נאסף-לגיט/פתוח) — תשתית-ניהול-זיכרון */
  async memoryDigest(): Promise<{ ok: true; memory: Record<string, unknown> }> {
    return this.call('/api/census?view=memory')
  }

  /**
   * סקר-אצווה עד-סוף-חיים (כל-המשימות DONE/FAILED) — timeout כן שמעיד-אמת.
   * אין-הימור: אם-לא-הסתיים-בזמן — FabricTimeoutError, לעולם לא שקר-של-הצלחה.
   */
  async waitForBatch(
    batchId: string,
    opts: { intervalMs?: number; timeoutMs?: number } = {}
  ): Promise<BatchStatus> {
    const intervalMs = opts.intervalMs ?? 2_000
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const st = await this.batchStatus(batchId)
      if (st.terminal) return st
      if (Date.now() >= deadline) throw new FabricTimeoutError(`batch ${batchId}`, timeoutMs)
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
}
