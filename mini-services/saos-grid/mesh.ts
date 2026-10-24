// ═════════════════════════════════════════════════════════════════════════════
// mesh.ts — רשת-ה-failover-RPC של הגריד (הנחיית-בעלים §3 — Local Mesh Gateway)
// "הפרוטוקול מסתמך על צמתים ציבוריים הסובלים ממגבלות קצב והתנתקויות" — התרופה:
// רשת-צמתים-מרובה + שובר-מעגלים (closed→open→half-open) + הצמדה-דבקה + מדידות-אמת.
//
// טהור-למחצה: fetch מוזרק (בדיקות-דטרמיניסטיות); אפס-שעון-פנימי (Date.now חי —
// הצינון-מדיד; הבדיקות ממתינות-בפועל 30-60ms). כל-החלטה מדווחת-בשמה.
// ═════════════════════════════════════════════════════════════════════════════

export interface MeshEndpoint {
  name: string
  url: string
}

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface EndpointHealth {
  name: string
  url: string
  state: BreakerState
  consecFails: number
  ok: number
  fails: number
  lastError: string | null
  lastOkAt: string | null
  latencyMs: number | null
}

export type MeshCallResult<T> =
  | { ok: true; data: T; endpoint: string; latencyMs: number; tried: string[] }
  | { ok: false; error: string; tried: string[] }

export interface MeshOpts {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** נפילות-רצופות שאחריהן הצומת-נפתח (ברירת-מחדל 3) */
  openAfterFails?: number
  /** צינון-לפני-התנסות-מחדש (half-open; ברירת-מחדל 30_000) */
  halfOpenAfterMs?: number
}

interface EndpointRuntime extends MeshEndpoint {
  state: BreakerState
  consecFails: number
  ok: number
  fails: number
  lastError: string | null
  lastOkAt: string | null
  latencyMs: number | null
  openedAt: number | null
}

export class RpcMesh {
  private eps: EndpointRuntime[]
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly openAfterFails: number
  private readonly halfOpenAfterMs: number

  constructor(endpoints: MeshEndpoint[], opts: MeshOpts = {}) {
    this.eps = endpoints.map((e) => ({ ...e, state: 'closed', consecFails: 0, ok: 0, fails: 0, lastError: null, lastOkAt: null, latencyMs: null, openedAt: null }))
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 8_000
    this.openAfterFails = opts.openAfterFails ?? 3
    this.halfOpenAfterMs = opts.halfOpenAfterMs ?? 30_000
  }

  /** סדר-הניסיון: המצליח-האחרון-ראשון (הצמדה-דבקה); פתוחים מדולגים עד-צינון. */
  private order(): EndpointRuntime[] {
    const now = Date.now()
    const eligible = this.eps.filter((e) => {
      if (e.state === 'open' && e.openedAt !== null && now - e.openedAt >= this.halfOpenAfterMs) {
        e.state = 'half-open' // צינון-חלף — ניסיון-התנסות-אחד
        e.openedAt = null
      }
      return e.state !== 'open'
    })
    return eligible
  }

  private recordOk(e: EndpointRuntime, latencyMs: number): void {
    e.state = 'closed'
    e.consecFails = 0
    e.ok++
    e.lastOkAt = new Date().toISOString()
    e.latencyMs = latencyMs
    e.openedAt = null
    // הצמדה-דבקה: המצליח-ראשון
    const i = this.eps.indexOf(e)
    if (i > 0) this.eps.unshift(this.eps.splice(i, 1)[0])
  }

  private recordFail(e: EndpointRuntime, err: string): void {
    e.fails++
    e.consecFails++
    e.lastError = err
    if (e.state === 'half-open' || e.consecFails >= this.openAfterFails) {
      e.state = 'open'
      e.openedAt = Date.now()
    }
  }

  /** קריאת-JSON-RPC עם-failover: נסה-צמתים-בתור; הצלחה-ראשונה זוכה. */
  async call<T>(method: string, params: unknown[]): Promise<MeshCallResult<T>> {
    const tried: string[] = []
    for (const e of this.order()) {
      tried.push(e.name)
      const t0 = Date.now()
      try {
        const res = await this.fetchImpl(e.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (!res.ok) {
          this.recordFail(e, `HTTP ${res.status}`)
          continue
        }
        const j = (await res.json()) as { result?: T; error?: { message?: string } }
        if (j.error) {
          this.recordFail(e, j.error.message ?? 'rpc error')
          continue
        }
        if (j.result === undefined || j.result === null) {
          this.recordFail(e, 'empty result')
          continue
        }
        const latency = Date.now() - t0
        this.recordOk(e, latency)
        return { ok: true, data: j.result, endpoint: e.name, latencyMs: latency, tried }
      } catch (err) {
        this.recordFail(e, err instanceof Error ? err.message : String(err))
        continue
      }
    }
    return { ok: false, error: `all-endpoints-unavailable (${tried.join(', ') || 'no-eligible-endpoints'})`, tried }
  }

  health(): EndpointHealth[] {
    return this.eps.map((e) => ({
      name: e.name, url: e.url, state: e.state, consecFails: e.consecFails,
      ok: e.ok, fails: e.fails, lastError: e.lastError, lastOkAt: e.lastOkAt, latencyMs: e.latencyMs,
    }))
  }
}
