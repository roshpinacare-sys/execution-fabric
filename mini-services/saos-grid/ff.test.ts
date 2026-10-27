// ═════════════════════════════════════════════════════════════════════════════
// ff.test.ts — עורק-FF (Task-141-a → Task-143) — TDD על-מנתחי-הכספת, החתימה וחוזה-ה-API
// ═════════════════════════════════════════════════════════════════════════════
// מדידת-אמת (26/10): פורמט-הכספת-החדש-של-הבעלים — שורת-כותרת "[ts] Head Corner:
// Api key" ואחריה-שורת-אסימון-עם-תחילית-הודעה. המנתח-הישן-חיפש-שורה-בדיוק
// "api key" ואסימון-עירום-בשורה-הבאה → keyFound:false תמידי → עורק-מת.
// החתימה-הישנה-הייתה-HMAC(key,key) — לפי-API v2 החתימה-HMAC(Payload, ApiSecret).
// מדידת-אמת (27/10, Task-143): FixedFloat העבירו-את-ה-API-ל-ff.io —
//   https://ff.io/api/v2/{ccies,price,create,order,qr} עם-כותרות X-API-KEY/X-API-SIGN.
//   המארח-הישן fixedfloat.com/api/v2 עם-כותרות APIKey/Payload/Signature משיב-401/501
//   "Not have permission" — מדוד-חי-מול-השרת. המפתח-עצמו-תקף-ומורשה (ccies→code:0, 71-מטבעות).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { parseEnvCreds, parseTxtCreds, ffSign, ffPost, ffPrice, probe } from './ff'

const NEW_FORMAT = [
  'fixedfloat',
  '[25/10/2026 23:36] Head Corner: Api key',
  '[25/10/2026 23:36] Head Corner: EmO1yGJkRzcLGIlwk6lKIMTUuQ3yWVyFjjmeSc0J',
  '[25/10/2026 23:36] Head Corner: Api secret',
  '[25/10/2026 23:36] Head Corner: G7B69UPs7IfEgMHLeIVMvMgtJzw2fs1SPjI173Bx',
  '',
].join('\n')

describe('parseTxtCreds — מנתח-פורמט-ההודעות-של-הבעלים', () => {
  test('פורמט-חדש: אסימון-בשורה-העוקבת-עם-תחילית-הודעה', () => {
    const r = parseTxtCreds(NEW_FORMAT)
    expect(r.key).toBe('EmO1yGJkRzcLGIlwk6lKIMTUuQ3yWVyFjjmeSc0J')
    expect(r.secret).toBe('G7B69UPs7IfEgMHLeIVMvMgtJzw2fs1SPjI173Bx')
    expect(r.source).toBe('txt')
  })

  test('פורמט-ישן: כותרת-עירומה "api key" + אסימון-עירום-בשורה-הבאה', () => {
    const legacy = ['api key', 'A'.repeat(40), 'api secret', 'B'.repeat(40)].join('\n')
    const r = parseTxtCreds(legacy)
    expect(r.key).toBe('A'.repeat(40))
    expect(r.secret).toBe('B'.repeat(40))
  })

  test('מפתח-בלי-סוד → fail-closed (אין-חתימה-בלי-סוד, אין-המצאה)', () => {
    const half = ['[t] Head Corner: Api key', '[t] Head Corner: ' + 'A'.repeat(40)].join('\n')
    const r = parseTxtCreds(half)
    expect(r.key).toBe(null)
    expect(r.secret).toBe(null)
    expect(r.source).toContain('חסר')
  })

  test('קובץ-ריק/לא-תואם → honest-null', () => {
    const r = parseTxtCreds('fixedfloat\nno keys here\n')
    expect(r.key).toBe(null)
  })

  test('אסימון-קצר-מדי (<20) לא-מתקבל-כאסימון', () => {
    const short = ['api key', 'short123', 'api secret', 'B'.repeat(40)].join('\n')
    const r = parseTxtCreds(short)
    expect(r.key).toBe(null)
  })
})

