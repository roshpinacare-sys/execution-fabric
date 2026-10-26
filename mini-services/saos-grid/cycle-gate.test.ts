// ═════════════════════════════════════════════════════════════════════════════
// cycle-gate.test.ts — Task-141-e (audit hardening): שער-single-flight למחזור
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { cycleGateDecision } from './engine'

describe('cycleGateDecision — single-flight-למחזור-הגריד', () => {
  test('חופשי → מותר', () => {
    expect(cycleGateDecision(false)).toEqual({ allow: true, reason: 'ok' })
  })
  test('עסוק → נכנס-לב-והסיבה-מדווחת-בשמה (אין-השתקה)', () => {
    const d = cycleGateDecision(true)
    expect(d.allow).toBe(false)
    expect(d.reason).toContain('busy')
  })
  test('גבולות-בוליאניים מדויקים', () => {
    expect(cycleGateDecision(false).allow).toBe(true)
    expect(cycleGateDecision(true).allow).toBe(false)
  })
})
