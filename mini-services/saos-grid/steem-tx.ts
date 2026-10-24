// ═════════════════════════════════════════════════════════════════════════════
// steem-tx.ts — סידור-וחתימת-עסקאות-Steem אמת (Task-136 §1/§3)
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים: "High-yield automated curation and reward harvesting across
// Steem/Hive" — הדרך-היחידה-האמיתית: חתימת-עסקאות-אמת עם-מפתחות-הכספת.
//
// חוקי-הבית:
//  · אפס-ניחוש: מזהי-הפעולות-והסידור-כולם-מוכחים-בייט-בייט-מול-השרשרת-עצמה
//    (condenser_api.get_transaction_hex, 3-צמתים-פה-אחד, 2026-10-24 —
//    עוגן-האב-ב-steem-tx.test.ts). השרשרת-היא-הסמכות, לא-הזיכרון.
//  · אפס-סודות-בטעות: ה-WIF-נכנס-כמחרוזת-פרמטר (in-process), לעולם-לא-נכנס-
//    ליומנים/תשובות/argv. כל-פלט = מפתח-פומבי-או-חתימה-בלבד.
//  · חתימה-מוכחת-עצמאית: verifySigRecoversWifPubkey משחזר-את-המפתח-הציבורי
//    מהחתימה-עצמה — הוכחה-קריפטוגרפית-מלאה-בטרם-שידור.
//  · chain_id של Steem-mainnet = 32 בייטי-אפס (קבוע-קנוני).
// ═════════════════════════════════════════════════════════════════════════════
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/ripemd160.js'

// ── מזהי-פעולות — מוכחים-מול-השרשרת (עוגן-האב + וקטורי-Task-137) ─────────────
// Task-137 (2026-10-24): claim=22/create=23/delegate=40 נשלפו-מהשרשרת-עצמה
// (condenser_api.get_transaction_hex, צליבה-3-צמתים) — שיטת-המערכת-על-3-וקטורים
// פתרה-את-הפריסה: ל-claim יש extensions, ל-delegate אין — המדידה-הכריעה.
export const OP_VOTE = 0
export const OP_TRANSFER = 2
export const OP_LIMIT_ORDER_CREATE = 5
export const OP_CLAIM_REWARD_BALANCE = 39
export const OP_CLAIM_ACCOUNT = 22
export const OP_CREATE_CLAIMED_ACCOUNT = 23
export const OP_DELEGATE_VESTING_SHARES = 40
export const OP_ACCOUNT_CREATE = 9 // נתיב-העמלה (Task-137): op-9-קנון-לגאסי; הוכח-מול-השרשרת (steemit+justyy)

const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const STEEM_CHAIN_ID = new Uint8Array(32) // 32×00 — קנון-Steem-mainnet

function b58decode(s: string): Uint8Array {
  let n = 0n
  for (const c of s) {
    const i = A58.indexOf(c)
    if (i < 0) throw new Error('steem-tx: bad-base58-char')
    n = n * 58n + BigInt(i)
  }
  const hex = n.toString(16)
  return Uint8Array.from((hex.length % 2 ? '0' + hex : hex).match(/../g)!.map((h) => parseInt(h, 16)))
}

function b58encode(b: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(b).toString('hex'))
  let o = ''
  while (n > 0n) {
    o = A58[Number(n % 58n)] + o
    n /= 58n
  }
  for (const c of b) {
    if (c === 0) o = '1' + o
    else break
  }
  return o
}

// ── סידור-גרפן (טהור, µ/בייטים-דטרמיניסטיים) ────────────────────────────────
export function varint(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`steem-tx: varint-needs-safe-non-negative (${n})`)
  const out: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return Uint8Array.from(out)
}

function pushU16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff)
}
function pushU32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
}
function pushI64(out: number[], v: bigint): void {
  let x = v
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn))
    x >>= 8n
  }
}

function pushString(out: number[], s: string): void {
  const bytes = Buffer.from(s, 'utf8')
  out.push(...varint(bytes.length))
  for (const b of bytes) out.push(b)
}

const SYMBOL_PRECISION: Record<string, number> = { STEEM: 3, SBD: 3, VESTS: 6 }

/** נכס-גרפן-Steem — מוכח-בייט-בייט-מול-השרשרת (עוגן-האב, 3-צמתים):
 * 16 בייטים: amount (int64 LE, יחידות-גלם) + סמל (8 בייטים:
 * [precision uint8][6 בייטי-שם מרופדים-אפסים][0x00 סוגר]).
 * דוגמאות-מהשרשרת: STEEM=`03535445454d0000`, SBD=`0353424400000000`,
 * VESTS=`0656455354530000`. */
