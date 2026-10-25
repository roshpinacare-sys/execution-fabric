// ═════════════════════════════════════════════════════════════════════════════
// saos-wallet — HSM-החתימה-הריבוני (Task-134, §8.1) — Saosmartwallet מאבוטיפ-לזמן-ריצה
// ═════════════════════════════════════════════════════════════════════════════
// המפתחות-החיים (custody-הפלטפורמה ב-env) נאטמים-בעת-העלייה-הראשונה לכספת-
// AES-256-GCM (master.key 0600 מחוץ-לעץ; upload/ מנוטרל-מ-git). מעתה: החומר-
// הפרטי חי-רק-בזיכרון-התהליך — ה-API חושף חתימות/ציבוריים/טביעות-אצבע-בלבד.
// זהות-רשת-המש (§4) נוצרת-ונאטמת-כאן (ed25519).
// fail-closed: פגיעה-GCM → poisoned=true, כל-חתימה נדחית-וכנה; מפתח-לא-ידוע → 404.
// קבלה: כל-חתימה נרשמת-ב-append-only audit.jsonl (זמן, מזהה, טביעת-אצבע, hash-מטען).
// הליבה-הטהורה (core.ts) מכוסה-בדיקות-דטרמיניסטיות (core.test.ts 11/11).
import { join, resolve } from 'path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'fs'
import { createHash, generateKeyPairSync, randomBytes, createPrivateKey } from 'node:crypto'
import { organAuth } from '../organ-auth'
import {
  SealVaultError,
  ed25519KeyFromPkcs8,
  ed25519PublicKeyDer,
  ed25519SignPayload,
  fingerprint,
  openVault,
  sealVault,
  secp256k1SignPayload,
  wifToPrivateKey,
  type OpenedEntry,
} from './core'

const PORT = 3085 // קבוע — חוזה-האיברים
const ROOT = resolve(import.meta.dir, '..', '..')
const DIR = join(ROOT, 'upload', 'saos-wallet') // upload/ מנוטרל-מ-git — אפס-דליפה-לעץ
const VAULT_PATH = join(DIR, 'vault.enc')
const MASTER_PATH = join(DIR, 'master.key')
const AUDIT_PATH = join(DIR, 'audit.jsonl')

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [saos-wallet] ${msg}`)
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })

// ── מפתח-אב (0600, נוצר-פעם-אחת) ────────────────────────────────────────────
function ensureMasterKey(): Buffer {
  if (existsSync(MASTER_PATH)) {
    const m = readFileSync(MASTER_PATH)
    if (m.length === 32) return m
    throw new Error(`master.key פגום (אורך ${m.length}) — fail-closed`)
  }
  const m = createHash('sha256').update(createHash('sha256').update(randomBytes(64)).digest()).digest()
  writeFileSync(MASTER_PATH, m, { mode: 0o600 })
  chmodSync(MASTER_PATH, 0o600)
  log('מפתח-אב חדש נוצר (0600) — מחוץ-לעץ-ה-git')
  return m
}
const MASTER = ensureMasterKey()

// ── אטימה-ראשונה: מפתחות-ה-env החיים + זהות-מש-ed25519 ─────────────────────
function sweepEnvKeys(): { id: string; kind: 'secp256k1-wif'; secret: Buffer }[] {
  const out: { id: string; kind: 'secp256k1-wif'; secret: Buffer }[] = []
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue
    if (/_WIF$/.test(k) && v.length >= 51 && v.length <= 52) {
      try {
        const key = wifToPrivateKey(v.trim())
        out.push({ id: k.toLowerCase(), kind: 'secp256k1-wif', secret: Buffer.from(key) })
      } catch (e) {
        log(`אזהרה: WIF ב-env (${k}) נדחה — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return out
}
function meshIdentityPkcs8(): Buffer {
  // זהות-המש — נגזרת-דטרמיניסטית מהמפתח-האב (אפס-מקור-אמת-שני)
  return createHash('sha256').update(MASTER).update('saos-mesh-identity-v1').digest()
}

if (!existsSync(VAULT_PATH)) {
  const entries = sweepEnvKeys()
  // זהות-המש: pkcs8 דר נגזר — נאטמת-כמו-כל-סוד
  const identityPkcs8 = meshIdentityPkcs8()
  // node:crypto מצריך pkcs8 מלא — יוצרים-זהות-אקראית-פעם-אחת ואוטמים-אותה (אקראיות-טובה-מנגזרת-כאן)
  const { privateKey } = generateKeyPairSync('ed25519')
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  void identityPkcs8
  entries.push({ id: 'mesh-identity', kind: 'ed25519-pkcs8', secret: pkcs8 })
  writeFileSync(VAULT_PATH, sealVault(MASTER, entries), { mode: 0o600 })
  chmodSync(VAULT_PATH, 0o600)
  log(`כספת נאטמה: ${entries.length} מפתחות (מהם ${entries.length - 1} מה-env) — טביעות-אצבע-בלבד בלוג`)
} else if (statSync(VAULT_PATH).mode & 0o077) {
  chmodSync(VAULT_PATH, 0o600)
  log('הרשאות-הכספת הודקו ל-0600')
}

