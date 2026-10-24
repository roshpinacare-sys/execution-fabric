// ═════════════════════════════════════════════════════════════════════════════
// mesh.test.ts — רשת-ה-failover-RPC (הנחיית-בעלים §3: "Local Mesh Gateway,
// zero single-endpoint dependency") — TDD עם fetch מוזרק (דטרמיניזם מלא).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { RpcMesh, type MeshEndpoint } from './mesh'

const EPS: MeshEndpoint[] = [
  { name: 'a', url: 'https://a.test' },
  { name: 'b', url: 'https://b.test' },
  { name: 'c', url: 'https://c.test' },
]

type Call = { url: string; body: unknown }
/** fetch-מזויף-דטרמיניסטי: מקבל-מפת-התנהגות url→(כשל|תשובה) ומקליט-סדר-קריאות. */
function fakeFetch(behavior: (url: string) => 'fail' | { result: unknown } | { error: { message: string } }, calls: Call[]) {
  return (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null })
    const r = behavior(u)
    if (r === 'fail') throw new Error('boom')
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, ...r }), { status: 200 })
  }) as typeof fetch
}

const RPC = { jsonrpc: '2.0', method: 'condenser_api.get_order_book', params: [50], id: 1 }

describe('RpcMesh — failover נאמן', () => {
  test('הראשון-נופל → השני עונה; tried מתעד-את-שניהם', async () => {
    const calls: Call[] = []
    const m = new RpcMesh(EPS, { fetchImpl: fakeFetch((u) => (u.includes('a.') ? 'fail' : { result: { ok: 1 } }), calls) })
    const r = await m.call('condenser_api.get_order_book', [50])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.endpoint).toBe('b')
      expect((r.data as { ok: number }).ok).toBe(1)
    }
    expect(r.ok ? r.tried : []).toContain('a')
  })

  test('הצמדות-הדבקה: המצליח-האחרון ראשון בתור הבא', async () => {
    const calls: Call[] = []
    const m = new RpcMesh(EPS, { fetchImpl: fakeFetch((u) => (u.includes('a.') ? 'fail' : { result: 1 }), calls) })
    await m.call('m', [])
    calls.length = 0
    await m.call('m', [])
    expect(calls[0].url).toContain('b.') // הדבק-ראשון
  })

  test('jsonrpc-error נחשב-כשל-צומת → failover להבא', async () => {
    const calls: Call[] = []
    const m = new RpcMesh(EPS, {
      fetchImpl: fakeFetch((u) => (u.includes('a.') ? { error: { message: 'Bad Cast' } } : { result: 7 }), calls),
    })
    const r = await m.call('m', [])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.endpoint).toBe('b')
  })
})

describe('RpcMesh — שובר-המעגלים (רשת-צומת-בודדת — ההצמדה-הדבקה אינה-מגנה-כאן)', () => {
  test('נפילות-רצופות ≥ openAfterFails → open; הצומת-הפתוח-מדולג', async () => {
    const calls: Call[] = []
    const m = new RpcMesh(EPS.slice(0, 1), {
      openAfterFails: 3,
      fetchImpl: fakeFetch(() => 'fail', calls),
    })
    for (let i = 0; i < 3; i++) {
      const r = await m.call('m', [])
      expect(r.ok).toBe(false) // כנות: אין-למי-לענות
    }
    expect(calls.length).toBe(3) // כל-מחזור ניסה
    calls.length = 0
    const r = await m.call('m', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.tried).toEqual([]) // השובר-פתוח — אפס-ניסיונות
    expect(calls.length).toBe(0)
    const h = m.health().find((x) => x.name === 'a')!
    expect(h.state).toBe('open')
    expect(h.consecFails).toBe(3)
  })

  test('half-open: אחרי-הצינון מנסה-שוב; הצלחה → closed', async () => {
    const calls: Call[] = []
    let aFail = true
    const m = new RpcMesh(EPS.slice(0, 1), {
      openAfterFails: 2,
      halfOpenAfterMs: 50,
      fetchImpl: fakeFetch(() => (aFail ? 'fail' : { result: 1 }), calls),
    })
    await m.call('m', [])
    await m.call('m', []) // נפל פעמיים → open
    expect(m.health().find((x) => x.name === 'a')!.state).toBe('open')
    await new Promise((r) => setTimeout(r, 60)) // צינון
    aFail = false
    calls.length = 0
    const r = await m.call('m', [])
    expect(r.ok).toBe(true)
    expect(calls.length).toBe(1) // התנסה-מחדש (half-open) והצליח
    expect(m.health().find((x) => x.name === 'a')!.state).toBe('closed')
  })

  test('half-open-כישלון → open-מחדש (ניסיון-התנסות-יחיד, לא-מציף-ברצף)', async () => {
    const calls: Call[] = []
    const m = new RpcMesh(EPS.slice(0, 1), {
      openAfterFails: 1,
      halfOpenAfterMs: 30,
      fetchImpl: fakeFetch(() => 'fail', calls),
    })
    await m.call('m', []) // → open
    await new Promise((r) => setTimeout(r, 40))
    calls.length = 0
    await m.call('m', []) // half-open: ניסיון-אחד → נופל → open-מחדש
    expect(calls.length).toBe(1)
    expect(m.health().find((x) => x.name === 'a')!.state).toBe('open')
    calls.length = 0
    await m.call('m', []) // עדיין-פתוח (הצינון-לא-חלף) — אפס-קריאות
    expect(calls.length).toBe(0)
  })
})

describe('RpcMesh — כנות-מלאה', () => {
  test('כל-הצמתים-נופלים → ok:false כנה עם-רשימת-הניסיונות', async () => {
    const m = new RpcMesh(EPS, { fetchImpl: fakeFetch(() => 'fail', []) })
    const r = await m.call('m', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('all-endpoints-unavailable')
  })

  test('health מדווח-מדידות-אמת (ok/fails/lastError/latency)', async () => {
    const m = new RpcMesh(EPS.slice(0, 2), { fetchImpl: fakeFetch((u) => (u.includes('a.') ? 'fail' : { result: 1 }), []) })
    await m.call('m', [])
    const h = m.health()
    const a = h.find((x) => x.name === 'a')!
    const b = h.find((x) => x.name === 'b')!
    expect(a.fails).toBe(1)
    expect(a.lastError).toContain('boom')
    expect(b.ok).toBe(1)
    expect(b.latencyMs).not.toBeNull()
    expect(b.state).toBe('closed')
  })
})