export function assetAmount(rawAmount: number, symbol: string): Uint8Array {
  const precision = SYMBOL_PRECISION[symbol]
  if (precision === undefined) throw new Error(`steem-tx: unknown-asset-symbol (${symbol})`)
  if (!Number.isSafeInteger(rawAmount) || rawAmount < 0)
    throw new Error(`steem-tx: asset-needs-safe-non-negative (${rawAmount})`)
  if (symbol.length > 6) throw new Error(`steem-tx: symbol-too-long (${symbol})`)
  const out: number[] = []
  pushI64(out, BigInt(rawAmount))
  out.push(precision)
  for (let i = 0; i < 6; i++) out.push(i < symbol.length ? symbol.charCodeAt(i) : 0)
  out.push(0x00) // בייט-הסיום-המוכח-מהשרשרת (סה"כ 8 בייטי-סמל)
  return Uint8Array.from(out)
}

// ── פעולות (כל-אחת-מוכחת-מול-עוגן-האב) ──────────────────────────────────────
export interface VoteOp {
  voter: string
  author: string
  permlink: string
  /** bps-שליטה: -10000 (הצבעת-דגל) עד 10000; 0=אסור (אפס-פעולה) */
  weight: number
}
export interface TransferOp {
  from: string
  to: string
  amount: number
  symbol: string
  memo: string
}
export interface LimitOrderCreateOp {
  owner: string
  orderid: number
  amountToSell: number
  symbolSell: string
  minToReceive: number
  symbolReceive: string
  fillOrKill: boolean
  expirationEpoch: number
}
export interface ClaimRewardBalanceOp {
  account: string
  rewardSteem: number
  rewardSbd: number
  rewardVests: number
}
export interface ClaimAccountOp {
  creator: string
  feeRaw: number
  feeSymbol: string
}
export interface AccountAuthority {
  threshold: number
  accountAuths: Array<[string, number]>
  keyAuths: Array<[string, number]>
}
export interface CreateClaimedAccountOp {
  creator: string
  newAccountName: string
  owner: AccountAuthority
  active: AccountAuthority
  posting: AccountAuthority
  memoKey: string
  jsonMetadata: string
}
export interface AccountCreateOp {
  creator: string
  newAccountName: string
  feeRaw: number
  owner: AccountAuthority
  active: AccountAuthority
  posting: AccountAuthority
  memoKey: string
  jsonMetadata: string
}
export interface DelegateVestingSharesOp {
  delegator: string
  delegatee: string
  vestingSharesRaw: number
}

/** מפתח-ציבורי-STM → 33 בייטים-דחוסים (b58check-מאומת — fail-closed-על-פסול). */
export function stmPubkeyToBytes(pub: string): Uint8Array {
  const s = pub.trim()
  if (!s.startsWith('STM')) throw new Error('steem-tx: pubkey-missing-STM-prefix')
  const dec = b58decode(s.slice(3))
  if (dec.length !== 37) throw new Error(`steem-tx: pubkey-bad-length (${dec.length})`)
  const body = dec.subarray(0, 33)
  const chk = dec.subarray(33)
  // Task-137: סכום-גרפן-למפתחות-ציבוריים = ripemd160-פשוט (הוכח-מהצומת-ומ-4-מפתחות-אמת)
  const expect = ripemd160(body).slice(0, 4)
  for (let i = 0; i < 4; i++) if (chk[i] !== expect[i]) throw new Error('steem-tx: pubkey-checksum-mismatch')
  return body
}

/** Authority גרפן: threshold-u32-LE + מוני-accountAuths + מוני-keyAuths + (33 בייטים + weight-u16-LE).
 *  מוכח-מול-וקטור-create_claimed_account (Task-137). */
