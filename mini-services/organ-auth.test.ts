// ═════════════════════════════════════════════════════════════════════════════
// organ-auth.test.ts — שער-הסמכות-הטהור (דירקטיבת-בעלים 25/10 §1):
// "deny-by-default — כל-פעולה/מוטציה דורשת טוקן-קריפטוגרפי תקף"
// החוזה: verifyOrganToken — טהור, דטרמיניסטי, אפס-I/O, השוואה בזמן-קבוע.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { verifyOrganToken } from './organ-auth'

describe('verifyOrganToken — שער-דחייה-כברירת-מחדל', () => {
  test('טוקן-תואם → ok', () => {
    expect(verifyOrganToken('secret-token-123', 'secret-token-123')).toBe('ok')
  })

  test('חסר-כותרת → deny (אין-אנונימיים); תצורה-ריקה-קודמת (fail-closed)', () => {
    expect(verifyOrganToken('', 'secret-token-123')).toBe('deny')
    expect(verifyOrganToken('', '')).toBe('unconfigured') // בלי-תצורה-תקפה אין-מה-להשוות → 503
  })

  test('טוקן-שגוי → deny', () => {
    expect(verifyOrganToken('wrong', 'secret-token-123')).toBe('deny')
    expect(verifyOrganToken('secret-token-124', 'secret-token-123')).toBe('deny')
  })

  test('קידומת-או-סופית-חלקית → deny (השוואה-מלאה-בלבד)', () => {
    expect(verifyOrganToken('secret', 'secret-token-123')).toBe('deny')
    expect(verifyOrganToken('secret-token-123 ', 'secret-token-123')).toBe('deny')
    expect(verifyOrganToken('secret-token-12', 'secret-token-123')).toBe('deny')
  })

  test('תצורה-חסרה (אין-טוקן-מוגדר) → unconfigured (503 fail-closed)', () => {
    expect(verifyOrganToken('anything', null)).toBe('unconfigured')
    expect(verifyOrganToken('', null)).toBe('unconfigured')
  })

  test('טוקן-מוגדר-ריק-מחרוזת → unconfigured (לא-אפס-אמון)', () => {
    expect(verifyOrganToken('x', '')).toBe('unconfigured')
  })

  test('אורכים-שונים-מוחלטים → deny (בלי-קריסת-timingSafeEqual)', () => {
    expect(verifyOrganToken('a', 'a-very-long-token-value-that-differs')).toBe('deny')
    expect(verifyOrganToken('a-very-long-token-value-that-differs', 'a')).toBe('deny')
  })
})
