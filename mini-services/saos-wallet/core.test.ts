// ═════════════════════════════════════════════════════════════════════════════
// saos-wallet/core.test — סוויטה-דטרמיניסטית על ליבת-כספת-ה-HSM (Task-134, §8.1)
// ═════════════════════════════════════════════════════════════════════════════
// Saosmartwallet: מאבוטיפ-לזמן-ריצה. AES-256-GCM במנוחה, אפס-חומר-פרטי-בתשובות/
// לוגים (טביעות-אצבע-בלבד), fail-closed על כל-פגיעה/חוסר-מפתח.
// וקטורי-ה-WIF מהספרות-הפומביות (סטנדרטי) — אפס-חומר-אמיתי-בבדיקות.
import { describe, expect, test } from 'bun:test'
import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto'
import {
  SealVaultError,
  base58Decode,
  base58Encode,
  ed25519SignPayload,
  fingerprint,
  openVault,
  sealVault,
  secp256k1SignPayload,
  wifToPrivateKey,
} from './core'

const VEC_PRIV_HEX = '0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d'
const VEC_WIF = '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ' // WIF לא-דחוס של הוקטור לעיל

describe('base58 + WIF (פענוח-אמת)', () => {
  test('WIF-סטנדרטי מתפרק-למפתח-הנכון (וקטור פומבי)', () => {
    expect(Buffer.from(wifToPrivateKey(VEC_WIF)).toString('hex')).toBe(VEC_PRIV_HEX)
  })
  test('צ׳ק-סאם שבור → נדחה (fail-closed)', () => {
    const raw = base58Decode(VEC_WIF)
    const corruptedBytes = Uint8Array.from([...raw.subarray(0, raw.length - 1), raw[raw.length - 1]! ^ 0x01])
    const corrupted = base58Encode(corruptedBytes)
    expect(() => wifToPrivateKey(corrupted)).toThrow(/checksum|WIF/i)
  })
  test('base58 roundtrip דטרמיניסטי (כולל-leading-zeros)', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 255])
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes)
  })
})

describe('כספת AES-256-GCM (אטימה/פתיחה/פגיעה)', () => {
  test('אטימה→פתיחה roundtrip — החומר-הפרטי חוזר-שלם', () => {
    const master = createHash('sha256').update('test-master-secret').digest()
    const vault = sealVault(master, [{ id: 'steem-main', kind: 'secp256k1-wif', secret: Buffer.from(VEC_PRIV_HEX, 'hex') }])
    const opened = openVault(master, vault)
    expect(opened.entries[0]!.id).toBe('steem-main')
    expect(Buffer.from(opened.entries[0]!.secret).toString('hex')).toBe(VEC_PRIV_HEX)
  })
  test('פגיעה-בצופן → GCM-נכשל → SealVaultError (fail-closed, אפס-המצאה)', () => {
    const master = createHash('sha256').update('k2').digest()
    const vault = sealVault(master, [{ id: 'a', kind: 'secp256k1-wif', secret: Buffer.from('aa', 'hex') }])
    const obj = JSON.parse(vault) as { entries: [{ ct: string }] }
    obj.entries[0]!.ct = obj.entries[0]!.ct.slice(0, -4) + '0000'
    expect(() => openVault(master, JSON.stringify(obj))).toThrow(SealVaultError)
  })
  test('מפתח-אב שגוי → GCM-נכשל (לא-מפענח-שקט)', () => {
    const vault = sealVault(createHash('sha256').update('right').digest(), [{ id: 'a', kind: 'secp256k1-wif', secret: Buffer.from('aa', 'hex') }])
    expect(() => openVault(createHash('sha256').update('wrong').digest(), vault)).toThrow(SealVaultError)
  })
})

describe('חתימה — ed25519 ו-secp256k1 (אימות-פומבי)', () => {
  test('ed25519: חתימה מאומתת-מול-המפתח-הציבורי; מטען-שונה → חתימה-שונה', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const payload = Buffer.from('mesh-node-hello')
    const sig = ed25519SignPayload(privateKey, payload)
    expect(edVerify(null, payload, publicKey, sig)).toBe(true)
    expect(edVerify(null, Buffer.from('other'), publicKey, sig)).toBe(false)
  })
  test('ed25519: מפתח-פרטי-מ-PKCS8-שמור-בכספת נטען-וחותם-נכון', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
    const loaded = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    const sig = ed25519SignPayload(loaded, Buffer.from('sealed-identity'))
    expect(edVerify(null, Buffer.from('sealed-identity'), publicKey, sig)).toBe(true)
  })
  test('secp256k1: חתימת-ECDSA דטרמיניסטית (RFC6979) על sha256(payload) מאומתת-עצמית', () => {
    const priv = Buffer.from(VEC_PRIV_HEX, 'hex')
    const r = secp256k1SignPayload(priv, Buffer.from('sovereign-block'))
    expect(r.verify).toBe(true)
    expect(r.signature.length).toBe(64)
    const r2 = secp256k1SignPayload(priv, Buffer.from('sovereign-block'))
    expect(Buffer.from(r.signature).equals(Buffer.from(r2.signature))).toBe(true)
  })
})

describe('טביעות-אצבע + חוק-אפס-הדלפה', () => {
  test('fingerprint: 12-הקס-יציב, אינו-מכיל-שום-קידוד-של-הסוד', () => {
    const fp = fingerprint(Buffer.from(VEC_PRIV_HEX, 'hex'))
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    expect(VEC_PRIV_HEX.includes(fp)).toBe(false)
  })
  test('חוק-אפס-הדלפה: ייצוגי-JSON של הכספת ושל תוצאות-החתימה לא-מכילים-את-הסוד', () => {
    const master = createHash('sha256').update('leak-test').digest()
    const secretBuf = Buffer.from(VEC_PRIV_HEX, 'hex')
    const vaultJson = sealVault(master, [{ id: 'x', kind: 'secp256k1-wif', secret: secretBuf }])
    const priv = wifToPrivateKey(VEC_WIF)
    const signRes = secp256k1SignPayload(priv, Buffer.from('leak'))
    const surfaces = [vaultJson, JSON.stringify(signRes)]
    for (const s of surfaces) {
      expect(s.includes(VEC_PRIV_HEX)).toBe(false) // hex
      expect(s.includes(VEC_WIF)).toBe(false) // WIF
      expect(s.toLowerCase()).not.toContain(secretBuf.toString('base64').slice(0, 20).toLowerCase()) // base64-ראשי
    }
  })
})
