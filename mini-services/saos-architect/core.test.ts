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
