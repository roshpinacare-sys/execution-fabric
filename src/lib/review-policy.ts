import { sha256Short } from '@/lib/ledger'

// מדיניות-סקירת-ארטיפקטים (Task 43) — הכתבת מדיניות-סקירת-הבעלים-המואצלת כחוק-מערכת.
// הסף-לא-יורד-גם-כשהבעלים-ישן: כל-סוכן (ארכיטקטורה/הנדסה/ריבונות/לב) שפועל דרך
// /api/sovereign/ops מחויב לאותו-סף בדיוק:
//   1) hash-ארטיפקט חייב להיות תואם ל-artifactHash שנחתם-בשעת-הצעה
//   2) דפוסי-ריצה/shell אסורים → השהיה עם-נימוקים (אפס-החרגות)
//   3) החלטות נחתמות בשרשרת-האמת (AUDIT, worker=sovereignty-ops-tick)
// הדפוסים כאן הם הכתבה-מדויקת של הסריקה שהריצה ידנית ב-Tasks 40-42
// (nughje2c: execSync+curl+interpolation → הושהה; gm9vx0id: child_process+wget → הושהה).

export const UNSAFE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'child_process', re: /\bchild_process\b/ },
  { name: 'execSync', re: /\bexecSync\b/ },
  { name: 'exec-shell-interp', re: /\bexec\s*\(\s*`[^`]*\$\{/ },
  { name: 'execSync-shell-interp', re: /\bexecSync\s*\(\s*`[^`]*\$\{/ },
  { name: 'eval', re: /\beval\s*\(/ },
  { name: 'new-Function', re: /\bnew\s+Function\s*\(/ },
  { name: 'wget', re: /\bwget\b/ },
  { name: 'curl', re: /\bcurl\b/ },
  { name: 'sudo', re: /\bsudo\b/ },
  { name: 'chmod-777', re: /chmod\s+777/ },
  { name: 'base64-d', re: /base64\s+-d/ },
  { name: 'rm-rf', re: /rm\s+-rf/ },
]

export interface ReviewVerdict {
  deliverable: boolean
  reasons: string[]
}

export function reviewArtifact(
  code: string | null,
  expectedHash: string | null
): ReviewVerdict {
  const reasons: string[] = []
  if (code == null || code.length === 0) {
    reasons.push('artifact-missing')
    return { deliverable: false, reasons }
  }
  if (expectedHash && sha256Short(code) !== expectedHash) {
    reasons.push('artifact-hash-mismatch')
  }
  for (const p of UNSAFE_PATTERNS) {
    if (p.re.test(code)) reasons.push(`unsafe-pattern:${p.name}`)
  }
  return { deliverable: reasons.length === 0, reasons }
}
