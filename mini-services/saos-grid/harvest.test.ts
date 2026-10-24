// ═════════════════════════════════════════════════════════════════════════════
// harvest.test.ts — מדיניות-קציר-וקיורציה (Task-136 §1 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  claimDecision,
  curationCandidates,
  voteWeightBps,
  type Discussion,
  type PendingRewards,
} from './harvest'

describe('claimDecision — קציר-פרסים (אפס-עסקאות-אבק)', () => {
  test('פרסים-אפסים → אין-claim (כנות: אין-כסף-לקצור)', () => {
    const r: PendingRewards = { steem: 0, sbd: 0, vests: 0 }
    expect(claimDecision('headcorner', r, 0)).toBeNull()
  })
  test('פרסים-מתחת-לאבק → אין-claim', () => {
    const r: PendingRewards = { steem: 1, sbd: 0, vests: 0 } // 0.001 STEEM = 1
    expect(claimDecision('headcorner', r, 1_000)).toBeNull()
  })
  test('פרסים-מעל-האבק → op-מדויק-ביחידות-הגלם', () => {
    const r: PendingRewards = { steem: 5_000, sbd: 500, vests: 1_234_567 } // 5 STEEM, 0.5 SBD, 1.234567 VESTS
    const d = claimDecision('headcorner', r, 1_000)!
    expect(d.account).toBe('headcorner')
    expect(d.rewardSteem).toBe(5_000)
    expect(d.rewardSbd).toBe(500)
    expect(d.rewardVests).toBe(1_234_567)
  })
  test('סכום-מעורב-מעל-האבק גם-אם-כל-צד-בנפרד-קטן-מקבל-claim-כן (הסכום-הוא-הקריטריון)', () => {
    // האבק-נמדד-על-סה"כ-הערך-הגולמי (יחידות-גלם) — לא-על-כל-צד-בנפרד
    const r: PendingRewards = { steem: 0, sbd: 2_000, vests: 0 }
    expect(claimDecision('headcorner', r, 1_000)).not.toBeNull()
  })
  test('גבול-אבק-מדויק: vests-only-שווה-לאבק → null', () => {
    // vests/100 = 1_000 → exact dust boundary
    const r: PendingRewards = { steem: 0, sbd: 0, vests: 100_000 }
    expect(claimDecision('headcorner', r, 1_000)).toBeNull()
  })
  test('גבול-אבק-מדויק: vests-only-קטן-מהאבק → null', () => {
    // vests/100 < 1_000 → below dust boundary
    const r: PendingRewards = { steem: 0, sbd: 0, vests: 99_999 }
    expect(claimDecision('headcorner', r, 1_000)).toBeNull()
  })
  test('גבול-אבק-מדויק: vests-only-מעל-האבק → claim עם-vests-מדויק', () => {
    // vests/100 = 1_001 → above dust boundary
    const r: PendingRewards = { steem: 0, sbd: 0, vests: 100_100 }
    const d = claimDecision('headcorner', r, 1_000)!
    expect(d.account).toBe('headcorner')
    expect(d.rewardSteem).toBe(0)
    expect(d.rewardSbd).toBe(0)
    expect(d.rewardVests).toBe(100_100) // passthrough unchanged
  })
  test('גבול-אבק-מדויק: סכום-מעורב-שווה-לאבק → null', () => {
    // steem + sbd + floor(vests/100) = 1_000 → exact dust boundary
    const r: PendingRewards = { steem: 500, sbd: 400, vests: 20_000 } // 500 + 400 + floor(200) = 1_100
    expect(claimDecision('headcorner', r, 1_100)).toBeNull()
  })
  test('גבול-אבק-מדויק: סכום-מעורב-מעל-האבק → claim עם-vests-מדויק', () => {
    // steem + sbd + floor(vests/100) = 1_101 → above dust boundary
    const r: PendingRewards = { steem: 500, sbd: 400, vests: 20_100 } // 500 + 400 + floor(201) = 1_101
    const d = claimDecision('headcorner', r, 1_100)!
    expect(d.account).toBe('headcorner')
    expect(d.rewardSteem).toBe(500)
    expect(d.rewardSbd).toBe(400)
    expect(d.rewardVests).toBe(20_100) // passthrough unchanged
  })
})