describe('parseEnvCreds — מנתח-ff.env', () => {
  test('FF_API_KEY/FF_API_SECRET', () => {
    const r = parseEnvCreds('FF_API_KEY=AAAABBBBCCCC\nFF_API_SECRET=DDDD1111EEEE')
    expect(r.key).toBe('AAAABBBBCCCC')
    expect(r.secret).toBe('DDDD1111EEEE')
  })

  test('KEY=/SECRET= (תבנית-ישנה)', () => {
    const r = parseEnvCreds('KEY=AAAA\nSECRET=BBBB')
    expect(r.key).toBe('AAAA')
    expect(r.secret).toBe('BBBB')
  })

  test('הערות-#-ורווחים-מנוקים', () => {
    const r = parseEnvCreds('# comment\nKEY = KKAA\n\nSECRET = BB22')
    expect(r.key).toBe('KKAA')
    expect(r.secret).toBe('BB22')
  })

  test('סוד-חסר → fail-closed', () => {
    const r = parseEnvCreds('KEY=AAAA')
    expect(r.key).toBe(null)
  })
})

describe('ffSign — חתימת-API-v2 (HMAC-SHA256(Payload, ApiSecret))', () => {
  test('וקטור-קבוע: HMAC-SHA256("payload","secret")', () => {
    // וקטור-חוץ-מחושב: node:crypto createHmac('sha256','secret').update('payload')
    expect(ffSign('payload', 'secret')).toBe(
      'b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4',
    )
  })
  test('דטרמיניסטי: אותו-קלט → אותה-חתימה', () => {
    expect(ffSign('x', 'y')).toBe(ffSign('x', 'y'))
  })
  test('סוד-שונה → חתימה-שונה (לא-HMAC-במפתח-הציבורי)', () => {
    expect(ffSign('p', 's1')).not.toBe(ffSign('p', 's2'))
  })
})

// ─── Task-143: חוזה-ff.io הרשמי — ffPost/ffPrice/probe עם-fetch-מדומה ───────────
// עזר-בדיקה: הסוד-מהכספת-האמיתית — לא-נדפס, רק-משמש-לאימות-חתימה-פנימי.
// אין-כספת-בסביבה → טסטי-החוזה-מדולגים-בכנות (skipIf) — לא-נכשלים-על-סביבה.
import { ffCreds } from './ff'
const hasCreds = ((() => {
  const c = ffCreds() as { key: string | null; secret: string | null }
  return !!(c.key && c.secret)
})())
function ffCredsSecretForTest(): string {
  const c = ffCreds() as { key: string | null; secret: string | null }
  return c.secret ?? 'no-secret-in-test-env'
}

type CapturedReq = { url: string; headers: Record<string, string>; body: string }
const origFetch = globalThis.fetch
let captured: CapturedReq | null = null
let mockStatus = 200
let mockBody = '{}'

function mockFetch(): void {
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = {
      url: String(_url),
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])),
      body: typeof init?.body === 'string' ? init.body : '',
    }
    return new Response(mockBody, { status: mockStatus })
  }) as typeof fetch
}

