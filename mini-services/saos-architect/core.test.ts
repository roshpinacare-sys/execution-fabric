// ═════════════════════════════════════════════════════════════════════════════
// core.test.ts — הליבה-הטהורה של הארכיטקט-הריבוני (§1/§4) — TDD
// שרשרת-קבלות-hash-linked (סמנטיקת-GENESIS של fleet-economy) + ניתוח-פלט-בדיקות.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  GENESIS,
  parseBunTestOutput,
  receiptHash,
  verifyChain,
  type ArchitectReceipt,
} from './core'

function receipt(over: Partial<ArchitectReceipt> = {}): ArchitectReceipt {
  return {
    at: '2026-10-24T19:00:00.000Z',
    cycle: 1,
    suites: [{ name: 'saos-dex', ok: true, pass: 61, fail: 0 }],
    issues: { open: 3, filed: 0 },
    gitHead: '00cbfcc',
    originSynced: true,
    prev: GENESIS,
    ...over,
  }
}

describe('receiptHash — חתימה-קנונית', () => {
  test('דטרמיניסטי ובלתי-תלוי-סדר-מפתחות', () => {
    const a = receipt()
    const b = JSON.parse(JSON.stringify(receipt())) as ArchitectReceipt
    // אותו-תוכן, סדר-מפתחות-שונה
    const reordered = {
      gitHead: b.gitHead, at: b.at, suites: b.suites, cycle: b.cycle,
      issues: b.issues, originSynced: b.originSynced, prev: b.prev,
    } as unknown as ArchitectReceipt
    expect(receiptHash(a)).toBe(receiptHash(reordered))
  })
  test('שינוי-תוכן כלשהו → hash-שונה', () => {
    const a = receiptHash(receipt())
    const b = receiptHash(receipt({ cycle: 2 }))
    const c = receiptHash(receipt({ suites: [{ name: 'saos-dex', ok: false, pass: 60, fail: 1 }] }))
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(32)
  })
})

describe('verifyChain — אימות-קצה-לקצה fail-closed', () => {
  test('שרשרת-ריקה → ok, head=GENESIS', () => {
    const v = verifyChain([])
    expect(v.ok).toBe(true)
    expect(v.verified).toBe(0)
    expect(v.head).toBe(GENESIS)
    expect(GENESIS).toBe('GENESIS')
  })
  test('שרשרת-תקינה-בת-2 → ok, verified=2, head=האחרון', () => {
    const r1 = receipt()
    const h1 = receiptHash(r1)
    const r2 = receipt({ cycle: 2, prev: h1 })
    const line1 = { ...r1, hash: h1 }
    const line2 = { ...r2, hash: receiptHash(r2) }
    const v = verifyChain([line1, line2])
    expect(v.ok).toBe(true)
    expect(v.verified).toBe(2)
    expect(v.head).toBe(line2.hash)
  })
  test('זיוף-תוכן (cycle בלי-חתימה-מחדש) → נשבר-בנקודה-המדויקת', () => {
    const r1 = receipt()
    const legit = { ...r1, hash: receiptHash(r1) }
    const r2 = receipt({ cycle: 2, prev: legit.hash })
    const tampered = { ...r2, cycle: 99, hash: receiptHash(r2) } // התוכן-שונה-מהחתימה
    const v = verifyChain([legit, tampered])
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(2)
  })
  test('קישור-prev-שבור → נשבר-בשרשרת-הבאה', () => {
    const r1 = { ...receipt(), hash: receiptHash(receipt()) }
    const r2 = receipt({ cycle: 2, prev: 'GENESIS' }) // היה-צריך-להיות-prev=r1.hash
    const v = verifyChain([r1, { ...r2, hash: receiptHash(r2) }])
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(2)
  })
})

describe('parseBunTestOutput — ניתוח-פלט-bun-test', () => {
  test('פלט-רגיל: pass/fail מדויקים', () => {
    const out = `\n 5 pass\n 1 fail\n 12 expect() calls\nRan 6 tests across 1 file. [20.00ms]\n`
    expect(parseBunTestOutput(out)).toEqual({ pass: 5, fail: 1 })
  })
  test('הצלחה-מלאה בלי-fail → fail=0', () => {
    const out = ` 61 pass\n 0 fail\n 224 expect() calls\n`
    expect(parseBunTestOutput(out)).toEqual({ pass: 61, fail: 0 })
  })
  test('פלט-זבל/ריק → {0,0} (אפס-המצאה)', () => {
    expect(parseBunTestOutput('')).toEqual({ pass: 0, fail: 0 })
    expect(parseBunTestOutput('segmentation fault')).toEqual({ pass: 0, fail: 0 })
  })
})

// ═══ Task-142: ארטיפקטי-מדינה (execution-state / quality-report) ═══
import { buildExecutionState, buildQualityReport, type ExecutionStateInput } from './core'

const INPUT: ExecutionStateInput = {
  at: '2026-10-27T12:00:00.000Z',
  cycle: 15,
  chain: { ok: true, verified: 14, head: 'abc123' },
  git: { head: 'deadbee', originSynced: true },
  suites: [
    { name: 'saos-dex', ok: true, pass: 101, fail: 0 },
    { name: 'saos-grid', ok: true, pass: 122, fail: 0 },
    { name: 'saos-arb', ok: false, pass: 27, fail: 2 },
  ],
  lintOk: true,
  issues: { open: 1, filed: 0 },
  build: { attempts: 3, merged: 1, reverted: 0, lastVerdict: 'honest-empty' },
}

describe('buildQualityReport — Task-142', () => {
  test('סכומים-מדויקים-מהסוללות (אין-המצאה)', () => {
    const r = buildQualityReport(INPUT)
    expect(r.schema).toBe('saos-quality-report/1')
    expect(r.totals).toEqual({ pass: 250, fail: 2, suites: 3 })
    expect(r.allGreen).toBe(false) // יש-2-כשלונות — כנה-אדום
    expect(r.lintOk).toBe(true)
  })
  test('allGreen-ירוק רק-כשיש-בדיקות-ואפס-כשלונות', () => {
    const green = buildQualityReport({ ...INPUT, suites: [{ name: 'x', ok: true, pass: 5, fail: 0 }] })
    expect(green.allGreen).toBe(true)
    const empty = buildQualityReport({ ...INPUT, suites: [] })
    expect(empty.allGreen).toBe(false) // אפס-בדיקות ≠ ירוק
  })
})

describe('buildExecutionState — Task-142', () => {
  test('מרחיב-את-הדוח-בשרשרת/git/issues/build — כל-השדות-מהמדידה', () => {
    const s = buildExecutionState(INPUT)
    expect(s.schema).toBe('saos-execution-state/1')
    expect(s.chain).toEqual({ ok: true, verified: 14, head: 'abc123' })
    expect(s.git).toEqual({ head: 'deadbee', originSynced: true })
    expect(s.issues).toEqual({ open: 1, filed: 0 })
    expect(s.build.lastVerdict).toBe('honest-empty')
    expect(s.totals.pass).toBe(250)
  })
  test('null-כנה-נשמר (originSynced-לא-נמדד → null, לא-false-מזויף)', () => {
    const s = buildExecutionState({ ...INPUT, git: { head: 'x', originSynced: null }, lintOk: null })
    expect(s.git.originSynced).toBe(null)
    expect(s.lintOk).toBe(null)
  })
})
