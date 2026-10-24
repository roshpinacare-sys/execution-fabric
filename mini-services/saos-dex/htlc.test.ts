// ═════════════════════════════════════════════════════════════════════════════
// htlc.test.ts — מאמת-ההחלפות-האטומיות (הנחיית-בעלים §3/§7.2) — TDD
// hashlock (sha256) + timelock + נתיב-סגירה-יחיד (claim XOR refund) — אפס-הוצאה-כפולה.
// כל-הבדיקות על bun:sqlite :memory: — ה-SQL-האמיתי, לא-תחליף.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  canClaim,
  canRefund,
  ensureHtlcSchema,
  getContract,
  insertContract,
  listContracts,
  nextHtlcId,
  sha256Hex,
  updateContractStatus,
  validSecretHash,
  type HtlcContract,
} from './htlc'

const SECRET = 'sovereign-preimage-αβγ-1357'
const HASH = sha256Hex(SECRET) // נגזר-מהקבוע-שלמעלה — המאמת-עצמו-נבדק-בנפרד

function freshDb(): Database {
  const db = new Database(':memory:')
  ensureHtlcSchema(db)
  return db
}

function contract(over: Partial<HtlcContract> = {}): HtlcContract {
  return {
    id: 'htlc-1',
    sender: 'operator',
    recipient: 'arb-peg',
    asset: 'WSTEEM',
    amountMu: 5_000,
    secretHash: HASH,
    timelockMs: 2_000_000_000_000, // רחוק-בעתיד
    createdAt: new Date(1_999_999_000_000).toISOString(),
    status: 'locked',
    commitmentSig: null,
    closedAt: null,
    secret: null,
    ...over,
  }
}

describe('sha256Hex / validSecretHash — יסודות-ההאש', () => {
  test('sha256 מדויק (וקטור-ידוע "abc")', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  test('דטרמיניזם: אותו-קלט → אותו-hash', () => {
    expect(sha256Hex(SECRET)).toBe(sha256Hex(SECRET))
  })
  test('תבנית-hashlock: 64-hex-קטן בלבד', () => {
    expect(validSecretHash(HASH)).toBe(true)
    expect(validSecretHash(HASH.toUpperCase())).toBe(false) // חייב-קטן-קנוני
    expect(validSecretHash(HASH.slice(1))).toBe(false)
    expect(validSecretHash('zz' + HASH.slice(2))).toBe(false)
    expect(validSecretHash('')).toBe(false)
  })
})

describe('canClaim — נתיב-הפדיון (hashlock לפני-timelock)', () => {
  test('preimage-נכון לפני-הפקיעה → ok', () => {
    const v = canClaim(contract(), SECRET, 1_999_999_500_000)
    expect(v.ok).toBe(true)
  })
  test('preimage-שגוי → hashlock-mismatch (אפילו-מילימטר-שונה)', () => {
    const v = canClaim(contract(), SECRET + 'x', 1_999_999_500_000)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('hashlock-mismatch')
    const v2 = canClaim(contract(), '', 1_999_999_500_000)
    expect(v2.ok).toBe(false)
  })
  test('אחרי-הפקיעה → timelock-expired-use-refund (גם-עם-preimage-נכון)', () => {
    const v = canClaim(contract(), SECRET, 2_000_000_000_000)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('timelock-expired-use-refund')
  })
  test('חוזה-סגור → contract-closed (אין-תביעה-שנייה)', () => {
    for (const status of ['claimed', 'refunded'] as const) {
      const v = canClaim(contract({ status }), SECRET, 1_999_999_500_000)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.reason).toBe('contract-closed')
    }
  })
})

describe('canRefund — נתיב-ההחזר (timelock בלבד)', () => {
  test('לפני-הפקיעה → timelock-not-expired (השולח לא יכול לחטוף-בחזרה מוקדם)', () => {
    const v = canRefund(contract(), 1_999_999_500_000)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('timelock-not-expired')
  })
  test('בדיוק-בפקיעה ואחריה → ok', () => {
    expect(canRefund(contract(), 2_000_000_000_000).ok).toBe(true)
    expect(canRefund(contract(), 2_000_000_001_000).ok).toBe(true)
  })
  test('חוזה-סגור → contract-closed', () => {
    const v = canRefund(contract({ status: 'claimed' }), 2_000_000_001_000)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('contract-closed')
  })
})

