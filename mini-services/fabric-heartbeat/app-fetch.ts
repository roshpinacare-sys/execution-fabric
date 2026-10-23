// Task-133 — חוק-החוסן-למיחזור (ספרייה-טהורה — ניתנת-לייבוא בלי-להריץ-טיימרים)
// הלב עצמו ממחזר-את-האפליקציה מעל תקרת-RSS (appGuard, Task-130-b) — ולכן כל-לולאה
// שיורית-מול האפליקציה עלולה-למות-בטיסה ("The socket connection was closed
// unexpectedly", ECONNREFUSED-בחלון-ההחייאה של ~3-10שנ'). מות-כזה אינו-אמת-עסקית —
// הוא-תופעת-לוואי-של-התרופה-שלנו-עצמה. החוק: כשל-ממחלקת-המיחזור מקבל-ניסיונות-
// חוזרים עם backoff-אקספוננציאלי+jitter; כל-כשל-אחר (timeout/תקציב/היגיון) נופל
// מיד-וכנה — אסור-להסתיר-אמת-עסקית-מאחורי-ניסיון-חוזר.

// מחלקת-המיחזור: ניתוק-שקט/חיבור-נדחה/חבילה-נחתכה. במכוון-לא: timeout
// ("aborted due to timeout") — שהוא-חוסר-סבלנות-של-הלקוח-עצמו, לא-מוות-של-השרת.
export const APP_RECYCLE_RE =
  /socket connection was closed|other side closed|ECONNREFUSED|ECONNRESET|fetch failed|terminated|Unable to connect/i

export interface RetryOpts {
  /** מספר-הניסיונות-הנוספים אחרי-הראשון (ברירת-מחדל 2) */
  retries?: number
  /** בסיס-ההמתנה ב-ms (ברירת-מחדל 8000 — חלון-החייאת-האפליקציה המוכח) */
  baseMs?: number
  /** jitter מקסימלי ב-ms נגד-סערת-ניסיונות (ברירת-מחדל 2000) */
  jitterMs?: number
  /** המתנה-הניתנת-להזרקה (בדיקות-דטרמיניסטיות) */
  sleep?: (ms: number) => Promise<void>
  /** צופה-ניסיונות-חוזרים (לוג-הלב): (msg, waitMs, attempt-1based) */
  onRetry?: (msg: string, waitMs: number, attempt: number) => void
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return typeof e === 'string' ? e : String(e)
}

export async function fetchWithRecycleRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 2
  const baseMs = opts.baseMs ?? 8_000
  const jitterMs = opts.jitterMs ?? 2_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = errMessage(e)
      // כשל-שאינו-מחלקת-המיחזור = אמת-עסקית/timeout — נופל-מיד, אסור-ללטש-אותו-בשתיקה
      if (!APP_RECYCLE_RE.test(msg)) throw e
      if (attempt < retries) {
        const waitMs = baseMs * (attempt + 1) + Math.floor(Math.random() * jitterMs)
        opts.onRetry?.(msg, waitMs, attempt + 1)
        await sleep(waitMs)
      }
    }
  }
  throw lastErr
}
