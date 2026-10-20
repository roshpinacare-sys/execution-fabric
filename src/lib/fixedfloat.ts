import { createHmac } from 'crypto'

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

export function ffConfigured(): { key: boolean; secret: boolean } {
  const key = envGet('FIXEDFLOAT_API_KEY') ?? ''
  const secret = envGet('FIXEDFLOAT_API_SECRET') ?? ''
  return { key: key.length >= 16, secret: secret.length >= 16 }
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
  const cfg = ffConfigured()
  if (!cfg.key || !cfg.secret) {
    return { ok: false, http: 0, code: null, msg: 'מפתח-הקופה לא-מוגדר', data: null, errorClass: 'unconfigured', durationMs: 0 }
  }
  // חוק-החתימה: הגוף המדויק שנחתם = הגוף שנשלח. בלי-פרמטרים = מחרוזת-ריקה.
  const body = params && Object.keys(params).length > 0 ? JSON.stringify(params) : ''
  const sign = createHmac('sha256', envGet('FIXEDFLOAT_API_SECRET') ?? '').update(body).digest('hex')
  try {
    const res = await fetch(`${FF_ENDPOINT}/${method}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=UTF-8',
        'X-API-KEY': envGet('FIXEDFLOAT_API_KEY') ?? '',
        'X-API-SIGN': sign,
      },
      ...(body ? { body } : {}),
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
