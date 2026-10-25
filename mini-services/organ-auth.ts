// ─── סעיף 0: שער-סמכות-איברים (Task-121 audit fix: fingerprints saos-arb.halt-resume,
// saos-council.deliberate, vault-guardian.heal-census-drill, saos-grid:3070) ──────────
// חוק-הפלטפורמה (דפוס-הדקס, repos/saos-dex/src/lib/operator-auth.ts): כל-מוטציה-דורשת
// סוכן-מורשה. נקודת-ההנחה-השבורה: "loopback = אמון" — אמת-מדידה: שער-ה-Caddy מעביר
// קורא-חיצוני אל כל-פורט-לוקלהוסט (?XTransformPort=), כך-שה-bind איננו גבול.
// כשל-סגור: אין-טוקן-מוגדר → 503 (דפוס-הדקס). הטוקן ב-upload/organ-token (0600, gitignored).
// דירקטיבת-בעלים 25/10 §1: deny-by-default מופשט-למאמת-טהור (verifyOrganToken) —
// כל-מוטציה באיבר-עדין (כולל HSM-החתימה :3085) מחויבת-טוקן גם-מלולאה-מקומית.
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

// ── המאמת-הטהור (נבדק-בדיקות; אפס-I/O, אפס-שעון) ────────────────────────────
// מחזיר: 'ok' | 'deny' | 'unconfigured' — deny-כברירת-מחדל בכל-נתיב-אחר.
export type OrganVerdict = 'ok' | 'deny' | 'unconfigured'

export function verifyOrganToken(given: string, expected: string | null): OrganVerdict {
  if (expected === null || expected === '') return 'unconfigured' // אין-תצורה → fail-closed 503
  if (!given) return 'deny' // אין-כותרת → לא-אנונימיים
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b) ? 'ok' : 'deny'
}

function expectedToken(): string | null {
  const d = tokenDigest()
  if (!d) return null
  // מחזירים-את-הגלם-רק-בזיכרון-התהליך; המאמת-מושווה-מול-digest-זהה
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim() || null
  } catch {
    return null
  }
}

export function organAuth(req: Request): Response | null {
  const expected = expectedToken()
  const given = req.headers.get('x-saos-organ') || req.headers.get('x-saos-operator') || ''
  const v = verifyOrganToken(given, expected)
  if (v === 'ok') return null // מורשה
  if (v === 'unconfigured')
    return Response.json({ ok: false, error: 'organ-auth-unconfigured' }, { status: 503 })
  return Response.json({ ok: false, error: 'organ-auth-required' }, { status: 401 })
}

export function organTokenValue(): string {
  try {
    return readFileSync(TOKEN_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}
