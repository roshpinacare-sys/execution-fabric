// ===== תיקון-נצחי: secp256k1 — טביעה-pure-JS-בלבד =====
// שורש-בדם (Task-113 + Task-114): ה-binding-ה-native (secp256k1.node) ממית-את-התהליך
// תחת Bun ("symbol lookup error" — קריסה-שאינה-ניתנת-לתפיסה) בטעינה-עצמה,
// לפני-שה-try/catch-של-החבילה-מספיק-ליפול-ל-pure-JS. לכן-התיקון-חייב-לרוץ
// **לפני-כל-טעינה-אחרת** — ולכן-המודול-הזה-הוא-הייבוא-הראשון-ב-index.ts.
//
// חוק-עץ-נצחי: כל-תיקון-חי-בגיט-ומיישם-את-עצמו-מחדש-בכל-אתחול —
// אסור-שתיקון-יגור-רק-ב-node_modules (הוחלף-בכל-התקנה-מחדש — נמדד-בדם 22:26Z).
//
// החוזה: אותו-API-מלא-של-secp256k1@3.x (sign/verify/recover/publicKey*/privateKey*/
// signature*/ecdh) — אבל-ישר-מ-./elliptic (pure-JS) בלי-לגעת-ב-bindings.

const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')

const MARKER = 'saos-grid-pure-shim-v2'
const SHIM_BODY = [
  "'use strict'",
  `// ${MARKER} — pure-JS only; native binding hard-kills Bun (symbol lookup error)`,
  'module.exports = require(\'./elliptic\')',
  '',
].join('\n')

function ensureDeps(dir) {
  // אם-העץ-נמחק (אתחול-מכונה) — התקנה-עצמית מהגיט (חוק-הקמה-מחדש-עצמית)
  const secpIndex = path.join(dir, 'node_modules', 'secp256k1', 'index.js')
  if (fs.existsSync(secpIndex)) return
  try {
    console.log('[secp-shim] node_modules נעדר — התקנה-עצמית (bun install)…')
    execSync('bun install', { cwd: dir, stdio: 'ignore', timeout: 120_000 })
    console.log('[secp-shim] התקנה-עצמית הושלמה ✓')
  } catch (e) {
    console.log(`[secp-shim] התקנה-עצמית-נכשלה: ${e.message} — ממשיך (הזקיפה-תזנק-שוב)`)
  }
}

function installShim(dir) {
  const secpDir = path.join(dir, 'node_modules', 'secp256k1')
  const target = path.join(secpDir, 'index.js')
  if (!fs.existsSync(target)) {
    console.log('[secp-shim] secp256k1 כלל-לא-מותקן — דילוג (אין-מה-לתקן)')
    return { installed: false, tested: false }
  }
  const cur = fs.readFileSync(target, 'utf-8')
  if (!cur.includes(MARKER)) {
    fs.writeFileSync(target, SHIM_BODY, 'utf-8')
    console.log(`[secp-shim] ${MARKER} הותקן על node_modules/secp256k1/index.js (native מנוטרל)`)
  }
  return { installed: true, tested: false }
}

function selfTest() {
  // מבחן-חתימה-חי: sign(עם-extraEntropy=options.data — החוזה-של-dhive) → recover → השוואה
  const secp = require('secp256k1')
  const { createHash } = require('node:crypto')
  const priv = createHash('sha256').update(`saos-grid-selftest-${Date.now()}`).digest()
  const msg = createHash('sha256').update('saos-grid signing law: alive or honest-dead').digest()
  const { signature, recovery } = secp.sign(msg, priv, { data: Buffer.alloc(32, 7) })
  const pub = secp.publicKeyCreate(priv, true)
  const recovered = secp.recover(msg, signature, recovery, true)
  const ok = Buffer.compare(pub, recovered) === 0 && secp.verify(msg, signature, pub)
  if (!ok) throw new Error('selftest failed: roundtrip mismatch')
  return ok
}

// ── ריצה-מיידית (תופעת-לוואי-של-הייבוא-הראשון) ─────────────────────────────
const HERE = __dirname
const DIR = path.join(HERE, '..')
try {
  ensureDeps(DIR)
  const r = installShim(DIR)
  if (r.installed) {
    const ok = selfTest()
    r.tested = ok
    console.log(`[secp-shim] מבחן-חתימה-חי: sign→recover ✓ (${MARKER}) — המנוע-כשיר-לשידור`)
  }
  module.exports = r
} catch (e) {
  // כנות-מלאה: כשל-חתימה-מדווח-בשמו — לעולם-לא-שתיקה; הזקיפה-תראה-קריסות-חוזרות
  console.log(`[secp-shim] כשל: ${e instanceof Error ? e.message : String(e)}`)
  module.exports = { installed: false, tested: false, error: String(e?.message ?? e) }
}