describe('שכבת-האחסון — bun:sqlite אמיתי על :memory:', () => {
  test('insert/get/list מקיימים-חוזה-מלא', () => {
    const db = freshDb()
    insertContract(db, contract())
    const got = getContract(db, 'htlc-1')
    expect(got).not.toBeNull()
    expect(got?.sender).toBe('operator')
    expect(got?.amountMu).toBe(5_000)
    expect(got?.status).toBe('locked')
    expect(got?.commitmentSig?.scheme).toBeUndefined() // null נשמר-null
    expect(listContracts(db).length).toBe(1)
    expect(listContracts(db, 'locked').length).toBe(1)
    expect(listContracts(db, 'claimed').length).toBe(0)
  })
  test('nextHtlcId מונוטוני: htlc-1 → htlc-2 → htlc-10 (לא htlc-2 פעמיים)', () => {
    const db = freshDb()
    expect(nextHtlcId(db)).toBe('htlc-1')
    insertContract(db, contract({ id: 'htlc-1' }))
    expect(nextHtlcId(db)).toBe('htlc-2')
    insertContract(db, contract({ id: 'htlc-9' }))
    expect(nextHtlcId(db)).toBe('htlc-10')
  })
  test('עדכון-סגירה: status+closedAt+secret נשמרים ומוחזרים', () => {
    const db = freshDb()
    insertContract(db, contract())
    updateContractStatus(db, 'htlc-1', 'claimed', '2026-10-24T19:00:00.000Z', SECRET)
    const got = getContract(db, 'htlc-1')!
    expect(got.status).toBe('claimed')
    expect(got.closedAt).toBe('2026-10-24T19:00:00.000Z')
    expect(got.secret).toBe(SECRET)
  })
})

describe('אינווריאנט-האטום: נתיב-סגירה-יחיד-לכל-חוזה (אפס-הוצאה-כפולה)', () => {
  test('claim→refund נחסם; refund→claim נחסם; claim→claim נחסם (חי-על-החנות)', () => {
    const db = freshDb()
    const now = 1_999_999_500_000
    // מסלול-א': claim ואז-refund
    insertContract(db, contract({ id: 'htlc-1' }))
    expect(canClaim(getContract(db, 'htlc-1')!, SECRET, now).ok).toBe(true)
    updateContractStatus(db, 'htlc-1', 'claimed', new Date(now).toISOString(), SECRET)
    expect(canRefund(getContract(db, 'htlc-1')!, 2_000_000_001_000).ok).toBe(false) // כבר-נתבע
    expect(canClaim(getContract(db, 'htlc-1')!, SECRET, now).ok).toBe(false) // אין-תביעה-כפולה
    // מסלול-ב': refund ואז-claim
    insertContract(db, contract({ id: 'htlc-2', timelockMs: now - 1 }))
    expect(canRefund(getContract(db, 'htlc-2')!, now).ok).toBe(true)
    updateContractStatus(db, 'htlc-2', 'refunded', new Date(now).toISOString(), null)
    expect(canClaim(getContract(db, 'htlc-2')!, SECRET, now).ok).toBe(false) // כבר-הוחזר
  })

  test('מסלול-חיים-מלא על-החנות: locked → claimed עם-גילוי-סוד לנמען', () => {
    const db = freshDb()
    const now = 1_999_999_500_000
    insertContract(db, contract({ id: 'htlc-7' }))
    const locked = getContract(db, 'htlc-7')!
    expect(locked.status).toBe('locked')
    // לפני-הפדיון הסוד-אינו-על-החוזה (נשמר-רק-ה-hashlock)
    expect(locked.secret).toBeNull()
    expect(canClaim(locked, SECRET, now).ok).toBe(true)
    updateContractStatus(db, 'htlc-7', 'claimed', new Date(now).toISOString(), SECRET)
    const claimed = getContract(db, 'htlc-7')!
    expect(claimed.status).toBe('claimed')
    expect(claimed.secret).toBe(SECRET) // הנמען-מקבל-את-הסוד — ההוכחה
    expect(sha256Hex(claimed.secret!)).toBe(claimed.secretHash)
  })
})
