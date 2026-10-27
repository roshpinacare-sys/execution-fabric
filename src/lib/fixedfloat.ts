import { createHmac } from 'crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ===== עורק-הקופה (Task 101) — לקוח FixedFloat, שרת-בלבד =====
//
// כספת: FIXEDFLOAT_API_KEY / FIXEDFLOAT_API_SECRET נטענים אך-ורק מ-.env.local (הרשאות 600,
// מחוץ-לגיט) עם עותק-גיבוי ב-.vault/ (700). חוק-ברזל: אסור להדפיס, להחזיר, לתעד, לשרשר
// או להעביר את חומר-המפתח בשום מסלול פלט — לא בלוגים, לא בתגובות-API, לא בשרשרת.
//
// חוזה-ה-API (docs.fixedfloat.com — אומת-מול-המקור, אוקטובר 2025):
//   POST https://ff.io/api/v2/{method}
//   Headers: Accept: application/json · Content-Type: application/json; charset=UTF-8
//            X-API-KEY: <מפתח> · X-API-SIGN: HMAC-SHA256(סוד, גוף-ה-JSON המדויק; מחרוזת-ריקה כשאין-פרמטרים)
//   תגובה: { code: 0|שגיאה, msg, data }
//   מגבלה: 250 יחידות-משקל/דק' (create=50, כל-השאר=1); חריגה = חסימת-טוקן מתגלגלת.
//   הפעימות שלנו: 1 קריאת-אימות/30 דק' = 1 יחידת-משקל — ריחוק-בטוח מהתקרה.

const FF_ENDPOINT = 'https://ff.io/api/v2'
const FF_TIMEOUT_MS = 15_000

// גישה-דינמית-בזמן-ריצה (Task 101 — לקח-אבחון): Turbopack מחליף `process.env.X`
// סטטית-בזמן-קומפילציה לפי snapshot ישן — מה שהשאיר את הספרייה עיוורת למפתח.
// גישה דרך-שם-משתנה אינה-ניתנת-להחלפה-סטטית — הכספת נקראת חי מזיכרון-התהליך.
function envGet(name: string): string | undefined {
  return (process.env as Record<string, string | undefined>)[name]
}

// ─── Task-143: קריאת-כספת-מהדיסק-בזמן-ריצה ───
// מדידה-חיה (27/10): אחרי-שחזור-סנדבוקס .env.local חזר, GET-ראה-מפתח-ועדיין
// POST-דיווח "מפתח-הקופה לא-מוגדר" — גרף-הקומפילציה-של-POST-החזיק-snapshot-env-ישן.
// הרפואה-העמידה: קריאת-קובץ-חיה-מהדיסק-בזמן-ריצה — עמידה-לכל-החלפה-סטטית.
// סדר-קדימויות: process.env → .env.local (0600, מחוץ-לגיט) → /home/z/.saos-secrets/ff.env.

/** מנתח-טהור-של-תוכן-כספת (FIXEDFLOAT_API_* או FF_API_*) — null-אם-חסר/קצר-מדי */
export function ffVaultParse(text: string): { key: string; secret: string } | null {
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
    if ((k === 'FIXEDFLOAT_API_KEY' || k === 'FF_API_KEY') && !key) key = v
    if ((k === 'FIXEDFLOAT_API_SECRET' || k === 'FF_API_SECRET') && !secret) secret = v
  }
  if (key && secret && key.length >= 16 && secret.length >= 16) return { key, secret }
  return null
}

function ffVaultRead(): { key: string; secret: string } | null {
  const paths = [join(process.cwd(), '.env.local'), '/home/z/.saos-secrets/ff.env']
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const r = ffVaultParse(readFileSync(p, 'utf-8'))
      if (r) return r
    } catch {
      // קריאה-כושלת-על-נתיב-אחד → ממשיכים-לנתיב-הבא; אין-לוג-של-תוכן
    }
  }
  return null
}

/** הכתובות-בשמן: env-קודם, ואז-קריאת-דיסק-חיה. הערכים-לא-נודפים-מעולם. */
function ffCredsValue(): { key: string; secret: string } | null {
  const k = envGet('FIXEDFLOAT_API_KEY') ?? ''
  const s = envGet('FIXEDFLOAT_API_SECRET') ?? ''
  if (k.length >= 16 && s.length >= 16) return { key: k, secret: s }
  return ffVaultRead()
}

export function ffConfigured(): { key: boolean; secret: boolean } {
  const c = ffCredsValue()
  return { key: !!c, secret: !!c }
}

// אבחון-זמני (Task 101): מה-המודול עצמו רואה מתוך-process.env — בוליאנים-בלבד
export function ffDebugEnv(): { keys: number; fixed: number; hasDatabase: boolean } {
  const ks = Object.keys(process.env as Record<string, string | undefined>)
  return {
    keys: ks.length,
    fixed: ks.filter((k) => k.startsWith('FIXED')).length,
    hasDatabase: !!(process.env as Record<string, string | undefined>)['DATABASE_URL'],
  }
}

