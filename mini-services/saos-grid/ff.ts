// ===== עורק-FF — FixedFloat: שער-ההמרה של התוצרת לכסף-אמיתי (BTC/ETH/SOL…) =====
// Task-141-a: תיקון-שורש-כפול שנמדד-חי (26/10):
//   1) מנתח-הכספת-הישן-לא-מצא-את-פורמט-ההודעות-של-הבעלים ("[ts] Head Corner: Api key"
//      ואחריו-שורת-אסימון-עם-תחילית-הודעה) → keyFound:false תמידי → העורק-לא-ניסה-אפילו.
//   2) החתימה-הישנה-הייתה-HMAC(Payload, ApiKey) — לפי-FixedFloat-API-v2 החתימה-היא
//      HMAC-SHA256(Payload, ApiSecret). הסוד-מעולם-לא-נפרס-כלל.
// חוק-כספות: מפתחות-מעולם-לא-יוצאים-מהמכונה/לעץ/לוגים. סדר-קריאה:
//   /home/z/.saos-secrets/ff.env (מחוץ-לעץ, 0600) → upload/ff.env → upload/fffixedflot.txt.
// כנות: כל-תשובה-כושלת-מדווחת-בשמה; אין-המצאת-זוגות-או-שערים; fail-closed-בלי-סוד.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'

const ROOT = join(import.meta.dir, '..', '..')
const SECRETS_DIR = process.env.FF_SECRETS_DIR || '/home/z/.saos-secrets'
const FF_API = 'https://fixedfloat.com/api/v2'

export type FfCreds = { key: string; secret: string; source: string }
export type FfCredsMissing = { key: null; secret: null; source: string }

/** אסימון-אלפאנומרי-אחרון-בשורה (≥20) — לוכד-אסימון-בשורה-עם-תחילית-הודעה-או-עירום */
function trailingToken(line: string): string | null {
  const m = line.match(/[A-Za-z0-9]{20,}\s*$/)
  return m ? m[0].trim() : null
}

/** מנתח-טהור-של-ff.env (FF_API_KEY/FF_API_SECRET או KEY/SECRET) — ללא-קבצים */
export function parseEnvCreds(text: string): FfCreds | FfCredsMissing {
  let key: string | null = null
  let secret: string | null = null
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const k = t.slice(0, eq).trim().toUpperCase()
    const v = t.slice(eq + 1).trim()
    if (!v) continue
    if ((k === 'FF_API_KEY' || k === 'API_KEY' || k === 'KEY') && !key) key = v
    if ((k === 'FF_API_SECRET' || k === 'API_SECRET' || k === 'SECRET') && !secret) secret = v
  }
  if (key && secret) return { key, secret, source: 'env' }
  return { key: null, secret: null, source: 'env-חסר-סוד-או-מפתח' }
}

/** מנתח-טהור-של-פורמט-ההודעות-של-הבעלים + התבנית-הישנה — ללא-קבצים */
export function parseTxtCreds(text: string): FfCreds | FfCredsMissing {
  const lines = text.split('\n').map((l) => l.trim())
  let key: string | null = null
  let secret: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const low = l.toLowerCase()
    if (!key && /api[ _-]?key/i.test(l)) {
      // האסימון-בשורה-הזאת-עצמה (עירום) או-בשורה-העוקבת (כולל-תחילית-הודעה)
      key = trailingToken(l) ?? trailingToken(lines[i + 1] ?? '')
    }
    if (!secret && /api[ _-]?secret/i.test(l)) {
      secret = trailingToken(l) ?? trailingToken(lines[i + 1] ?? '')
    }
  }
  if (key && secret) return { key, secret, source: 'txt' }
  return { key: null, secret: null, source: 'txt-חסר-סוד-או-מפתח' }
}

function readIf(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** כספת-FF: מחוץ-לעץ-קודם (חוק-הכספות), ואז-נתיבי-upload-המגובים */
export function ffCreds(): FfCreds | FfCredsMissing {
  const a = readIf(join(SECRETS_DIR, 'ff.env'))
  if (a) {
    const r = parseEnvCreds(a)
    if (r.key) return { ...r, source: '.saos-secrets/ff.env' }
  }
  const b = readIf(join(ROOT, 'upload', 'ff.env'))
  if (b) {
    const r = parseEnvCreds(b)
    if (r.key) return { ...r, source: 'upload/ff.env' }
  }
  const c = readIf(join(ROOT, 'upload', 'fffixedflot.txt'))
  if (c) {
    const r = parseTxtCreds(c)
    if (r.key) return { ...r, source: 'upload/fffixedflot.txt' }
  }
  return { key: null, secret: null, source: 'לא-נמצא-מפתח-בכספת' }
}

/** חתימת-FixedFloat-API-v2: Signature = HMAC-SHA256(Payload, ApiSecret) */
export function ffSign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export async function ffPost<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; unauthorized?: boolean }> {
  const c = ffCreds()
  if (!c.key || !c.secret) return { ok: false, error: `כספת-FF-חסרה (${c.source})` }
  const payload = JSON.stringify({ ...body, version: 2 })
  const sig = ffSign(payload, c.secret)
  try {
    const res = await fetch(`${FF_API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', APIKey: c.key, Payload: payload, Signature: sig },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) {
      // 401/FF-501 "Not have permission" = דחייה-ברמת-המפתח-בצד-FF (הפעלה/IP-allowlist)
      const unauthorized = res.status === 401
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, unauthorized }
    }
    const j = JSON.parse(text) as { code?: number | string; msg?: string; data?: T }
    if (j.code !== undefined && j.code !== 0 && j.code !== '0') {
      return { ok: false, error: `FF-${j.code}: ${j.msg ?? '?'}`, unauthorized: String(j.code) === '501' }
    }
    return { ok: true, data: (j.data ?? (j as unknown as T)) as T }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type FfStatus = {
  keyFound: boolean
  source: string
  /** null = לא-נמדד; true = מאושר; false = נדחה-ברמת-המפתח-ב-FF (הפעלה/IP) */
  authorized: boolean | null
  currencies: number | null
  steemSupported: boolean
  btcSupported: boolean
  samplePairs: string[]
  lastError: string | null
  checkedAt: string | null
}

let cache: FfStatus | null = null

export async function probe(force = false): Promise<FfStatus> {
  if (!force && cache && Date.now() - new Date(cache.checkedAt ?? 0).getTime() < 5 * 60_000) return cache
  const c = ffCreds()
  const out: FfStatus = {
    keyFound: !!c.key,
    source: c.source,
    authorized: null,
    currencies: null,
    steemSupported: false,
    btcSupported: false,
    samplePairs: [],
    lastError: null,
    checkedAt: new Date().toISOString(),
  }
  if (!c.key || !c.secret) {
    out.lastError = `כספת-FF-חסרה (${c.source})`
    cache = out
    return out
  }
  const r = await ffPost<{ currencies: Array<{ network: string; code: string; name: string }> }>('getCurrencies', {})
  if (!r.ok) {
    out.authorized = r.unauthorized === true ? false : null
    out.lastError = r.error
    cache = out
    return out
  }
  out.authorized = true
  const cur = r.data.currencies ?? []
  out.currencies = cur.length
  out.steemSupported = cur.some((x) => /steem/i.test(x.code) || /steem/i.test(x.network))
  out.btcSupported = cur.some((x) => /btc/i.test(x.code))
  out.samplePairs = cur.slice(0, 12).map((x) => x.code)
  cache = out
  return out
}
