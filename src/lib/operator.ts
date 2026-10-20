// חוק-מפתח-הבעלים (Task 91 — קו-ההגנה לפני-פתיחת-הריפו לציבור):
// קריאה = פומבית. שינוי-מצב = תהליך-מקומי (לב/זקיפה/עד ב-loopback) או בעלים-מאומת-מפתח.
// המפתח: upload/operator.env (gitignored — נבדק) — נוצר-אוטומטית בפעם-הראשונה (atomic tmp+rename).
// אף-ערך-מפתח לא יוצא מהתהליך, אף-לוג לא מכיל-אותו, הגיט לא רואה-אותו לעולם.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomBytes, timingSafeEqual } from 'crypto'
import { join } from 'path'

const KEY_HEADER = 'x-operator-key'
const KEY_FILE = join(process.cwd(), 'upload', 'operator.env')

export type OperatorVia = 'direct-local' | 'private-net' | 'operator-key' | 'public-denied' | 'key-missing'

export interface OperatorVerdict {
  allowed: boolean
  via: OperatorVia
  client: string
}

function readStoredKey(): string | null {
  const fromEnv = process.env.OPERATOR_KEY
  if (fromEnv && fromEnv.trim().length >= 16) return fromEnv.trim()
  if (!existsSync(KEY_FILE)) return null
  try {
    const txt = readFileSync(KEY_FILE, 'utf8')
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*OPERATOR_KEY\s*=\s*(\S+)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    return null
  }
  return null
}

/** מבטיח-שקפת-מפתח-קיימת; יוצר-אוטומטית אם-חסר. כנות: נכשל = false, אף-שקר. */
export function ensureOperatorKey(): boolean {
  if (readStoredKey()) return true
  try {
    mkdirSync(join(process.cwd(), 'upload'), { recursive: true })
    const key = randomBytes(32).toString('hex')
    const tmp = `${KEY_FILE}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(
      tmp,
      '# מפתח-הבעלים — gitignored (upload/) — לא לעלות לעולם. נקרא רק מהדיסק על-ידי המכונה.\nOPERATOR_KEY=' +
        key +
        '\n',
      { mode: 0o600 },
    )
    renameSync(tmp, KEY_FILE)
    return true
  } catch {
    return false
  }
}

function keyMatches(provided: string | null): boolean {
  const expected = readStoredKey()
  if (!expected || !provided) return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isPrivateIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return true
  const v = ip.replace(/^::ffff:/i, '')
  if (v === '::1') return true
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i.test(v)
}

// גם-GET עם force=1 משנה-מצב (מדלג-על-מנעולי-טריות, שורף-חישוב) — מפתח-כמו-POST.
export function isMutatingRequest(method: string, url: string): boolean {
  const m = (method || 'GET').toUpperCase()
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') return true
  try {
    return new URL(url).searchParams.has('force')
  } catch {
    return false
  }
}

// ה-Caddy מחליף X-Forwarded-For ב-{remote_host} (לא מצרף) — אין-זיוף-כותרת-מהרשת.
// קריאות-פנימיות של-הלב/הזקיפה/העד אינן-עוברות-כלל דרך-Caddy (127.0.0.1 ישירות) → אין-XFF → direct-local.
export function resolveOperator(headers: Headers, clientHint?: string): OperatorVerdict {
  const xff = (headers.get('x-forwarded-for') || '').trim()
  const first = xff ? xff.split(',')[0].trim() : ''
  if (!first) return { allowed: true, via: 'direct-local', client: clientHint || 'loopback' }
  if (isPrivateIp(first)) return { allowed: true, via: 'private-net', client: first }
  if (keyMatches(headers.get(KEY_HEADER))) return { allowed: true, via: 'operator-key', client: first }
  return { allowed: false, via: readStoredKey() ? 'public-denied' : 'key-missing', client: first }
}