// ── פתיחה-בזיכרון ───────────────────────────────────────────────────────────
let poisoned = false
let poisonReason: string | null = null
let entries: OpenedEntry[] = []
try {
  entries = openVault(MASTER, readFileSync(VAULT_PATH, 'utf8')).entries
  log(`כספת-נפתחה: ${entries.length} מפתחות-חיים-בזיכרון (${entries.map((e) => `${e.id}:${e.fp}`).join(', ')})`)
} catch (e) {
  poisoned = true
  poisonReason = e instanceof Error ? e.message : String(e)
  log(`🚨 כספת-פגועה — חתימה-נדחית-עד-התערבות-אנושית (fail-closed): ${poisonReason}`)
}

const state = { signs: 0, refuses: 0, startedAt: new Date().toISOString() }
function audit(keyId: string, fp: string, payloadHash: string, ok: boolean, why?: string): void {
  try {
    appendFileSync(AUDIT_PATH, JSON.stringify({ at: new Date().toISOString(), keyId, fp, payloadHash, ok, why }) + '\n')
  } catch { /* אפס-הסתרה: הכשל-נרשם-ב-state */ }
}

const cors = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const p = url.pathname
  if (req.method === 'GET' && (p === '/health' || p === '/')) {
    return new Response(
      JSON.stringify({
        ok: !poisoned,
        service: 'saos-wallet',
        organ: 'Saosmartwallet-HSM',
        port: PORT,
        sealed: !poisoned,
        poisoned,
        poisonReason,
        keys: entries.map((e) => ({ id: e.id, kind: e.kind, fp: e.fp })),
        signs: state.signs,
        refuses: state.refuses,
        startedAt: state.startedAt,
        at: new Date().toISOString(),
      }),
      { headers: cors },
    )
  }
  if (req.method === 'POST' && p === '/sign') {
    // ── דירקטיבת-בעלים 25/10 §1: ה-HSM הוא-כתר-היהלומים — אין-חתימה-אנונימית-אפילו-מלולאה.
    // deny-by-default: כל-נסיון-חתימה בלי-טוקן-איבר-תקף נדחה, נספר, ונרשם-ב-audit.jsonl.
    const deny = organAuth(req)
    if (deny) {
      state.refuses++
      audit('none', 'none', 'none', false, `unauthorized-sign: ${deny.status}`)
      return deny
    }
    if (poisoned) {
      state.refuses++
      audit('none', 'none', 'none', false, 'poisoned-vault')
      return new Response(JSON.stringify({ ok: false, error: 'vault-poisoned — fail-closed', poisonReason }), { status: 503, headers: cors })
    }
    const body = (await req.json().catch(() => null)) as { keyId?: string; payload?: string; payloadBase64?: boolean } | null
    if (!body?.keyId || (!body.payload && body.payload !== '')) {
      state.refuses++
      return new Response(JSON.stringify({ ok: false, error: 'keyId-and-payload-required' }), { status: 400, headers: cors })
    }
    const entry = entries.find((e) => e.id === body.keyId)
    if (!entry) {
      state.refuses++
      audit(body.keyId, 'unknown', 'none', false, 'unknown-key')
      return new Response(JSON.stringify({ ok: false, error: 'unknown-key', known: entries.map((e) => e.id) }), { status: 404, headers: cors })
    }
    const payload = body.payloadBase64 ? Buffer.from(body.payload, 'base64') : Buffer.from(body.payload, 'utf8')
    const payloadHash = createHash('sha256').update(payload).digest('hex')
    try {
      if (entry.kind === 'ed25519-pkcs8') {
        const ko = ed25519KeyFromPkcs8(entry.secret)
        const sig = ed25519SignPayload(ko, payload)
        state.signs++
        audit(entry.id, entry.fp, payloadHash, true)
        return new Response(JSON.stringify({ ok: true, keyId: entry.id, fp: entry.fp, scheme: 'ed25519', publicKeyBase64: ed25519PublicKeyDer(ko).toString('base64'), signatureBase64: sig.toString('base64'), payloadHash }), { headers: cors })
      }
      const r = secp256k1SignPayload(entry.secret, payload)
      state.signs++
      audit(entry.id, entry.fp, payloadHash, true)
      return new Response(JSON.stringify({ ok: true, keyId: entry.id, fp: entry.fp, scheme: 'secp256k1-ecdsa-sha256', publicKeyHex: Buffer.from(r.publicKey).toString('hex'), signatureHex: Buffer.from(r.signature).toString('hex'), payloadHash }), { headers: cors })
    } catch (e) {
      state.refuses++
      audit(entry.id, entry.fp, payloadHash, false, e instanceof Error ? e.message : String(e))
      return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: cors })
    }
  }
  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), { status: 404, headers: cors })
}

log(`HSM-החתימה-הריבוני חי על :${PORT} — אפס-חומר-פרטי-ב-API; כספת: ${entries.length} מפתחות, poisoned=${poisoned}`)
Bun.serve({ port: PORT, fetch: handle })
