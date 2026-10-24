// ═════════════════════════════════════════════════════════════════════════════
// hive-tx.ts — רכבת-הדבורה (Task-137 §2 — "Native HIVE/STEEM/SBD market routing")
// ═════════════════════════════════════════════════════════════════════════════
// דירקטיבת-הבעלים (22:24) §2/§3: פעילות-הצבעה/קיורציה על Steem/Hive דרך-חיבורי-
// WebSocket/RPC-ישירים בלי-תלות-צד-שלישי.
//
// חוקי-הבית (אותם-חוקים-כמו-steem-tx):
//  · chain_id של Hive-mainnet נמדד-חי-מהצומת-עצמו (database_api.get_version,
//    2026-10-24): beeab0de00…00 — לא-מהזיכרון.
//  · וקטור-ההצבעה-נשלף-מהשרשרת (condenser_api.get_transaction_hex על api.hive.blog):
//    op-0-זהה-לSteem, פריסה-זהה, זנב-tx-ext-בלבד (get_transaction_hex של-Hive לא-מסדר-
//    חתימות-ריקות — המדידה-הכריעה).
//  · נכסים: HIVE/HBD precision 3 (HIVE_BLOCKCHAIN_PRECISION=1000 מה-config-של-הצומת) —
//    פורמט-הנכס-זהה-בייט-בייט (16 בייטים), רק-שם-הסמל-שונה.
//  · שער-כספת: החתימה-על-Hive נעולה-כנות-עד-שמפתח-מהכספת-מתאים-לסמכות-החיה
//    (custody-gate — אף-חתימה-על-אוויר, אף-המצאה).
// ═════════════════════════════════════════════════════════════════════════════
import { RpcMesh } from './mesh'
import { buildTxBytes, serializeOperation, signTxBytes, wifToPubkey, type SignedTx, type VoteOp, OP_VOTE } from './steem-tx'
import { stmSigToHex } from './harvest-engine'

export const HIVE_CHAIN_ID_HEX = 'beeab0de00000000000000000000000000000000000000000000000000000000'

export function hiveChainIdBytes(): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i++) out[i] = parseInt(HIVE_CHAIN_ID_HEX.slice(i * 2, i * 2 + 2), 16)
  return out
}

export const HIVE_DEFAULT_ENDPOINTS = [
  { name: 'hive.blog', url: 'https://api.hive.blog' },
  { name: 'arcange', url: 'https://hive-api.arcange.eu' },
  { name: 'deathwing', url: 'https://api.deathwing.me' },
]

export function hiveMeshFromEnv(): RpcMesh {
  const env = (process.env.SAOS_HIVE_ENDPOINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const eps = env.length
    ? env.map((u, i) => ({ name: `hive-${i}`, url: u }))
    : HIVE_DEFAULT_ENDPOINTS
  return new RpcMesh(eps, { timeoutMs: 8_000, openAfterFails: 3, halfOpenAfterMs: 30_000 })
}

/** חתימת-עסקת-Hive: digest = sha256(chain_id_hive ‖ tx) — אותו-חוק-גרפן, מזהה-שרשרת-שונה. */
export function signHiveTxBytes(tx: Uint8Array, wif: string): SignedTx {
  return signTxBytes(tx, wif, hiveChainIdBytes())
}

export interface HiveCustody {
  ok: boolean
  pubkey: string | null
  error: string | null
  authorityPubkeys: string[] | null
}

/** שער-הכספת: המפתח-הנגזר-מהכספת-חייב-להופיע-בסמכות-ה-posting-החיה-של-החשבון-ב-Hive. */
export async function hiveCustodyCheck(
  mesh: RpcMesh,
  account: string,
  postingWif: string | null,
): Promise<HiveCustody> {
  if (!postingWif) return { ok: false, pubkey: null, error: 'custody-gated: אין-WIF-posting-בכספת', authorityPubkeys: null }
  let pubkey: string
  try {
    pubkey = wifToPubkey(postingWif)
  } catch (e) {
    return { ok: false, pubkey: null, error: `custody-gated: WIF-פסול (${e instanceof Error ? e.message : String(e)})`, authorityPubkeys: null }
  }
  const r = await mesh.call<Array<{ posting: { key_auths: Array<[string, number]> } }>>('condenser_api.get_accounts', [[account]])
  if (!r.ok || !r.data?.[0]) {
    return { ok: false, pubkey, error: `custody-unverifiable: ${r.error ?? 'no-data'} (fail-closed)`, authorityPubkeys: null }
  }
  const authorityPubkeys = (r.data[0].posting.key_auths ?? []).map((k) => k[0])
  if (!authorityPubkeys.includes(pubkey)) {
    return { ok: false, pubkey, error: 'custody-gated: המפתח-מהכספת-לא-נמצא-בסמכות-ה-posting-של-Hive (כנות — אף-חתימה)', authorityPubkeys }
  }
  return { ok: true, pubkey, error: null, authorityPubkeys }
}

export interface HiveVoteResult {
  ok: boolean
  blockNum?: number
  trxId?: string | null
  error?: string
}

/** הצבעת-קיורציה-אמת-על-Hive — אחרי-שער-הכספת בלבד. */
export async function hiveVote(
  mesh: RpcMesh,
  account: string,
  postingWif: string | null,
  op: VoteOp,
): Promise<HiveVoteResult> {
  const custody = await hiveCustodyCheck(mesh, account, postingWif)
  if (!custody.ok) return { ok: false, error: custody.error ?? 'custody-gated' }
  const dyn = await mesh.call<{ head_block_number: number; head_block_id: string }>('condenser_api.get_dynamic_global_properties', [])
  if (!dyn.ok || !dyn.data) return { ok: false, error: `dynamic-props: ${dyn.error ?? 'no-data'}` }
  const refBlockNum = dyn.data.head_block_number & 0xffff
  const raw = Buffer.from(dyn.data.head_block_id.slice(8, 16), 'hex')
  const refBlockPrefix = raw.length === 4 ? raw.readUInt32LE(0) : 0
  const header = { refBlockNum, refBlockPrefix, expirationEpoch: Math.floor(Date.now() / 1000) + 45 }
  const tx = buildTxBytes(header, [serializeOperation(OP_VOTE, op)])
  const signed = signHiveTxBytes(tx, postingWif!)
  const trx = {
    ref_block_num: refBlockNum,
    ref_block_prefix: refBlockPrefix,
    expiration: new Date(header.expirationEpoch * 1000).toISOString().replace(/\.\d+Z$/, '').replace(/Z$/, ''),
    operations: [['vote', { voter: op.voter, author: op.author, permlink: op.permlink, weight: op.weight }]],
    extensions: [],
    signatures: [stmSigToHex(signed.signature)], // appbase-מצפה-חתימת-hex-גלמית ([31+recid][r][s]) — מוכח-חי-בSteem, אותו-פורמט-בHive
  }
  const res = await mesh.call<{ id?: string; block_num?: number }>('network_broadcast_api.broadcast_transaction_synchronous', [trx])
  if (res.ok && res.data && typeof res.data.block_num === 'number' && res.data.block_num > 0) {
    return { ok: true, blockNum: res.data.block_num, trxId: res.data.id ?? null }
  }
  return { ok: false, error: res.error ?? 'synchronous-broadcast-ללא-הוכחת-בלוק (כנות)' }
}