describe.skipIf(!hasCreds)('ffPost — חוזה-ff.io (Task-143, מדוד-חי-מול-השרת)', () => {
  beforeEach(() => {
    mockFetch()
    captured = null
    mockStatus = 200
    mockBody = '{}'
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test('מארח-רשמי ff.io + כותרות X-API-KEY/X-API-SIGN — ללא-כותרות-ישנות', async () => {
    mockBody = JSON.stringify({ code: 0, msg: 'OK', data: { hello: 1 } })
    const r = await ffPost('ccies', {})
    expect(r.ok).toBe(true)
    expect(captured!.url).toBe('https://ff.io/api/v2/ccies')
    const h = captured!.headers
    expect(h['x-api-key']).toBeDefined()
    expect(h['x-api-key']).not.toBe('')
    expect(h['x-api-sign']).toBe(ffSign(captured!.body, h['x-api-key'] === undefined ? '' : (ffCredsSecretForTest())))
    expect(h['content-type']).toContain('application/json')
    // הכותרות-הישנות-שדחו-אותנו-ב-501 — אסור-שישולחו-כלל
    expect(h['apikey']).toBeUndefined()
    expect(h['payload']).toBeUndefined()
    expect(h['signature']).toBeUndefined()
  })

  test('גוף-הבקשה = JSON-הפרמטרים-בדיוק (בלי-הזרקת-version)', async () => {
    mockBody = JSON.stringify({ code: 0, msg: 'OK', data: [] })
    await ffPost('price', { fromCcy: 'BTC', toCcy: 'ETH', amount: '0.001' })
    expect(captured!.body).toBe(JSON.stringify({ fromCcy: 'BTC', toCcy: 'ETH', amount: '0.001' }))
  })

  test('code:0 → ok:true עם-data', async () => {
    mockBody = JSON.stringify({ code: 0, msg: 'OK', data: { x: 42 } })
    const r = await ffPost<{ x: number }>('order', { id: 'X', token: 'T' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.x).toBe(42)
  })

  test('שגיאת-FF-ב-HTTP-200 (code≠0) → ok:false עם-קוד-בשמו', async () => {
    mockBody = JSON.stringify({ code: 301, msg: 'fromCcy is incorrect', data: null })
    const r = await ffPost('price', {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('301')
  })

  test('HTTP-401 → unauthorized:true (דחייה-ברמת-המפתח — לא-מזויף-כהצלחה)', async () => {
    mockStatus = 401
    mockBody = JSON.stringify({ code: '501', msg: 'Not have permission', data: null })
    const r = await ffPost('ccies', {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.unauthorized).toBe(true)
  })
})

describe.skipIf(!hasCreds)('ffPrice — עורק-השערים (Task-143)', () => {
  beforeEach(() => {
    mockFetch()
    captured = null
    mockStatus = 200
    mockBody = '{}'
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test('ממפה-פרמטרים-לחוזה-הרשמי (fromCcy/toCcy/type/direction/amount)', async () => {
    mockBody = JSON.stringify({ code: 0, msg: 'OK', data: { from: { code: 'BTC' }, to: { code: 'ETH' }, errors: [] } })
    const r = await ffPrice({ fromCcy: 'BTC', toCcy: 'ETH', amount: '0.001' })
    expect(r.ok).toBe(true)
    expect(captured!.url).toBe('https://ff.io/api/v2/price')
    const sent = JSON.parse(captured!.body) as Record<string, unknown>
    expect(sent.fromCcy).toBe('BTC')
    expect(sent.toCcy).toBe('ETH')
    expect(sent.type).toBe('float') // ברירת-מחדל-רשמית
    expect(sent.direction).toBe('from')
    expect(sent.amount).toBe('0.001')
  })

  test('type=fixed-מועבר-כפי-שנדרש', async () => {
    mockBody = JSON.stringify({ code: 0, msg: 'OK', data: { errors: [] } })
    await ffPrice({ fromCcy: 'BTC', toCcy: 'BTCLN', amount: '0.0005', type: 'fixed' })
    const sent = JSON.parse(captured!.body) as Record<string, unknown>
    expect(sent.type).toBe('fixed')
  })
})

describe.skipIf(!hasCreds)('probe — דופק-ccies (Task-143)', () => {
  beforeEach(() => {
    mockFetch()
    captured = null
    mockStatus = 200
    mockBody = '{}'
  })
  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test('ccies-תקין → authorized:true + ספירת-מטבעות + BTC-כן/STEEM-לא (כנות)', async () => {
    mockBody = JSON.stringify({
      code: 0, msg: 'OK',
      data: [
        { code: 'BTC', coin: 'BTC', network: 'BTC', name: 'Bitcoin', recv: 1, send: 1 },
        { code: 'ETH', coin: 'ETH', network: 'ETH', name: 'Ethereum', recv: 1, send: 1 },
      ],
    })
    const r = await probe(true) // force — לעקוף-מטמון
    expect(r.authorized).toBe(true)
    expect(r.currencies).toBe(2)
    expect(r.btcSupported).toBe(true)
    expect(r.steemSupported).toBe(false) // כנות: FF-לא-תומך-STEEM (מדוד-חי 27/10)
    expect(captured!.url).toBe('https://ff.io/api/v2/ccies')
  })

  test('401 → authorized:false (לא-null) — הדחייה-נרשמת-בשמה', async () => {
    mockStatus = 401
    mockBody = JSON.stringify({ code: '501', msg: 'Not have permission', data: null })
    const r = await probe(true)
    expect(r.authorized).toBe(false)
    expect(r.currencies).toBe(null)
    expect(r.lastError).toContain('401')
  })
})
