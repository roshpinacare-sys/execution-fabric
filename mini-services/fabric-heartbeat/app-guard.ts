// Task-140 — חוק-החלטת-המיחזור-הממושמע (טהור, נבחן, ללא-תופעות-לוואי)
//
// רקע-מדידה-חי (2026-10-25): שיא-העבודה-האמיתי של שרת-ה-dev נמדד 1306–1319MB
// (VmHWM/VmRSS מ-/proc), והתקרה-ההיסטורית (1250MB) ישבה-מתחת-לשיא — כל-חימום-אחרי
// מחזור חצה-אותה, וכל-מחזור-כפייה הרג-עבודה-באמצע-עורק וייצר-סערת-חיבוש-קרים
// שהציתה-את-המחזור-הבא-מהר-יותר: 30-מחזורי-כפייה ב-53דק', קפיצות-חימום +500MB ב-12שנ'.
//
// החוק-החדש (כיול-למדידה, לא-התרה):
//   • תקרה 1500MB — מעל-השיא-הנמדד, ו-600MB-מתחת-לקו-ההרג-ההיסטורי-של-הגרעין (2.1GB);
//   • טווח-תכנון 1400–1500MB: כשהלב-בטל (אין-tick-בטיסה) → מיחזור-חלון-שקט מתוכנן
//     בין-עבודות; כשהלב-עסוק → ממתין-כנה לחלון-פנוי (לא-הורגים-עבודה-באמצע);
//   • מעל-התקרה → כפייה מיד (הגרעין-מאיים — עבודה-בטיסה-פחותה-מהישרדות).
export interface RecycleDecision {
  action: 'none' | 'planned' | 'forced'
  reason: string
}

export interface RecycleInputs {
  rssMb: number | null
  ceilingMb: number
  bandMb: number
  idle: boolean
}

export function recycleDecision(inputs: RecycleInputs): RecycleDecision {
  const { rssMb, ceilingMb, bandMb, idle } = inputs
  if (rssMb === null) return { action: 'none', reason: 'no-measurement' }
  if (rssMb > ceilingMb) {
    return { action: 'forced', reason: `ceiling ${rssMb}MB > ${ceilingMb}MB` }
  }
  if (rssMb > bandMb) {
    return idle
      ? { action: 'planned', reason: `quiet-window ${rssMb}MB in band (${bandMb}–${ceilingMb}MB)` }
      : { action: 'none', reason: `in-band ${rssMb}MB — busy, waiting for idle window (honest)` }
  }
  return { action: 'none', reason: `below-band ${rssMb}MB ≤ ${bandMb}MB` }
}
