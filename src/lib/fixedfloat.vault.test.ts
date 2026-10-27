// ═════════════════════════════════════════════════════════════════════════════
// fixedfloat.vault.test.ts — Task-143: קריאת-כספת-בזמן-ריצה (עמיד-ל-Turbopack-env)
// ═════════════════════════════════════════════════════════════════════════════
// מדידת-אמת (27/10): אחרי-שחזור-סנדבוקס, .env.local חזר-והשרת-עדיין-דיווח
// "מפתח-הקופה לא-מוגדר" ב-POST בזמן-ש-GET-ראה-את-המפתח — Turbopack מחליף
// process.env סטטית לפי snapshot-קומפילציה-ישן (ה-pitfall-המתועד-בספרייה).
// הרפואה: ffVaultParse (מנתח-טהור) + ffVaultRead (קריאת-קובץ-חיה-בזמן-ריצה).
// חוק-כספות: הערכים-עצמם-אף-פעם-לא-יוצאים-ללוג/תשובה — רק-בוליאנים-ואורכים.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { ffVaultParse } from './fixedfloat'

describe('ffVaultParse — מנתח-כספת-טהור (Task-143)', () => {
  test('פורמט-FIXEDFLOAT_API_KEY/SECRET (env.local)', () => {
    const r = ffVaultParse('FIXEDFLOAT_API_KEY=AAAABBBBCCCCDDDDEEEE\nFIXEDFLOAT_API_SECRET=FFFF1111GGGG2222HHHH')
    expect(r?.key).toBe('AAAABBBBCCCCDDDDEEEE')
    expect(r?.secret).toBe('FFFF1111GGGG2222HHHH')
  })

  test('פורמט-FF_API_KEY/FF_API_SECRET (כספת-.saos-secrets)', () => {
    const r = ffVaultParse('# ff vault\nFF_API_KEY=KKKK1111KKKK1111KKKK\nFF_API_SECRET=SSSS2222SSSS2222SSSS')
    expect(r?.key).toBe('KKKK1111KKKK1111KKKK')
    expect(r?.secret).toBe('SSSS2222SSSS2222SSSS')
  })

  test('סוד-חסר → fail-closed (null)', () => {
    expect(ffVaultParse('FIXEDFLOAT_API_KEY=AAAABBBBCCCCDDDDEEEE')).toBe(null)
    expect(ffVaultParse('')).toBe(null)
    expect(ffVaultParse('garbage\nlines')).toBe(null)
  })

  test('ערך-קצר-מדי (<16) נדחה — אותו-סף-כמו-ffConfigured', () => {
    const r = ffVaultParse('FIXEDFLOAT_API_KEY=short\nFIXEDFLOAT_API_SECRET=FFFF1111GGGG2222HHHH')
    expect(r).toBe(null)
  })

  test('הערות-#-ורווחים-מנוקים', () => {
    const r = ffVaultParse('# comment\nFIXEDFLOAT_API_KEY = K1K1K1K1K1K1K1K1K1K1 \n\nFIXEDFLOAT_API_SECRET = S2S2S2S2S2S2S2S2S2S2')
    expect(r?.key).toBe('K1K1K1K1K1K1K1K1K1K1')
    expect(r?.secret).toBe('S2S2S2S2S2S2S2S2S2S2')
  })
})
