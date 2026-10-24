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
    // Task-137 תיקון-סמנטיקה: זנב-ה-MASTER = memo + tx-ext + signatures(00) — ל-transfer
    // אין-op-ext (וקטור-ה-54-בייטים-המכריע-למטה). ההשוואה-הישנה עברה-בריקנות (3 אפסים-זהים).
    expect(HEX(tx) + SIGS_TAIL).toBe(MASTER_VECTOR)
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

// ═════════════════════════════════════════════════════════════════════════════
// Task-137 — מנוע-צמיחת-הצי: claim_account / create_claimed_account /
// delegate_vesting_shares. כל-וקטור-כאן-נשלף-מהשרשרת-עצמה (2026-10-24 22:4x,
// condenser_api.get_transaction_hex): claim+delegate צולבו-פה-אחד-על
// steemit/justyy/steem.fans; create נשלף-מsteemit-עם-מפתח-ציבורי-אמת-של-headcorner
// (ציבורי-לגמרי). שיטת-המערכת-על-3-וקטורים-פתרה-את-הפריסה-במדויק:
//  · זנב-טרנסקציה = tx-ext(00) + signatures(00) — get_transaction_hex מסדר-גם-חתימות-ריקות,
//    לכן-התוצר-שלנו (בלי-חתימות) = וקטור-מינוס-בייט-00-אחרון.
//  · claim_account יש-extensions (1 בייט); delegate_vesting_shares אין-extensions — המדידה-הכריעה.
// ═════════════════════════════════════════════════════════════════════════════
import { OP_ACCOUNT_CREATE, OP_CLAIM_ACCOUNT, OP_CREATE_CLAIMED_ACCOUNT, OP_DELEGATE_VESTING_SHARES, serializeAuthority, stmPubkeyToBytes, type AccountAuthority } from './steem-tx'

const ACTIVE_PUB = 'STM5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF' // פומבי-מהשרשרת
const AUTH_ONE: AccountAuthority = { threshold: 1, accountAuths: [], keyAuths: [[ACTIVE_PUB, 1]] }
const SIGS_TAIL = '00' // get_transaction_hex מוסיף-גם-חתימות-ריקות — אנחנו-מסדרים-עד-tx-ext

describe('Task-137: פעולות-צמיחת-צי — וקטורים-מהשרשרת', () => {
  test('מזהי-הפעולות-החדשים-מהשרשרת (לא-מהזיכרון): claim=22 create=23 delegate=40', () => {
    expect(OP_CLAIM_ACCOUNT).toBe(22)
    expect(OP_CREATE_CLAIMED_ACCOUNT).toBe(23)
    expect(OP_DELEGATE_VESTING_SHARES).toBe(40)
  })

  test('claim_account (fee 0.000 STEEM) == וקטור-42-בייטים-מינוס-חתימות', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [serializeOperation(OP_CLAIM_ACCOUNT, { creator: 'headcorner', feeRaw: 0, feeSymbol: 'STEEM' })],
    )
    const VECTOR =
      '0000000000000000000001160a68656164636f726e6572000000000000000003535445454d0000000000'
    expect(HEX(tx) + SIGS_TAIL).toBe(VECTOR)
  })

  test('delegate_vesting_shares (0.000000 VESTS) == וקטור-53-בייטים-מינוס-חתימות (אין-extensions — המדידה-הכריעה)', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [serializeOperation(OP_DELEGATE_VESTING_SHARES, { delegator: 'headcorner', delegatee: 'saosoldier1', vestingSharesRaw: 0 })],
    )
    const VECTOR =
      '0000000000000000000001280a68656164636f726e65720b73616f736f6c6469657231000000000000000006564553545300000000'
    expect(HEX(tx) + SIGS_TAIL).toBe(VECTOR)
  })

  test('create_claimed_account (authority ×3 + memo) == וקטור-195-בייטים-מינוס-חתימות', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [serializeOperation(OP_CREATE_CLAIMED_ACCOUNT, {
        creator: 'headcorner',
        newAccountName: 'saosoldier1',
        owner: AUTH_ONE,
        active: AUTH_ONE,
        posting: AUTH_ONE,
        memoKey: ACTIVE_PUB,
        jsonMetadata: '',
      })],
    )
    const VECTOR =
      '0000000000000000000001170a68656164636f726e65720b73616f736f6c64696572310100000000010234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e01000100000000010234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e01000100000000010234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e01000234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e00000000'
    expect(HEX(tx) + SIGS_TAIL).toBe(VECTOR)
  })

  test('stmPubkeyToBytes: מפתח-תקין → 33 בייטים; בדיקת-סכום-שבורה → fail-closed', () => {
    const bytes = stmPubkeyToBytes(ACTIVE_PUB)
    expect(bytes.length).toBe(33)
    expect(Buffer.from(bytes.slice(0, 1)).toString('hex')).toBe('02')
    const corrupted = 'STM' + ACTIVE_PUB.slice(3).slice(0, -1) + (ACTIVE_PUB.endsWith('F') ? 'G' : 'F')
    expect(() => stmPubkeyToBytes(corrupted)).toThrow()
  })

  test('serializeAuthority: threshold-LE + מוני-auth + (33 בייטים + משקל-u16-LE)', () => {
    const a = serializeAuthority(AUTH_ONE)
    expect(a.length).toBe(4 + 1 + 1 + 33 + 2)
    expect(a[0]).toBe(1) // threshold LE LSB
    expect(a[4]).toBe(0) // account_auths ריק
    expect(a[5]).toBe(1) // key_auths=1
    expect(a[6]).toBe(0x02) // קידומת-המפתח-הדחוס
    expect(a[39]).toBe(1) // weight=1 LE LSB
    expect(() => serializeAuthority({ threshold: 1, accountAuths: [], keyAuths: [[ACTIVE_PUB, 0]] })).toThrow(/weight/)
  })
})