// מסחר-נעול-כברירת-מחדל: נפתח רק כשהבעלים מציב TREASURY_TRADING_ENABLED=true
// וגם-אז דרך מודול-תקרות-סיכון — לא דרך הלקוח-הגולמי.
export function ffTradingEnabled(): boolean {
  return process.env.TREASURY_TRADING_ENABLED === 'true'
}

export interface FfResult<T = unknown> {
  ok: boolean
  http: number
  code: number | null // קוד-API של FixedFloat; 0 = הצלחה
  msg: string
  data: T | null
  errorClass: 'unconfigured' | 'network' | 'http' | 'api' | null
  durationMs: number
}

// הליבה: חתימה+שיחה+סיווג-כשל כנה. אפס-חשיפת-מפתח: השגיאות נושאות מחלקה והודעה
// מקוצצת בלבד — לעולם לא את הכותרות, את הגוף החתום או את חומר-המפתח.
async function ffCall<T>(method: string, params?: Record<string, unknown>): Promise<FfResult<T>> {
  const t0 = Date.now()
  const creds = ffCredsValue()
  if (!creds) {
    return { ok: false, http: 0, code: null, msg: 'מפתח-הקופה לא-מוגדר', data: null, errorClass: 'unconfigured', durationMs: 0 }
  }
  // חוק-החתימה: הגוף המדויק שנחתם = הגוף שנשלח.
  // Task-143 (מדוד-חי-מול-השרת): הגוף-הוא-JSON-הפרמטרים-תמיד ('{}' כשאין-פרמטרים —
  // כחוזה-ה-docs: json.dumps({})) — והחתימה-על-אותו-גוף-בדיוק.
  const body = JSON.stringify(params ?? {})
  const sign = createHmac('sha256', creds.secret).update(body).digest('hex')
  try {
    const res = await fetch(`${FF_ENDPOINT}/${method}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-API-KEY': creds.key,
        'X-API-SIGN': sign,
      },
      body,
      signal: AbortSignal.timeout(FF_TIMEOUT_MS),
      cache: 'no-store',
    })
    const durationMs = Date.now() - t0
    if (res.status !== 200) {
      return { ok: false, http: res.status, code: null, msg: `HTTP ${res.status}`, data: null, errorClass: 'http', durationMs }
    }
    const j = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: T } | null
    if (!j || typeof j.code !== 'number') {
      return { ok: false, http: res.status, code: null, msg: 'תגובה-לא-תקנית-מהשירות', data: null, errorClass: 'http', durationMs }
    }
    return {
      ok: j.code === 0,
      http: res.status,
      code: j.code,
      msg: typeof j.msg === 'string' ? j.msg.slice(0, 200) : '',
      data: j.data ?? null,
      errorClass: j.code === 0 ? null : 'api',
      durationMs,
    }
  } catch (e) {
    return {
      ok: false,
      http: 0,
      code: null,
      msg: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      data: null,
      errorClass: 'network',
      durationMs: Date.now() - t0,
    }
  }
}

// --- שיטות-קריאה-בלבד (החוזה המאומת מה-docs) — המסחר לא נחשף כאן מכוון ---

export interface FfCcy {
  code: string
  coin: string
  network: string
  name: string
  recv: boolean
  send: boolean
  tag: string | null
  priority: number
}

// פעימת-אימות-חיים: ccies דורש מפתח+חתימה תקפים — code=0 מוכיח שהכספת נושמת
// (1 יחידת-משקל). מחזיר סיכום-מספרי בלבד — אפס-חומר-מזהה.
export async function ffPing(): Promise<FfResult<{ currencies: number; recv: number; send: number }>> {
  const r = await ffCall<FfCcy[]>('ccies')
  if (!r.ok || !Array.isArray(r.data)) return { ...r, data: null }
  return {
    ...r,
    data: {
      currencies: r.data.length,
      recv: r.data.filter((c) => c.recv).length,
      send: r.data.filter((c) => c.send).length,
    },
  }
}

export async function ffCcies(): Promise<FfResult<FfCcy[]>> {
  return ffCall<FfCcy[]>('ccies')
}

export interface FfPriceSide {
  code: string
  network: string
  coin: string
  amount: number
  rate: number
  precision: number
  min: number
  max: number
  usd?: number
  btc?: number
}

export interface FfPrice {
  from: FfPriceSide
  to: FfPriceSide
  errors: string[] // MAINTENANCE_*/OFFLINE_*/RESERVE_*/LIMIT_* — ריק = ההמרה אפשרית
}

export async function ffPrice(p: {
  fromCcy: string
  toCcy: string
  amount: number
  direction?: 'from' | 'to'
  type?: 'fixed' | 'float'
}): Promise<FfResult<FfPrice>> {
  return ffCall<FfPrice>('price', { direction: 'from', type: 'float', ...p })
}
