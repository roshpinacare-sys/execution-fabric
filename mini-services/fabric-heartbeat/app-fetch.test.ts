// Task-133 — TDD: חוק-החוסן-למיחזור (deterministic, אין-רשת, אין-שינה-זמן אמיתית)
// הלב ממחזר-בעצמו את האפליקציה מעל תקרת-RSS — כל-לולאה-בטיסה עלולה-למות
// "socket connection was closed unexpectedly". החוק: כשל-רשת-ממחלקת-המיחזור
// מקבל-ניסיונות-חוזרים-עם-backoff-אקספוננציאלי+jitter; כשל-לא-ניתן-לניסיון-חוזר
// (תקציב/4xx-היגיוני/timeout) נופל-מיד-וכנה.
import { describe, expect, test } from 'bun:test'
import { APP_RECYCLE_RE, fetchWithRecycleRetry } from './app-fetch'

const noSleep = async () => {} // בדיקה-דטרמיניסטית — אין-המתנה-אמיתית

describe('APP_RECYCLE_RE — מיון-מחלקות-כשל', () => {
  test('מזהה-ניתוק-מיחזור (socket closed)', () => {
    expect(APP_RECYCLE_RE.test('The socket connection was closed unexpectedly. For more information, pass `verbose: true`')).toBe(true)
  })
  test('מזהה-חיבור-נדחה (אפליקציה-מתה-רגעית)', () => {
    expect(APP_RECYCLE_RE.test('Unable to connect. Is the computer able to access the url?')).toBe(true)
    expect(APP_RECYCLE_RE.test('ECONNREFUSED 127.0.0.1:3000')).toBe(true)
  })
  test('לא-מזהה-כשלי-תקציב/timeout/היגיון — אלו-אמת-עסקית, לא-מיחזור', () => {
    expect(APP_RECYCLE_RE.test('The operation was aborted due to timeout')).toBe(false)
    expect(APP_RECYCLE_RE.test('rate-limit: budget exhausted')).toBe(false)
    expect(APP_RECYCLE_RE.test('failed: VALIDATION')).toBe(false)
  })
})

describe('fetchWithRecycleRetry — חוק-הניסיונות-החוזרים', () => {
  test('הצלחה-בניסיון-הראשון — קריאה-אחת-בלבד', async () => {
    let calls = 0
    const out = await fetchWithRecycleRetry(
      async () => {
        calls++
        return 'ok'
      },
      { retries: 2, sleep: noSleep },
    )
    expect(out).toBe('ok')
    expect(calls).toBe(1)
  })

  test('ניתוק-מיחזור ×2 ואז-הצלחה — 3 קריאות, התוצאה-חוזרת', async () => {
    let calls = 0
    const retriesSeen: number[] = []
    const out = await fetchWithRecycleRetry(
      async () => {
        calls++
        if (calls <= 2) throw new Error('The socket connection was closed unexpectedly')
        return 'healed'
      },
      { retries: 2, sleep: noSleep, onRetry: (_msg, _wait, attempt) => retriesSeen.push(attempt) },
    )
    expect(out).toBe('healed')
    expect(calls).toBe(3)
    expect(retriesSeen).toEqual([1, 2])
  })

  test('כשל-לא-ניתן-לניסיון-חוזר — נופל-מיד (קריאה-אחת, אין-הסתרת-אמת)', async () => {
    let calls = 0
    await fetchWithRecycleRetry(
      async () => {
        calls++
        throw new Error('rate-limit: budget exhausted')
      },
      { retries: 2, sleep: noSleep },
    ).then(
      () => expect.unreachable(),
      (e: Error) => expect(e.message).toBe('rate-limit: budget exhausted'),
    )
    expect(calls).toBe(1)
  })

  test('הכל-נופל — retries+1 קריאות, השגיאה-האחרונה-עולה', async () => {
    let calls = 0
    await fetchWithRecycleRetry(
      async () => {
        calls++
        throw new Error('ECONNREFUSED')
      },
      { retries: 2, sleep: noSleep },
    ).then(
      () => expect.unreachable(),
      (e: Error) => expect(e.message).toBe('ECONNREFUSED'),
    )
    expect(calls).toBe(3)
  })

  test('backoff-אקספוננציאלי+jitter — בתוך-תחום [base*(i+1), base*(i+1)+jitter]', async () => {
    const waits: number[] = []
    const baseMs = 1000
    const jitterMs = 500
    let calls = 0
    await fetchWithRecycleRetry(
      async () => {
        calls++
        throw new Error('The socket connection was closed unexpectedly')
      },
      { retries: 2, baseMs, jitterMs, sleep: async (ms) => waits.push(ms) },
    ).catch(() => {}) // התרוקנות-ניסיונות = זריקה-כן — כאן-נבדקים-רק-המרווחים
    expect(waits.length).toBe(2)
    expect(waits[0]).toBeGreaterThanOrEqual(baseMs)
    expect(waits[0]).toBeLessThanOrEqual(baseMs + jitterMs)
    expect(waits[1]).toBeGreaterThanOrEqual(baseMs * 2)
    expect(waits[1]).toBeLessThanOrEqual(baseMs * 2 + jitterMs)
  })

  test('Non-Error-זריקה (מחרוזת) — לא-מפילה-את-הלולאה', async () => {
    let calls = 0
    await fetchWithRecycleRetry(
      async () => {
        calls++
        if (calls === 1) throw 'socket connection was closed'
        return 'ok'
      },
      { retries: 1, sleep: noSleep },
    )
    expect(calls).toBe(2)
  })
})
