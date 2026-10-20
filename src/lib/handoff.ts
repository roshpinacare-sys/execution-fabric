// ליבת-שער-ההעברה (worklog Task 20): חילוץ-ארטיפקט + ולידציות משותפות.
// הארטיפקט = Task.output כולו, או שדה-מחרוזת נבחר מתוכו (field).

export const HANDOFF_STATUSES = [
  'PROPOSED',
  'APPROVED',
  'RUNNING',
  'DONE',
  'FAILED',
  'REJECTED', // Task 100: פסילת-ביקורת-חוזרת-3x — סופי, כן, נראה (אין-סריקה-אינסופית)
] as const
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number]

export const HANDOFF_MAX_BYTES = 256 * 1024

export function extractArtifact(
  taskOutput: string,
  field: string | null
): string | null {
  if (!field) return taskOutput
  try {
    const parsed = JSON.parse(taskOutput) as Record<string, unknown> | null
    const v = parsed?.[field]
    return typeof v === 'string' && v.length > 0 ? v : null
  } catch {
    return null
  }
}

export function validateHandoffPath(path: string): string | null {
  if (path.length < 1 || path.length > 220) return 'נתיב חייב 1-220 תווים'
  if (path.startsWith('/') || path.endsWith('/')) return 'הנתיב לא יכול להתחיל או להיגמר ב-/'
  if (path.includes('..')) return 'הנתיב לא יכול להכיל ..'
  if (/[\x00-\x1f\\<>:"|?*]/.test(path)) return 'הנתיב מכיל תווים אסורים'
  return null
}