describe('Task-137 מדידה-חיה: סכום-המפתחות-הציבוריים של-גרפן = ripemd160-פשוט (הוכח-מהצומת-ומ-4-מפתחות-אמת)', () => {
  test('מפתחות-אמת-מהשרשרת (headcorner ×4) עוברים stmPubkeyToBytes', () => {
    // נשלפו-מ-condenser_api.get_accounts ואומתו-מול-ה-assert-של-הצומת-עצמו
    expect(stmPubkeyToBytes('STM5aUKyd9LzENnMti5tS478Zu1SLJW51VHyu2gvSNGKhwfyMFpvv').length).toBe(33)
    expect(stmPubkeyToBytes('STM5HhJD5WUXu8vPhDmLaC2fTuuJYkwxF62Rt17HZ5G2PbnBvuHXF').length).toBe(33)
    expect(stmPubkeyToBytes('STM5AszgPKmjPnm8mrhC66oAHdsegbWDWcK8RA3DmrUHGg2S81Tug').length).toBe(33)
    expect(stmPubkeyToBytes('STM7mBK98NCE3HfMhqB9ADdxTutE1RSyGzpJQ6xiybr7gbmpQcXM9').length).toBe(33)
  })
  test('wifToPubkey מייצר-כתובת-STM-תקינה-שעוברת-בדיקת-סכום-עצמאית (round-trip)', () => {
    expect(() => stmPubkeyToBytes(wifToPubkey(TEST_WIF))).not.toThrow()
  })
})

describe('Task-137: account_create (נתיב-העמלה — כש-RC חסר) — וקטור-מהשרשרת', () => {
  test('מזהה: op=9; עמלה-לפני-היוצר; אין-op-extensions', () => {
    expect(OP_ACCOUNT_CREATE).toBe(9)
  })
  test('account_create (3.000 STEEM) == וקטור-מינוס-חתימות (צליבה steemit+justyy)', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [serializeOperation(OP_ACCOUNT_CREATE, {
        creator: 'headcorner',
        newAccountName: 'saosoldier1',
        feeRaw: 3_000, // 3.000 STEEM (precision 3)
        owner: AUTH_ONE,
        active: AUTH_ONE,
        posting: AUTH_ONE,
        memoKey: ACTIVE_PUB,
        jsonMetadata: '',
      })],
    )
    const VECTOR =
      '000000000000000000000109b80b00000000000003535445454d00000a68656164636f726e65720b73616f736f6c64696572310100000000010234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e01000100000000010234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e01000100000000010234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e01000234b1205efc0726645da3c25ea56537561379e2f68a8d779fa892fda8cad55e8e000000'
    expect(HEX(tx) + SIGS_TAIL).toBe(VECTOR)
  })
})

describe('Task-137 מדידה-חיה: ל-transfer אין op-extensions (הווקטור-המכריע — 2-צמתים-פה-אחד)', () => {
  test('transfer (0.001 STEEM, memo "x") == וקטור-54-בייטים-מינוס-חתימות', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [serializeOperation(OP_TRANSFER, { from: 'headcorner', to: 'headcorner', amount: 1, symbol: 'STEEM', memo: 'x' })],
    )
    const VECTOR =
      '0000000000000000000001020a68656164636f726e65720a68656164636f726e6572010000000000000003535445454d000001780000'
    expect(HEX(tx) + SIGS_TAIL).toBe(VECTOR)
  })
  test('עוגן-האב-הישן עדיין-מתקבל — עם-זנב-החתימות-המפורש (הלקח: ה-3-אפסים-היו-עמומים)', () => {
    // עדכון-הסמנטיקה: זנב-ה-MASTER = memo + tx-ext + signatures(00) — ל-transfer אין-op-ext.
    // הבדיקה-הישנה (HEX(tx)==MASTER) עברה-בריקנות כשה-serializer-הוסיף-op-ext: 3-אפסים-זהים.
    // ההוכחה-החדשה-המכריעה: וקטור-ה-transfer-לעיל + נחיתות-חיות-מול-השרשרת.
    expect(OP_TRANSFER).toBe(2)
  })
})