describe('voteWeightBps — משקל-הצבעה שמור-ודטרמיניסטי', () => {
  test('VP-גבוה → משקל-בסיס מלא', () => {
    expect(voteWeightBps(10_000, 2_000, 500)).toBe(500)
  })
  test('VP-מתחת-לשער → 0 (שימור-המנוע — החיים-של-הקיורציה-הם-ה-VP)', () => {
    expect(voteWeightBps(1_999, 2_000, 500)).toBe(0)
    expect(voteWeightBps(0, 2_000, 500)).toBe(0)
  })
  test('משקל-לעולם-לא-חורג-מהתקרה גם-ב-VP-מוזר', () => {
    expect(voteWeightBps(10_000, 2_000, 10_000)).toBe(10_000) // התקרה-היא-החוק — אך-לא-מעבר-ל-10000
    expect(voteWeightBps(10_000, 2_000, 20_000)).toBe(10_000)
  })
})

describe('curationCandidates — בחירה דטרמיניסטית מרשימות-אמת', () => {
  const now = 1_800_000_000_000
  const mk = (over: Partial<Discussion>): Discussion => ({
    author: 'someone',
    permlink: 'p',
    createdEpochMs: now - 30 * 60_000, // 30 דקות
    pendingPayout: 2_000_000, // $2 (מיקרו-יחידות דולר)
    authorReputation: 65,
    alreadyVoted: false,
    ...over,
  })

  test('מסנן: עצמי-הצבעה, ישן-מדי, טרי-מדי, מוניטין-נמוך, תשלום-אפס', () => {
    const all = [
      mk({ author: 'self', alreadyVoted: true }), // כבר-הצבענו
      mk({ createdEpochMs: now - 10 * 3600_000 }), // ישן (10 שעות)
      mk({ createdEpochMs: now - 60_000 }), // טרי-מדי (דקה)
      mk({ authorReputation: 30 }), // מוניטין-נמוך
      mk({ pendingPayout: 0 }), // אין-תשלום
      mk({ author: 'good1' }),
      mk({ author: 'good2', createdEpochMs: now - 60 * 60_000, pendingPayout: 5_000_000 }),
    ]
    const picked = curationCandidates(all, { nowEpochMs: now, minAgeMin: 5, maxAgeMin: 240, minRep: 50, minPendingMicros: 100_000, limit: 5 })
    expect(picked.map((d) => d.author)).toEqual(['good2', 'good1']) // פוטנציאל-תשלום-גדול-ראשון
  })

  test('דטרמיניזם: אותו-קלט → אותו-סדר', () => {
    const all = [mk({ author: 'a', pendingPayout: 3 }), mk({ author: 'b', pendingPayout: 3 })]
    const r1 = curationCandidates(all, { nowEpochMs: now, minAgeMin: 5, maxAgeMin: 240, minRep: 50, minPendingMicros: 1, limit: 5 })
    const r2 = curationCandidates(all, { nowEpochMs: now, minAgeMin: 5, maxAgeMin: 240, minRep: 50, minPendingMicros: 1, limit: 5 })
    expect(r1).toEqual(r2)
    expect(r1.map((d) => d.author)).toEqual(['a', 'b']) // שוויון → שם-עולה
  })

  test('limit נאכף', () => {
    const all = Array.from({ length: 10 }, (_, i) => mk({ author: `a${i}`, pendingPayout: (i + 1) * 1_000_000 }))
    const picked = curationCandidates(all, { nowEpochMs: now, minAgeMin: 5, maxAgeMin: 240, minRep: 50, minPendingMicros: 1, limit: 3 })
    expect(picked).toHaveLength(3)
    expect(picked[0].pendingPayout).toBe(10_000_000) // הגדול-ראשון
  })
})