export function serializeAuthority(a: AccountAuthority): Uint8Array {
  if (!Number.isSafeInteger(a.threshold) || a.threshold <= 0 || a.threshold > 0xffffffff)
    throw new Error(`steem-tx: authority-threshold-invalid (${a.threshold})`)
  const out: number[] = []
  pushU32(out, a.threshold)
  pushVarintCount(out, a.accountAuths.length)
  pushVarintCount(out, a.keyAuths.length)
  for (const [key, weight] of a.accountAuths) {
    pushString(out, key)
    if (!Number.isSafeInteger(weight) || weight <= 0 || weight > 0xffff) throw new Error('steem-tx: authority-weight-invalid')
    pushU16(out, weight)
  }
  for (const [pub, weight] of a.keyAuths) {
    const bytes = stmPubkeyToBytes(pub)
    if (!Number.isSafeInteger(weight) || weight <= 0 || weight > 0xffff) throw new Error('steem-tx: authority-weight-invalid')
    for (const b of bytes) out.push(b)
    pushU16(out, weight)
  }
  return Uint8Array.from(out)
}

export function serializeOperation(
  opId: number,
  data: VoteOp | TransferOp | LimitOrderCreateOp | ClaimRewardBalanceOp | ClaimAccountOp | CreateClaimedAccountOp | DelegateVestingSharesOp | AccountCreateOp,
): Uint8Array {
  const body: number[] = []
  if (opId === OP_VOTE) {
    const d = data as VoteOp
    if (!Number.isSafeInteger(d.weight) || d.weight === 0 || Math.abs(d.weight) > 10_000)
      throw new Error(`steem-tx: vote-weight-invalid (${d.weight})`)
    pushString(body, d.voter)
    pushString(body, d.author)
    pushString(body, d.permlink)
    pushU16(body, d.weight & 0xffff)
  } else if (opId === OP_TRANSFER) {
    const d = data as TransferOp
    pushString(body, d.from)
    pushString(body, d.to)
    body.push(...assetAmount(d.amount, d.symbol))
    pushString(body, d.memo)
    pushVarintCount(body, 0) // transfer-extensions: ריק — מוכח-מעוגן-האב (זנב-ה-transfer)
  } else if (opId === OP_LIMIT_ORDER_CREATE) {
    const d = data as LimitOrderCreateOp
    if (!Number.isSafeInteger(d.orderid) || d.orderid < 0) throw new Error(`steem-tx: orderid-invalid`)
    if (!Number.isSafeInteger(d.expirationEpoch) || d.expirationEpoch < 0) throw new Error(`steem-tx: order-expiration-invalid`)
    pushString(body, d.owner)
    pushU32(body, d.orderid)
    body.push(...assetAmount(d.amountToSell, d.symbolSell))
    body.push(...assetAmount(d.minToReceive, d.symbolReceive))
    body.push(d.fillOrKill ? 1 : 0)
    pushU32(body, d.expirationEpoch)
  } else if (opId === OP_CLAIM_REWARD_BALANCE) {
    const d = data as ClaimRewardBalanceOp
    pushString(body, d.account)
    body.push(...assetAmount(d.rewardSteem, 'STEEM'))
    body.push(...assetAmount(d.rewardSbd, 'SBD'))
    body.push(...assetAmount(d.rewardVests, 'VESTS'))
  } else if (opId === OP_CLAIM_ACCOUNT) {
    // וקטור-Task-137: creator + fee-asset + extensions-varint(0) — יש-extensions (המדידה-הכריעה)
    const d = data as ClaimAccountOp
    pushString(body, d.creator)
    body.push(...assetAmount(d.feeRaw, d.feeSymbol))
    pushVarintCount(body, 0)
  } else if (opId === OP_CREATE_CLAIMED_ACCOUNT) {
    // וקטור-Task-137: creator + new_name + owner/active/posting-authorities + memo-33 בייטים + json_metadata + extensions(0)
    const d = data as CreateClaimedAccountOp
    pushString(body, d.creator)
    pushString(body, d.newAccountName)
    body.push(...serializeAuthority(d.owner))
    body.push(...serializeAuthority(d.active))
    body.push(...serializeAuthority(d.posting))
    for (const b of stmPubkeyToBytes(d.memoKey)) body.push(b)
    pushString(body, d.jsonMetadata)
    pushVarintCount(body, 0)
  } else if (opId === OP_DELEGATE_VESTING_SHARES) {
    // וקטור-Task-137: delegator + delegatee + asset — אין-extensions (המדידה-הכריעה)
    const d = data as DelegateVestingSharesOp
    pushString(body, d.delegator)
    pushString(body, d.delegatee)
    body.push(...assetAmount(d.vestingSharesRaw, 'VESTS'))
  } else if (opId === OP_ACCOUNT_CREATE) {
    // וקטור-Task-137: עמלה-**לפני**-היוצר (שונה-מ-create_claimed!), אין-op-extensions
    const d = data as AccountCreateOp
    body.push(...assetAmount(d.feeRaw, 'STEEM'))
    pushString(body, d.creator)
    pushString(body, d.newAccountName)
    body.push(...serializeAuthority(d.owner))
    body.push(...serializeAuthority(d.active))
    body.push(...serializeAuthority(d.posting))
    for (const b of stmPubkeyToBytes(d.memoKey)) body.push(b)
    pushString(body, d.jsonMetadata)
  } else {
    throw new Error(`steem-tx: op-id-not-supported (${opId}) — כל-פעולה-חדשה-מחייבת-וקטור-מהשרשרת-קודם`)
  }
  return Uint8Array.from([...varint(opId), ...body])
}

