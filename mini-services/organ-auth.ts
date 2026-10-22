// ─── סעיף 0: שער-סמכות-איברים (Task-121 audit fix: fingerprints saos-arb.halt-resume,
// saos-council.deliberate, vault-guardian.heal-census-drill, saos-grid:3070) ──────────
// חוק-הפלטפורמה (דפוס-הדקס, repos/saos-dex/src/lib/operator-auth.ts): כל-מוטציה-דורשת
// סוכן-מורשה. נקודת-ההנחה-השבורה: "loopback = אמון" — אמת-מדידה: שער-ה-Caddy מעביר
// קורא-חיצוני אל כל-פורט-לוקלהוסט (?XTransformPort=), כך-שה-bind איננו גבול.
// כשל-סגור: אין-טוקן-מוגדר → 503 (דפוס-הדקס). הטוקן ב-upload/organ-token (0600, gitignored).
import { readFileSync } from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'

const TOKEN_PATH = '/home/z/my-project/upload/organ-token'
let cached: { digest: Buffer; at: number } | null = null

function tokenDigest(): Buffer | null {
  const now = Date.now()
  if (cached && now - cached.at < 30_000) return cached.digest
  try {
    const raw = readFileSync(TOKEN_PATH, 'utf8').trim()
    if (!raw) return null
    cached = { digest: createHash('sha256').update(raw).digest(), at: now }
    return cached.digest
  } catch {
    return null
  }
}

export function organAuth(req: Request): Response | null {
  const expected = tokenDigest()
  if (!expected) return Response.json({ ok: false, error: 'organ-auth-unconfigured' }, { status: 503 })
  const given = req.headers.get('x-saos-organ') || req.headers.get('x-saos-operator') || ''
  if (!given) return Response.json({ ok: false, error: 'organ-auth-required' }, { status: 401 })
  const actual = createHash('sha256').update(given).digest()
  if (!timingSafeEqual(actual, expected)) return Response.json({ ok: false, error: 'organ-auth-invalid' }, { status: 401 })
  return null // מורשה
}

export function organTokenValue(): string {
  try { return readFileSync(TOKEN_PATH, 'utf8').trim() } catch { return '' }
}
