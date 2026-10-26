// ═════════════════════════════════════════════════════════════════════════════
// harvest.test.ts — מדיניות-קציר-וקיורציה (Task-136 §1 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  claimDecision,
  curationCandidates,
  rotationAccount,
  rcVoteGate,
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

// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-141 §2 — סבב-קיורציה-פר-חייל + שער-RC-מדיד (ליבה-טהורה)
// ═════════════════════════════════════════════════════════════════════════════
describe('rotationAccount — סבב-הקיורציה-על-כל-חיילי-הכספת', () => {
  test('סבב-מדויק: פעימה-k → החשבון-ה-k', () => {
    const order = ['headcorner', 'saos-0001', 'saos-0002', 'saos-0003', 'saos-0004']
    expect(rotationAccount(order, 0)).toBe('headcorner')
    expect(rotationAccount(order, 1)).toBe('saos-0001')
    expect(rotationAccount(order, 4)).toBe('saos-0004')
    expect(rotationAccount(order, 5)).toBe('headcorner') // חוזר-לראש
    expect(rotationAccount(order, 12)).toBe('saos-0002')
  })

  test('קלט-פגום → null (רשימה-ריקה / אינדקס-לא-שלם-שלילי-מתדרדר-ל-0)', () => {
    expect(rotationAccount([], 3)).toBeNull()
    expect(rotationAccount(['a'], -7)).toBe('a') // שלילי → דורד ל-0 (כנה, לא-קריסה)
    expect(rotationAccount(['a', 'b'], Number.NaN)).toBe('a')
  })
})

describe('rcVoteGate — שער-RC-מדיד-בטרם-הצבעה (אפס-סערת-שידורים-נכשלים)', () => {
  test('mana-מדוד-מעל-המינימום → ההצבעה-מותרת', () => {
    expect(rcVoteGate(6_832_919_319, 2_000_000_000)).toBe(true) // חייל-מלא-חי (נמדד-חי 26/10)
    expect(rcVoteGate(2_000_000_000, 2_000_000_000)).toBe(true) // על-הגבול = מותר
  })

  test('mana-מתחת-למינימום → חסום (שימור-הרשת — לא-שולחים-שידור-שיכשל)', () => {
    expect(rcVoteGate(1_999_999_999, 2_000_000_000)).toBe(false)
    expect(rcVoteGate(0, 2_000_000_000)).toBe(false)
  })

  test('לא-נמדד → fail-closed (מצב-לא-מאומת = עצירה-כנה, לא-המצאה)', () => {
    expect(rcVoteGate(null, 2_000_000_000)).toBe(false)
    expect(rcVoteGate(Number.NaN, 2_000_000_000)).toBe(false)
  })
})