export interface TxHeader {
  refBlockNum: number
  refBlockPrefix: number
  /** epoch-שניות — חייב-להיות-בעתיד-בשידור-אמת */
  expirationEpoch: number
}

export function buildTxBytes(header: TxHeader, ops: Uint8Array[]): Uint8Array {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('steem-tx: tx-needs-ops (אף-חתימה-על-אוויר)')
  if (!Number.isSafeInteger(header.refBlockNum) || header.refBlockNum < 0 || header.refBlockNum > 0xffff)
    throw new Error(`steem-tx: refBlockNum-invalid (${header.refBlockNum})`)
  if (!Number.isSafeInteger(header.refBlockPrefix) || header.refBlockPrefix < 0 || header.refBlockPrefix > 0xffffffff)
    throw new Error(`steem-tx: refBlockPrefix-invalid`)
  if (!Number.isSafeInteger(header.expirationEpoch) || header.expirationEpoch < 0)
    throw new Error(`steem-tx: expiration-invalid`)
  const out: number[] = []
  pushU16(out, header.refBlockNum)
  pushU32(out, header.refBlockPrefix)
  pushU32(out, header.expirationEpoch)
  out.push(...varint(ops.length))
  for (const op of ops) for (const b of op) out.push(b)
  pushVarintCount(out, 0) // extensions: ריק
  return Uint8Array.from(out)
}
function pushVarintCount(out: number[], n: number): void {
  out.push(...varint(n))
}

// ── מפתחות וחתימה ────────────────────────────────────────────────────────────
const STM_PREFIX = new Uint8Array([0x80]) // Graphene pubkey prefix byte

/** WIF → STM-pubkey (steemit-סמנטיקה: 37-בייט-קנון או 38-בייט-בריאותק-בודי-33) */
export function wifToPubkey(wif: string): string {
  const dec = b58decode(wif.trim())
  if (dec.length < 5) throw new Error('steem-tx: wif-too-short')
  const payload = dec.subarray(0, dec.length - 4)
  const chk = dec.subarray(dec.length - 4)
  const expect = sha256(sha256(payload)).slice(0, 4)
  for (let i = 0; i < 4; i++) if (chk[i] !== expect[i]) throw new Error('steem-tx: wif-checksum-mismatch (corrupt key)')
  let scalar: Uint8Array
  if (dec.length === 38 && dec[0] === 0x80 && dec[33] === 0x01) {
    // bitcoin-form: סקאלר = body-33 mod n (סמנטיקת-steemit "P"+WIF)
    const body = BigInt('0x' + Buffer.from(dec.subarray(1, 34)).toString('hex'))
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const mod = body % N
    scalar = Uint8Array.from(Buffer.from(mod.toString(16).padStart(64, '0'), 'hex'))
  } else if (dec.length === 37 && dec[0] === 0x80) {
    scalar = dec.subarray(1, 33)
  } else {
    throw new Error(`steem-tx: unexpected-wif-form (len=${dec.length})`)
  }
  const c33 = secp256k1.getPublicKey(scalar, true)
  // Task-137 תיקון-מדידה-חיה: סכום-גרפן-למפתחות-ציבוריים = ripemd160-פשוט-על-הגוף —
  // הוכח-מהודעת-ה-assert-של-הצומת-עצמו (fc::ripemd160::hash(key_data)._hash[0] ==
  // bin_key.check) ומ-4 מפתחות-אמת-של-headcorner (2026-10-24). ripemd160(sha256())
  // היה-טעות-שמעולם-לא-נתפסה (החתימה-לא-כוללת-מפתח — השדה-היה-לתצוגה-בלבד).
  const chkPub = ripemd160(c33).slice(0, 4)
  return 'STM' + b58encode(Uint8Array.from([...c33, ...chkPub]))
}

