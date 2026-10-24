// ═════════════════════════════════════════════════════════════════════════════
// build-lane.ts — מסילת-הבנייה-העצמית של הארכיטקט (Task-136 §5 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים §5: "Automatically identify code debt, write unit/integration
// tests, author feature code, self-repair tracebacks, and auto-merge green PRs."
//
// חוקי-הבית (המסילה-בנויה-על-שערים, לא-על-אמון):
//  · רק-אישיות-עם-חוזה-בנייה-מפורש (fenced JSON) נבנית — בלי-חוזה: לא-בנויה.
//  · patchGuard: כל-קובץ-נגע-חייב-להיות-בחוזה; חייב-לגעת-לפחות-בקובץ-בדיקה-אחד
//    (TDD-required); אסור-TODO/FIXME/mock/stub/unimplemented; תקרת-גודל.
//  · אף-פלט-LLM-לא-נוגע-בעץ-בטרם-השער; כשל-בדיקות-אחרי-החלה = שחזור-מלא-כנה.
// ═════════════════════════════════════════════════════════════════════════════

export interface BuildContract {
  organ: string
  /** נתיבים-יחסיים-לשורש-הפרויקט — הרשימה-הסגורה-היחידה שהמסילה-רשאית-לגעת-בה */
  files: string[]
  acceptance: string[]
}

export interface ProposedFile {
  path: string
  content: string
}

const CONTRACT_RE = /```build-contract\s*\n([\s\S]*?)```/
const FORBIDDEN_RE = /\b(TODO|FIXME|HACK|XXX)\b|mock|stub|not[- ]implemented|throw new Error\(['"]not\b/i
const MAX_FILE_BYTES = 24_000
const MAX_FILES = 4

/** חילוץ-חוזה-מגוף-אישיות — null כשאין-חוזה-תקין (לא-בנוי-בלי-חוזה). */
export function parseBuildContract(issueBody: string): BuildContract | null {
  const m = CONTRACT_RE.exec(issueBody ?? '')
  if (!m) return null
  try {
    const j = JSON.parse(m[1].trim()) as Partial<BuildContract>
    if (typeof j.organ !== 'string' || !/^[a-z][a-z0-9-]*$/.test(j.organ)) return null
    if (!Array.isArray(j.files) || j.files.length === 0 || j.files.length > MAX_FILES) return null
    const files = j.files.map(String).filter((f) => f.startsWith('mini-services/') || f.startsWith('src/'))
    if (files.length !== j.files.length) return null // נתיב-מחוץ-לעץ-המותר = חוזה-פסול
    const acceptance = Array.isArray(j.acceptance) ? j.acceptance.map(String) : []
    return { organ: j.organ, files, acceptance }
  } catch {
    return null
  }
}

/** שער-התיקונים — אפס-אמון-ב-LLM. */
export function patchGuard(proposed: ProposedFile[], contract: BuildContract): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(proposed) || proposed.length === 0) return { ok: false, reason: 'empty-patch' }
  if (proposed.length > MAX_FILES) return { ok: false, reason: `too-many-files (${proposed.length}>${MAX_FILES})` }
  const allowed = new Set(contract.files)
  let touchesTest = false
  for (const f of proposed) {
    if (!allowed.has(f.path)) return { ok: false, reason: `file-outside-contract: ${f.path}` }
    if (!f.path.startsWith('mini-services/') && !f.path.startsWith('src/')) return { ok: false, reason: `path-forbidden: ${f.path}` }
    if (typeof f.content !== 'string' || f.content.length === 0) return { ok: false, reason: `empty-content: ${f.path}` }
    if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) return { ok: false, reason: `file-too-large: ${f.path}` }
    if (/\.test\.|\/tests?\/|_test\./.test(f.path)) touchesTest = true
    if (FORBIDDEN_RE.test(f.content)) return { ok: false, reason: `forbidden-pattern-in: ${f.path} (TODO/mock/stub — אפס-אדמה)` }
  }
  if (!touchesTest) return { ok: false, reason: 'no-test-file-touched (TDD-required — בנייה-בלי-בדיקה אסורה)' }
  return { ok: true }
}

/** קבלת-מסילה: ירוק-רק-אם-0-כישלונות-ו-תוצאה-קיימת. */
export function buildVerdict(testOut: string, pass: number, fail: number, exitCode: number): { ok: boolean; reason: string } {
  if (exitCode !== 0) return { ok: false, reason: `test-exit-${exitCode}` }
  if (fail !== 0) return { ok: false, reason: `${fail}-failures` }
  if (pass <= 0) return { ok: false, reason: 'no-passing-tests-measured' }
  return { ok: true, reason: `${pass}-pass` }
}
