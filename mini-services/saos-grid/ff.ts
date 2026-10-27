// ===== עורק-FF — FixedFloat: שער-ההמרה של התוצרת לכסף-אמיתי (BTC/ETH/SOL…) =====
// Task-141-a (26/10): תיקון-שורש-כפול שנמדד-חי:
//   1) מנתח-הכספת-הישן-לא-מצא-את-פורמט-ההודעות-של-הבעלים ("[ts] Head Corner: Api key"
//      ואחריו-שורת-אסימון-עם-תחילית-הודעה) → keyFound:false תמידי → העורק-לא-ניסה-אפילו.
//   2) החתימה-הישנה-הייתה-HMAC(Payload, ApiKey) — לפי-FixedFloat-API-v2 החתימה-היא
//      HMAC-SHA256(Payload, ApiSecret). הסוד-מעולם-לא-נפרס-כלל.
// Task-143 (27/10): השורש-האמיתי-של-ה-501 — FixedFloat העבירו-את-ה-API-ל-ff.io.
//   מדוד-חי-מול-השרת: המארח-הישן fixedfloat.com/api/v2 עם-כותרות APIKey/Payload/Signature
//   משיב-401/501 "Not have permission"; המארח-הרשמי ff.io/api/v2 עם-כותרות
//   X-API-KEY/X-API-SIGN מחזיר-code:0 עם-אותם-ממש-כתובות → המפתח-היה-תקף-כל-הזמן.
//   שמות-המתודות-הרשמיים: ccies (היה-getCurrencies), price, create, order, qr.
// חוק-כספות: מפתחות-מעולם-לא-יוצאים-מהמכונה/לעץ/לוגים. סדר-קריאה:
//   /home/z/.saos-secrets/ff.env (מחוץ-לעץ, 0600) → upload/ff.env → upload/fffixedflot.txt.
// כנות: כל-תשובה-כושלת-מדווחת-בשמה; אין-המצאת-זוגות-או-שערים; fail-closed-בלי-סוד.
// STEEM-לא-נתמך-ב-FF (מדוד-חי 27/10: 71-מטבעות-ואין-STEEM) — העורק-להמרת-קריפטו-חוץ (BTC/ETH/LN…).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'

const ROOT = join(import.meta.dir, '..', '..')
const SECRETS_DIR = process.env.FF_SECRETS_DIR || '/home/z/.saos-secrets'
// Task-143: המארח-הרשמי-מה-docs-החיים (https://ff.io/api) — לא-המארח-הישן-שמחזיר-501
const FF_API = 'https://ff.io/api/v2'

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

/** חתימת-FixedFloat-API-v2: X-API-SIGN = HMAC-SHA256(bodyJson, ApiSecret) */
export function ffSign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

/** שליחה-לחוזה-הרשמי: POST {FF_API}/{method} עם-כותרות X-API-KEY/X-API-SIGN.
 * Task-143: אין-כותרות-ישנות (APIKey/Payload/Signature — מדוד: מחזירות-501),
 * ואין-הזרקת-version — הגוף-הוא-JSON-הפרמטרים-בדיוק-כחוזה-ה-docs. */
export async function ffPost<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; unauthorized?: boolean }> {
  const c = ffCreds()
  if (!c.key || !c.secret) return { ok: false, error: `כספת-FF-חסרה (${c.source})` }
  const payload = JSON.stringify(body)
  const sig = ffSign(payload, c.secret)
  try {
    const res = await fetch(`${FF_API}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'X-API-KEY': c.key,
        'X-API-SIGN': sig,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) {
      // 401 = דחייה-ברמת-המפתח/כותרות — נרשם-בשמו, לא-מזויף-כהצלחה
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

// ─── עורק-השערים (Task-143): price/create/order לפי-החוזה-הרשמי ───
export type FfSide = {
  code: string
  network: string
  coin: string
  amount: number
  rate: number
  min: number
  max: number
  usd: number
}
export type FfQuote = { from: FfSide; to: FfSide; errors: string[] }

export type FfPriceParams = {
  fromCcy: string
  toCcy: string
  amount: string
  type?: 'fixed' | 'float'
  direction?: 'from' | 'to'
}

/** שער-חי-מ-FF — דו-צדדי (direction=from/to), float/fixed. כנות: שגיאות-FF-חוזרות-בשמן. */
export async function ffPrice(
  p: FfPriceParams,
): Promise<{ ok: true; quote: FfQuote } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    fromCcy: p.fromCcy,
    toCcy: p.toCcy,
    type: p.type ?? 'float',
    direction: p.direction ?? 'from',
    amount: p.amount,
  }
  const r = await ffPost<FfQuote>('price', body)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, quote: r.data }
}

export type FfStatus = {
  keyFound: boolean
  source: string
  /** null = לא-נמדד; true = מאושר; false = נדחה (HTTP-401/FF-501) */
  authorized: boolean | null
  currencies: number | null
  steemSupported: boolean
  btcSupported: boolean
  samplePairs: string[]
  lastError: string | null
  checkedAt: string | null
}

export type FfCurrency = {
  code: string
  coin: string
  network: string
  name: string
  recv: number
  send: number
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
  // Task-143: המתודה-הרשמית-היא-ccies (הישנה-getCurrencies-מתה-עם-המארח-הישן)
  const r = await ffPost<FfCurrency[]>('ccies', {})
  if (!r.ok) {
    out.authorized = r.unauthorized === true ? false : null
    out.lastError = r.error
    cache = out
    return out
  }
  out.authorized = true
  const cur = Array.isArray(r.data) ? r.data : []
  out.currencies = cur.length
  out.steemSupported = cur.some((x) => /steem/i.test(x.coin) || /steem/i.test(x.network))
  out.btcSupported = cur.some((x) => /^btc$/i.test(x.coin))
  out.samplePairs = cur.slice(0, 12).map((x) => x.code)
  cache = out
  return out
}
