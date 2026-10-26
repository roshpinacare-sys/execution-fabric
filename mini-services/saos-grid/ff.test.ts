// ═════════════════════════════════════════════════════════════════════════════
// ff.test.ts — עורק-FF (Task-141-a) — TDD על-מנתחי-הכספת-הטהורים-והחתימה
// ═════════════════════════════════════════════════════════════════════════════
// מדידת-אמת (26/10): פורמט-הכספת-החדש-של-הבעלים — שורת-כותרת "[ts] Head Corner:
// Api key" ואחריה-שורת-אסימון-עם-תחילית-הודעה. המנתח-הישן-חיפש-שורה-בדיוק
// "api key" ואסימון-עירום-בשורה-הבאה → keyFound:false תמידי → עורק-מת.
// החתימה-הישנה-הייתה-HMAC(key,key) — לפי-API v2 החתימה-HMAC(Payload, ApiSecret).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { parseEnvCreds, parseTxtCreds, ffSign } from './ff'

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
