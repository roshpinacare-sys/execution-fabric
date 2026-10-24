// ═════════════════════════════════════════════════════════════════════════════
// saos-wallet/core — ליבת-כספת-ה-HSM של Saosmartwallet (Task-134, §8.1, TDD)
// ═════════════════════════════════════════════════════════════════════════════
// מאבוטיפ-לזמן-ריצה: מפתחות-חיים ב-env (custody-הפלטפורמה) נאטמים ל-AES-256-GCM
// (master.key 0600 מחוץ-לעץ), נפתחים-רק-בזיכרון-התהליך, ומסופקים-לעולם-רק כ-
// חתימות+ציבוריים+טביעות-אצבע. fail-closed: פגיעה-GCM → אטמת-הכספת (poisoned),
// חתימה-נדחית-עד-התערבות. אפס-חומר-פרטי בתשובות/לוגים — מוכח-בדיקות.
// טהורה-לגמרי (אפס-פורט/קבצים) — index.ts הוא-האיבר-ה-HTTP.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'

// ── base58 + WIF ─────────────────────────────────────────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out || '1'
}
export function base58Decode(s: string): Uint8Array {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error(`base58: תו-לא-חוקי '${c}'`)
    n = n * 58n + BigInt(i)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n % 256n))
    n /= 256n
  }
  for (const c of s) {
    if (c !== '1') break
    bytes.unshift(0)
  }
  return Uint8Array.from(bytes)
}

function sha256d(b: Uint8Array): Buffer {
  return createHash('sha256').update(createHash('sha256').update(b).digest()).digest()
}

export function wifToPrivateKey(wif: string): Uint8Array {
  const raw = base58Decode(wif)
  if (raw.length < 5) throw new Error('WIF: קצר-מדי')
  const payload = raw.subarray(0, raw.length - 4)
  const checksum = raw.subarray(raw.length - 4)
  if (!Buffer.from(sha256d(payload).subarray(0, 4)).equals(Buffer.from(checksum)))
    throw new Error('WIF: checksum fail — fail-closed')
  const version = payload[0]
  if (version !== 0x80) throw new Error(`WIF: version בלתי-צפוי 0x${version?.toString(16)}`)
  let key = payload.subarray(1)
  if (key.length === 34 && key[33] === 0x01) key = key.subarray(0, 32) // דחוס-סימון
  if (key.length !== 32) throw new Error('WIF: אורך-מפתח-לא-תקין')
  return Uint8Array.from(key)
}

// ── טביעות-אצבע (פומבי-לגמרי) ───────────────────────────────────────────────
export function fingerprint(secret: Uint8Array): string {
  return createHash('sha256').update(secret).digest().subarray(0, 6).toString('hex')
}

// ── כספת AES-256-GCM ────────────────────────────────────────────────────────
export interface VaultEntrySpec {
  id: string
  kind: 'secp256k1-wif' | 'ed25519-pkcs8'
  secret: Buffer
}
export interface VaultEntry {
  id: string
  kind: 'secp256k1-wif' | 'ed25519-pkcs8'
  fp: string
  iv: string
  tag: string
  ct: string
}

export class SealVaultError extends Error {}

export function sealVault(masterKey: Buffer, entries: VaultEntrySpec[]): string {
  if (masterKey.length !== 32) throw new SealVaultError('master key חייב 32 בתים')
  const out = entries.map((e) => {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', masterKey, iv)
    const ct = Buffer.concat([c.update(e.secret), c.final()])
    return {
      id: e.id,
      kind: e.kind,
      fp: fingerprint(e.secret),
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    }
  })
  return JSON.stringify({ v: 1, cipher: 'aes-256-gcm', entries: out })
}

export interface OpenedEntry {
  id: string
  kind: 'secp256k1-wif' | 'ed25519-pkcs8'
  fp: string
  secret: Uint8Array
}
export function openVault(masterKey: Buffer, vaultJson: string): { entries: OpenedEntry[] } {
  let v: { v: number; entries: VaultEntry[] }
  try {
    v = JSON.parse(vaultJson) as { v: number; entries: VaultEntry[] }
  } catch {
    throw new SealVaultError('כספת: JSON פגום')
  }
  if (v.v !== 1 || !Array.isArray(v.entries)) throw new SealVaultError('כספת: מבנה-לא-מוכר')
  const entries = v.entries.map((e) => {
    try {
      const d = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(e.iv, 'base64'))
      d.setAuthTag(Buffer.from(e.tag, 'base64'))
      const pt = Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()])
      if (fingerprint(pt) !== e.fp) throw new SealVaultError('כספת: טביעת-אצבע לא תואמת')
      return { id: e.id, kind: e.kind, fp: e.fp, secret: Uint8Array.from(pt) }
    } catch (err) {
      if (err instanceof SealVaultError) throw err
      throw new SealVaultError('כספת: GCM אימות-נכשל — פגיעה/מפתח-אב שגוי (fail-closed)')
    }
  })
  return { entries }
}

// ── חתימה ───────────────────────────────────────────────────────────────────
export function ed25519SignPayload(privateKey: import('node:crypto').KeyObject, payload: Buffer): Buffer {
  return Buffer.from(edSign(null, payload, privateKey))
}
export function ed25519PublicKeyDer(privateKey: import('node:crypto').KeyObject): Buffer {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
}

// ECDSA-secp256k1 דטרמיניסטי (RFC6979-מובנה ב-noble) על sha256(payload) — עם
// אימות-עצמי-מחייב: חתימה-שאינה-מאומתת לעולם לא יוצאת-מה-HSM (fail-closed).
export function secp256k1SignPayload(priv: Uint8Array, payload: Buffer): { signature: Uint8Array; publicKey: Uint8Array; verify: boolean } {
  const msgHash = createHash('sha256').update(payload).digest()
  const sig = secp256k1.sign(msgHash, priv, { prehash: false })
  const pub = secp256k1.getPublicKey(priv, true)
  const ok = secp256k1.verify(sig.toBytes('compact'), msgHash, pub, { prehash: false })
  if (!ok) throw new Error('HSM: חתימה לא עברה אימות-עצמי — נדחית (fail-closed)')
  return { signature: sig.toBytes('compact'), publicKey: Uint8Array.from(pub), verify: true }
}

// טעינת-מפתח-ed25519 מ-PKCS8-דר (מהכספת)
export function ed25519KeyFromPkcs8(der: Uint8Array): import('node:crypto').KeyObject {
  return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
}
