// Task-140 — TDD: חוק-החלטת-המיחזור (deterministic, אין-רשת, אין-שינה-זמן אמיתית)
// רקע-מדידה-חי: שיא-העבודה-האמיתי של שרת-ה-dev נמדד 1306–1319MB, והתקרה-ההיסטורית (1250)
// ישבה-מתחת-לשיא — כל-חימום-חצה-אותה וכל-מחזור-כפייה ייצר את הבא מהר יותר
// (30-מחזורי-כפייה ב-53דק', קפיצות-חימום +500MB ב-12שנ'). החוק-החדש:
//   מעל-התקרה (1500 — מעל-השיא-הנמדד, 600MB-מתחת-לקו-ההרג-ההיסטורי 2.1GB) → כפייה מיד;
//   בטווח-התכנון (1400–1500) והלב-בטל → מיחזור-חלון-שקט מתוכנן בין-עבודות;
//   בטווח-ועסוק → ממתין-כנה לחלון-פנוי; מתחת-לטווח → אין-פעולה.
import { describe, expect, test } from 'bun:test'
import { recycleDecision } from './app-guard'

const BASE = { ceilingMb: 1500, bandMb: 1400 }

describe('recycleDecision — חוק-ההחלטה', () => {
  test('אין-מדידה (null) — אין-פעולה, כנות-מלאה', () => {
    const d = recycleDecision({ ...BASE, rssMb: null, idle: true })
    expect(d.action).toBe('none')
    expect(d.reason).toBe('no-measurement')
  })

  test('מתחת-לטווח — אין-פעולה (בין-אם-בטל-ובין-אם-עסוק)', () => {
    for (const idle of [true, false]) {
      const d = recycleDecision({ ...BASE, rssMb: 700, idle })
      expect(d.action).toBe('none')
    }
    const d = recycleDecision({ ...BASE, rssMb: 1399, idle: true })
    expect(d.action).toBe('none')
  })

  test('גבול-הטווח עצמו (1400) — עדיין-אין-פעולה (strict-greater)', () => {
    const d = recycleDecision({ ...BASE, rssMb: 1400, idle: true })
    expect(d.action).toBe('none')
  })

  test('בטווח-התכנון ועסוק — ממתין-כנה (לא-הורגים-עבודה-באמצע)', () => {
    const d = recycleDecision({ ...BASE, rssMb: 1450, idle: false })
    expect(d.action).toBe('none')
    expect(d.reason).toContain('busy')
  })

  test('בטווח-התכנון ובטל — מיחזור-חלון-שקט מתוכנן', () => {
    const d = recycleDecision({ ...BASE, rssMb: 1450, idle: true })
    expect(d.action).toBe('planned')
    expect(d.reason).toContain('quiet-window')
  })

  test('גבול-התקרה עצמו (1500) — עדיין-מתוכנן (strict-greater)', () => {
    const d = recycleDecision({ ...BASE, rssMb: 1500, idle: true })
    expect(d.action).toBe('planned')
  })

  test('מעל-התקרה — כפייה מיד, גם-בטל-וגם-עסוק (הגרעין-מאיים)', () => {
    for (const idle of [true, false]) {
      const d = recycleDecision({ ...BASE, rssMb: 1501, idle })
      expect(d.action).toBe('forced')
      expect(d.reason).toContain('ceiling')
    }
  })

  test('רגרסיה-היסטורית: השיא-הנמדד 1319 מול-התקרה-הישנה 1250 — זו-הייתה-הכפייה-התמידית', () => {
    const d = recycleDecision({ ceilingMb: 1250, bandMb: 1150, rssMb: 1319, idle: false })
    expect(d.action).toBe('forced')
  })

  test('תצורה-שגויה (band ≥ ceiling) — לא-מתפוצץ; מעל-תקרה-תמיד-כפייה, בתוך-התקרה-אין-מתוכנן', () => {
    const forced = recycleDecision({ ceilingMb: 1400, bandMb: 1400, rssMb: 1500, idle: true })
    expect(forced.action).toBe('forced')
    const none = recycleDecision({ ceilingMb: 1400, bandMb: 1400, rssMb: 1399, idle: true })
    expect(none.action).toBe('none')
  })
})
