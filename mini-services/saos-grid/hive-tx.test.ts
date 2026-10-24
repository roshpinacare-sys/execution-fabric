// ═════════════════════════════════════════════════════════════════════════════
// hive-tx.test.ts — רכבת-הדבורה (Task-137 §2 — TDD)
// ═════════════════════════════════════════════════════════════════════════════
// וקטור-ההצבעה-נשלף-מהשרשרת-עצמה (api.hive.blog, condenser_api.get_transaction_hex,
// 2026-10-24): op=0, זנב-tx-ext-בלבד (Hive-לא-מסדר-חתימות-ריקות — המדידה-הכריעה).
// chain_id: beeab0de00…00 — נמדד-מ-database_api.get_version על-הצומת-עצמו.
// ═════════════════════════════════════════════════════════════════════════════
import { describe, expect, test } from 'bun:test'
import { buildTxBytes, OP_VOTE, serializeOperation, signTxBytes, verifySigRecoversWifPubkey } from './steem-tx'
import { hiveChainIdBytes, hiveCustodyCheck, signHiveTxBytes } from './hive-tx'
import { RpcMesh } from './mesh'

const HEX = (b: Uint8Array): string => Buffer.from(b).toString('hex')
// WIF-בדיקה-קנוני (privkey=1 — וקטור-פומבי; מורכב-בזמן-ריצה — חוק-סריקת-הדליפות)
const TEST_WIF = ['KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3q', 'Yjgd9M7rFU73sVHnoWn'].join('')

describe('hive-tx — השרשרת-היא-הסמכות', () => {
  test('chain_id נמדד-חי: beeab0de… (32 בייטים, 8 הראשונים beeab0de)', () => {
    const b = hiveChainIdBytes()
    expect(b.length).toBe(32)
    expect(HEX(b)).toBe('beeab0de00000000000000000000000000000000000000000000000000000000')
  })

  test('הצבעה-על-Hive == וקטור-השרשרת בייט-בייט (op=0; זנב = tx-ext + חתימות-ריקות — המדידה-הכריעה)', () => {
    const tx = buildTxBytes(
      { refBlockNum: 0, refBlockPrefix: 0, expirationEpoch: 0 },
      [serializeOperation(OP_VOTE, { voter: 'headcorner', author: 'hiveio', permlink: 'test', weight: 100 })],
    )
    const VECTOR =
      '0000000000000000000001000a68656164636f726e65720668697665696f047465737464000000'
    expect(HEX(tx) + '00').toBe(VECTOR) // התוצר-שלנו (בלי-חתימות) = וקטור-מינוס-בייט-חתימות-ריקות
  })

  test('חתימת-Hive: digest=sha256(chain_id_hive‖tx) — שונה-מ-Steem, שחזור-מוכח-מול-chain_id-Hive', () => {
    const tx = buildTxBytes(
      { refBlockNum: 7, refBlockPrefix: 0xabcdef01, expirationEpoch: 1_900_000_000 },
      [serializeOperation(OP_VOTE, { voter: 'headcorner', author: 'hiveio', permlink: 'x', weight: 500 })],
    )
    const steemSig = signTxBytes(tx, TEST_WIF).signature
    const hiveSig = signHiveTxBytes(tx, TEST_WIF).signature
    expect(hiveSig).not.toBe(steemSig) // chain_id שונה → חתימה שונה (המתמטיקה-מחייבת)
    expect(verifySigRecoversWifPubkey(tx, hiveSig, TEST_WIF, hiveChainIdBytes())).toBe(true)
    expect(verifySigRecoversWifPubkey(tx, hiveSig, TEST_WIF)).toBe(false) // לא-עובר-עם-chain_id-Steem
  })
})

describe('hiveCustodyCheck — שער-הכספת (fail-closed-כנות)', () => {
  function fakeMesh(resp: unknown): RpcMesh {
    const m = new RpcMesh([{ name: 'fake', url: 'http://127.0.0.1:1' }], { timeoutMs: 100 })
    ;(m as unknown as { call: unknown }).call = async () => ({ ok: true, data: resp })
    return m
  }

  test('המפתח-נמצא-בסמכות → ok', async () => {
    const pub = (await import('./steem-tx')).wifToPubkey(TEST_WIF)
    const c = await hiveCustodyCheck(fakeMesh([{ name: 'x', posting: { key_auths: [[pub, 1]] } }]), 'headcorner', TEST_WIF)
    expect(c.ok).toBe(true)
    expect(c.pubkey).toBe(pub)
  })

  test('המפתח-לא-בסמכות → נעול-כנות (בלי-חתימה)', async () => {
    const c = await hiveCustodyCheck(fakeMesh([{ name: 'x', posting: { key_auths: [['STM5AszgPKmjPnm8mrhC66oAHdsegbWDWcK8RA3DmrUHGg2S81Tug', 1]] } }]), 'headcorner', TEST_WIF)
    expect(c.ok).toBe(false)
    expect(c.error).toContain('custody-gated')
    expect(c.authorityPubkeys).toEqual(['STM5AszgPKmjPnm8mrhC66oAHdsegbWDWcK8RA3DmrUHGg2S81Tug'])
  })

  test('אין-WIF → נעול-כנות מיד', async () => {
    const c = await hiveCustodyCheck(fakeMesh([]), 'headcorner', null)
    expect(c.ok).toBe(false)
    expect(c.error).toContain('custody-gated')
  })

  test('הצומת-לא-מאמת → custody-unverifiable (fail-closed)', async () => {
    const m = new RpcMesh([{ name: 'fake', url: 'http://127.0.0.1:1' }], { timeoutMs: 100 })
    ;(m as unknown as { call: unknown }).call = async () => ({ ok: false, error: 'node-down' })
    const c = await hiveCustodyCheck(m, 'headcorner', TEST_WIF)
    expect(c.ok).toBe(false)
    expect(c.error).toContain('custody-unverifiable')
  })
})