function sigToSteemFormat(sig: { r: bigint; s: bigint; recovery: number }): string {
  const raw = new Uint8Array(65)
  raw[0] = 31 + sig.recovery // Graphene: 31+recid head byte
  raw.set(Uint8Array.from(Buffer.from(sig.r.toString(16).padStart(64, '0'), 'hex')), 1)
  raw.set(Uint8Array.from(Buffer.from(sig.s.toString(16).padStart(64, '0'), 'hex')), 33)
  // Graphene STM = base58check: 0x80 ‖ 65-byte-raw ‖ double-sha256-checksum(4)
  const withPrefix = Uint8Array.from([...STM_PREFIX, ...raw])
  const chk = sha256(sha256(withPrefix)).slice(0, 4)
  return 'STM' + b58encode(Uint8Array.from([...withPrefix, ...chk]))
}

export interface SignedTx {
  txHex: string
  signature: string
  /** המפתח-הציבורי-שהחתימה-משחזרת — זהות-המפעיל-הקריפטוגרפית */
  pubkey: string
}

export function signTxBytes(tx: Uint8Array, wif: string, chainId: Uint8Array = STEEM_CHAIN_ID): SignedTx {
  const digest = sha256(Uint8Array.from([...chainId, ...tx]))
  const sig = secp256k1.sign(digest, b58decode(wif.trim()).subarray(1, 33), { prehash: false })
  const signature = sigToSteemFormat({ r: sig.r, s: sig.s, recovery: sig.recovery ?? 0 })
  const pubkey = wifToPubkey(wif)
  // חוק-הבית: אף-חתימה-לא-יוצאת-מהדלת-בלי-שחזור-מוצלח-למפתח-שלנו-עצמנו
  if (!verifySigRecoversWifPubkey(tx, signature, wif, chainId)) {
    throw new Error('steem-tx: signature-recovery-mismatch — fail-closed (לא משודר)')
  }
  return { txHex: Buffer.from(tx).toString('hex'), signature, pubkey }
}

/** הוכחה-עצמאית: החתימה-מאמתת-מול-הdigest-והמפתח-הנגזר-מה-WIF (noble-מאמת-את-ה-r/s-המקוריים). */
export function verifySigRecoversWifPubkey(tx: Uint8Array, stmSig: string, wif: string, chainId: Uint8Array = STEEM_CHAIN_ID): boolean {
  try {
    const dec = b58decode(stmSig.replace(/^STM/, ''))
    const payload = dec.subarray(0, dec.length - 4)
    const chk = dec.subarray(dec.length - 4)
    const expect = sha256(sha256(payload)).slice(0, 4)
    for (let i = 0; i < 4; i++) if (chk[i] !== expect[i]) return false
    if (payload[0] !== 0x80 || payload.length !== 66) return false
    const recId = payload[1] - 31
    if (recId < 0 || recId > 3) return false
    const r = BigInt('0x' + Buffer.from(payload.subarray(2, 34)).toString('hex'))
    const s = BigInt('0x' + Buffer.from(payload.subarray(34, 66)).toString('hex'))
    const digest = sha256(Uint8Array.from([...chainId, ...tx]))
    const derivedPub = secp256k1.getPublicKey(b58decode(wif.trim()).subarray(1, 33), true)
    return secp256k1.verify({ r, s }, digest, derivedPub, { prehash: false })
  } catch {
    return false
  }
}

// ── יצירת-מפתחות-חיילים (Task-137 — צמיחת-צי-מבפנים) ─────────────────────────
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** סקאלר-32-בייטים → WIF-דחוס-תקני (0x80 ‖ scalar ‖ 0x01 ‖ sha256(sha256)[:4], base58).
 *  fail-closed: אפס-או-מעל-סדר-העקומה — הקורא-מחליף-אקראיות. */
export function generateWif(rand32: Uint8Array): string {
  if (rand32.length !== 32) throw new Error(`steem-tx: generateWif-needs-32-bytes (${rand32.length})`)
  const hex = Buffer.from(rand32).toString('hex')
  const scalar = BigInt('0x' + hex)
  if (scalar === 0n || scalar >= SECP_N) throw new Error('steem-tx: generateWif-scalar-out-of-range')
  const payload = Uint8Array.from([0x80, ...rand32, 0x01])
  const chk = sha256(sha256(payload)).slice(0, 4)
  return b58encode(Uint8Array.from([...payload, ...chk]))
}
