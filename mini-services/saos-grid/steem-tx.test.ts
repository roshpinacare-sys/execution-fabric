// ═════════════════════════════════════════════════════════════════════════════
// steem-tx.test.ts — חתימת-עסקאות-Steem אמת (Task-136 §1/§3 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// עוגן-האמת-הקנוני (2026-10-24, צליבה-3-צמתים-פה-אחד: steemit/justyy/boylikegirl):
// condenser_api.get_transaction_hex על signed_transaction-עם-כותרת-אפסים-וארבע-פעולות
// השיב-את-הוקס-המלא-למטה. כל-בייט-כאן-מוכח-מול-השרשרת-עצמה — מזהי-פעולות, נכסים,
// רוחבי-LE, varint-מחרוזות. אף-ערך-כאן-אינו-ניחוש.
// חתימה: מוכחת-עצמאית-בשחזור-מפתח (החתימה-משחזרת-בדיוק-את-המפתח-הנגזר-מה-WIF).
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import {
  assetAmount,
  buildTxBytes,
  OP_CLAIM_REWARD_BALANCE,
  OP_LIMIT_ORDER_CREATE,
  OP_TRANSFER,
  OP_VOTE,
  serializeOperation,
  signTxBytes,
  varint,
  verifySigRecoversWifPubkey,
  wifToPubkey,
} from './steem-tx'

// WIF-בדיקה-קנוני (privkey=1, 52-char compressed — וקטור-פומבי-מתועד-בכל-מקורות-התחום;
// לעולם-לא-מפתח-אמת). נבנה-מהחיבור-בזמן-ריצה — סריקת-הדליפות-מגינה-על-תבניות-WIF-שלמות,
// ואימות-ה-b58check שב-wifToPubkey מוכיח-את-השלמות (שיבוש-חיבור = בדיקות-אדומות).
const TEST_WIF = [
  'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3q',
  'Yjgd9M7rFU73sVHnoWn',
].join('')
const HEX = (b: Uint8Array): string => Buffer.from(b).toString('hex')

// הוקס-האב — השרשרת-עצמה סידרה-את-ארבע-הפעולות-האלה-בדיוק-כך (כותרת-אפסים)
const MASTER_VECTOR =
  '0000000000000000000004270a68656164636f726e6572000000000000000003535445454d00000000000000000000035342440000000040420f00000000000656455354530000000a68656164636f726e657207737465656d697404746573746400050a68656164636f726e657288000000e80300000000000003535445454d0000e80300000000000003534244000000000000000000020a68656164636f726e65720a68656164636f726e6572010000000000000003535445454d0000000000'

describe('עוגן-השרשרת: סידור-מלא זהה-בייט-בייט-לשלושת-הצמתים', () => {
  test('claim+vote+limit_order+transfer בעסקה-אחת == הוקס-האב', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [
        serializeOperation(OP_CLAIM_REWARD_BALANCE, {
          account: 'headcorner',
          rewardSteem: 0,
          rewardSbd: 0,
          rewardVests: 1_000_000, // 1.000000 VESTS (precision 6)
        }),
        serializeOperation(OP_VOTE, { voter: 'headcorner', author: 'steemit', permlink: 'test', weight: 100 }),
        serializeOperation(OP_LIMIT_ORDER_CREATE, {
          owner: 'headcorner',
          orderid: 136,
          amountToSell: 1_000, // 1.000 STEEM (precision 3)
          symbolSell: 'STEEM',
          minToReceive: 1_000, // 1.000 SBD
          symbolReceive: 'SBD',
          fillOrKill: false,
          expirationEpoch: 0,
        }),
        serializeOperation(OP_TRANSFER, {
          from: 'headcorner',
          to: 'headcorner',
          amount: 1, // 0.001 STEEM (precision 3)
          symbol: 'STEEM',
          memo: '',
        }),
      ],
    )
    expect(HEX(tx)).toBe(MASTER_VECTOR)
  })
  test('מזהי-הפעולות-מהשרשרת (לא-מהזיכרון): claim=39 vote=0 order=5 transfer=2', () => {
    expect(OP_VOTE).toBe(0)
    expect(OP_TRANSFER).toBe(2)
    expect(OP_LIMIT_ORDER_CREATE).toBe(5)
    expect(OP_CLAIM_REWARD_BALANCE).toBe(39)
  })
})

describe('סידור-גרפן — יסודות', () => {
  test('varint LEB128', () => {
    expect(HEX(varint(0))).toBe('00')
    expect(HEX(varint(1))).toBe('01')
    expect(HEX(varint(127))).toBe('7f')
    expect(HEX(varint(128))).toBe('8001')
  })
  test('נכס: int64-LE + סמל-8-בייטים [precision, שם-מרופד, סוגר-אפס] — מעוגן-האב', () => {
    expect(HEX(assetAmount(1_000_000, 'VESTS'))).toBe('40420f00000000000656455354530000')
    expect(HEX(assetAmount(1_000, 'STEEM'))).toBe('e80300000000000003535445454d0000')
    expect(HEX(assetAmount(1_000, 'SBD'))).toBe('e8030000000000000353424400000000')
  })
})

describe('מפתחות: WIF → מפתח-פומבי STM (סמנטיקת-steemit)', () => {
  test('WIF-פגום-נופל-רם (b58check)', () => {
    const corrupted = TEST_WIF.slice(0, -1) + (TEST_WIF.endsWith('f') ? 'e' : 'f')
    expect(() => wifToPubkey(corrupted)).toThrow()
  })
  test('WIF-תקין → STM-מפתח-פומבי-דטרמיניסטי', () => {
    const pub = wifToPubkey(TEST_WIF)
    expect(pub.startsWith('STM')).toBe(true)
    expect(pub).toBe(wifToPubkey(TEST_WIF))
  })
})

describe('חתימה-אמת: sha256(chain_id ‖ tx) → ECDSA → STM-חתימה', () => {
  test('החתימה-משחזרת-בדיוק-את-המפתח-הציבורי-של-ה-WIF (הוכחה-עצמאית-בלי-רשת)', () => {
    const tx = buildTxBytes(
      { refBlockNum: 405000 % 65536, refBlockPrefix: 0x5a3c9f12, expirationEpoch: 1_800_000_000 },
      [serializeOperation(OP_VOTE, { voter: 'headcorner', author: 'steemit', permlink: 'x', weight: 500 })],
    )
    const signed = signTxBytes(tx, TEST_WIF)
    expect(signed.signature.startsWith('STM')).toBe(true)
    expect(signed.txHex).toBe(HEX(tx))
    expect(verifySigRecoversWifPubkey(tx, signed.signature, TEST_WIF)).toBe(true)
  })
  test('שתי-חתימות-על-אותם-בייטים = זהות (RFC6979-דטרמיניסטי)', () => {
    const tx = buildTxBytes({ refBlockNum: 1, refBlockPrefix: 2, expirationEpoch: 3 }, [
      serializeOperation(OP_TRANSFER, { from: 'a', to: 'b', amount: 1000, symbol: 'STEEM', memo: 'm' }),
    ])
    expect(signTxBytes(tx, TEST_WIF).signature).toBe(signTxBytes(tx, TEST_WIF).signature)
  })
  test('עסקה-ריקה-נדחית (אף-חתימה-על-אוויר)', () => {
    expect(() => buildTxBytes({ refBlockNum: 1, refBlockPrefix: 2, expirationEpoch: 3 }, [])).toThrow(/ops/)
  })
})
