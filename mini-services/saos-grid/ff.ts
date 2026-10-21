// ===== עורק-FF — FixedFloat: שער-ההמרה של התוצרת לכסף-אמיתי (BTC) =====
// המפתח-חי-בכספת (upload/fffixedflot.txt / upload/ff.env) — לעולם-לא-ייצא-מהמכונה.
// כנות: כל-תשובה-כושלת-מדווחת-בשמה; אין-המצאת-זוגות-או-שערים.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const FF_API = 'https://fixedfloat.com/api/v2'

function ffKey(): { key: string; source: string } | { key: null; source: string } {
  // תבנית-1: upload/ff.env (KEY=<api-key>)
  const envPath = join(ROOT, 'upload', 'ff.env')
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf-8').split('\n').find((l) => l.startsWith('KEY='))
    const v = line?.split('=').slice(1).join('=').trim()
    if (v) return { key: v, source: 'ff.env' }
  }
  // תבנית-2: upload/fffixedflot.txt — שורה-אחרי-"api key"
  const raw = join(ROOT, 'upload', 'fffixedflot.txt')
  if (existsSync(raw)) {
    const lines = readFileSync(raw, 'utf-8').split('\n').map((l) => l.trim())
    const idx = lines.findIndex((l) => l.toLowerCase() === 'api key' || l.toLowerCase() === 'api-key')
    const cand = idx >= 0 ? lines[idx + 1] : lines.find((l) => l.length >= 30 && /^[A-Za-z0-9]+$/.test(l))
    if (cand) return { key: cand.trim(), source: 'fffixedflot.txt' }
  }
  return { key: null, source: 'לא-נמצא-מפתח-בכספת' }
}

// חתימת-FixedFloat: HMAC-SHA256(body, apiKey) — המפתח-הוא-גם-הסוד (לפי-ה-API)
async function ffPost<T>(method: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const k = ffKey()
  if (!k.key) return { ok: false, error: k.source }
  const payload = JSON.stringify({ ...body, apikey: k.key })
  const mac = new Bun.CryptoHasher('sha256')
  mac.update(payload)
  // HMAC: CryptoHasher לא-תומך-HMAC-ישירות → node:crypto
  const { createHmac } = await import('node:crypto')
  const sig = createHmac('sha256', k.key).update(payload).digest('hex')
  try {
    const res = await fetch(`${FF_API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', APIKey: k.key, Payload: payload, Signature: sig },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    const j = JSON.parse(text) as { code?: number; msg?: string; data?: T }
    if (j.code !== undefined && j.code !== 0) return { ok: false, error: `FF-${j.code}: ${j.msg ?? '?'}` }
    return { ok: true, data: (j.data ?? (j as unknown as T)) as T }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type FfStatus = {
  keyFound: boolean
  source: string
  currencies: number | null
  steemSupported: boolean
  btcSupported: boolean
  samplePairs: string[]
  lastError: string | null
  checkedAt: string | null
}
let cache: FfStatus | null = null

export async function probe(): Promise<FfStatus> {
  if (cache && Date.now() - new Date(cache.checkedAt ?? 0).getTime() < 5 * 60_000) return cache
  const k = ffKey()
  const out: FfStatus = {
    keyFound: !!k.key,
    source: k.source,
    currencies: null,
    steemSupported: false,
    btcSupported: false,
    samplePairs: [],
    lastError: null,
    checkedAt: new Date().toISOString(),
  }
  const r = await ffPost<{ currencies: Array<{ network: string; code: string; name: string }> }>('getCurrencies', {})
  if (!r.ok) {
    out.lastError = r.error
    cache = out
    return out
  }
  const cur = r.data.currencies ?? []
  out.currencies = cur.length
  out.steemSupported = cur.some((c) => /steem/i.test(c.code) || /steem/i.test(c.network))
  out.btcSupported = cur.some((c) => /btc/i.test(c.code))
  out.samplePairs = cur.slice(0, 12).map((c) => c.code)
  cache = out
  return out
}
