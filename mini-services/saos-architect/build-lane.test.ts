// ═════════════════════════════════════════════════════════════════════════════
// build-lane.test.ts — שערי-מסילת-הבנייה (Task-136 §5 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  buildVerdict,
  parseBuildContract,
  patchGuard,
  type ProposedFile,
} from './build-lane'

const CONTRACT = { organ: 'saos-arb', files: ['mini-services/saos-arb/soldiers.ts', 'mini-services/saos-arb/soldiers.test.ts'], acceptance: ['bun test green'] }
const CONTRACT_BODY = `## חוזה\n\n\`\`\`build-contract\n${JSON.stringify(CONTRACT)}\n\`\`\`\n`

describe('parseBuildContract — בלי-חוזה: לא-בנויה', () => {
  test('גוף-ללא-חוזה → null (כנות: אין-מה-לבנות)', () => {
    expect(parseBuildContract('אישיות-רגילה בלי-חוזה')).toBeNull()
    expect(parseBuildContract('')).toBeNull()
  })
  test('חוזה-תקין מחולץ-מדויק', () => {
    const c = parseBuildContract(CONTRACT_BODY)!
    expect(c.organ).toBe('saos-arb')
    expect(c.files).toContain('mini-services/saos-arb/soldiers.ts')
  })
  test('חוזה-פסול: JSON-שבור / organ-פסול / נתיב-מחוץ-לעץ → null', () => {
    expect(parseBuildContract('```build-contract\n{broken\n```')).toBeNull()
    expect(parseBuildContract('```build-contract\n{"organ":"X!","files":["mini-services/a/b.ts"]}\n```')).toBeNull()
    expect(parseBuildContract('```build-contract\n{"organ":"a","files":["/etc/passwd"]}\n```')).toBeNull()
    expect(parseBuildContract('```build-contract\n{"organ":"a","files":[]}\n```')).toBeNull()
  })
})

describe('patchGuard — אפס-אמון-ב-LLM', () => {
  const testFile: ProposedFile = { path: 'mini-services/saos-arb/soldiers.test.ts', content: 'test("x", () => expect(1).toBe(1))' }

  test('תיקון-תקין-עם-בדיקה → ok', () => {
    expect(patchGuard([testFile, { path: 'mini-services/saos-arb/soldiers.ts', content: 'export const x = 1' }], CONTRACT)).toEqual({ ok: true })
  })
  test('קובץ-מחוץ-לחוזה → נדחה', () => {
    expect(patchGuard([{ path: 'mini-services/saos-dex/index.ts', content: 'x' }], CONTRACT).ok).toBe(false)
  })
  test('בלי-קובץ-בדיקה → נדחה (TDD-required)', () => {
    expect(patchGuard([{ path: 'mini-services/saos-arb/soldiers.ts', content: 'x' }], CONTRACT).ok).toBe(false)
  })
  test('TODO/mock/stub בתוכן → נדחה (אפס-אדמה)', () => {
    for (const bad of ['// TODO: fix', 'const m = mock()', 'stub implementation', "throw new Error('not implemented')"]) {
      expect(patchGuard([{ path: 'mini-services/saos-arb/soldiers.test.ts', content: bad }], CONTRACT).ok).toBe(false)
    }
  })
  test('תוכן-ריק / קלט-ריק → נדחה', () => {
    expect(patchGuard([{ path: 'mini-services/saos-arb/soldiers.test.ts', content: '' }], CONTRACT).ok).toBe(false)
    expect(patchGuard([], CONTRACT).ok).toBe(false)
  })
})

describe('buildVerdict — ירוק-רק-על-מדידה-אמת', () => {
  test('exit0 + fail0 + pass>0 → ok', () => {
    expect(buildVerdict('out', 10, 0, 0)).toEqual({ ok: true, reason: '10-pass' })
  })
  test('כישלונות / exit-לא-אפס / אפס-עוברות → לא-ירוק', () => {
    expect(buildVerdict('out', 10, 2, 1).ok).toBe(false)
    expect(buildVerdict('out', 10, 0, 1).ok).toBe(false)
    expect(buildVerdict('out', 0, 0, 0).ok).toBe(false)
  })
})
