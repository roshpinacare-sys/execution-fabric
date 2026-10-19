import { NextResponse } from 'next/server'
import { complianceReport, policyGate, policyRecord } from '@/lib/githubPolicy'
import { githubToken } from '@/lib/github'

// Task 69 — דוח-הציות של הרשת (GET /api/sovereign/compliance)
// מה-חי כאן:
// 1. דוח-השער הפנימי (תקציב-עצמי/קצב-מוטציות/backoff/חוקים/יומן) — מטא-בלבד
// 2. מכסה-GitHub-חיה מ-/rate_limit — הקריאה-היחידה-של-GitHub-שלא-נספרת-כלל-במכסה
//    (מתועד-רשמית) ומוגבל-עצמית-ל-cache-5דק כדי-להיות-מנומסים-מעבר-לנדרש
// 3. מרשם-עוגנים-רב-מארחי: github=active (הריבון); חלופות=awaiting-credentials
//    (מדיניות: אף-יצירת-חשבון-אוטונומית — רק-קרדנציאלים-שהבעלים-מספק); local-chain=active

const RATE_LIMIT_CACHE_MS = 5 * 60 * 1000
let rlCache: { ts: number; val: Record<string, unknown> | null } = { ts: 0, val: null }

async function githubLiveQuota(): Promise<Record<string, unknown> | null> {
  if (rlCache.val && Date.now() - rlCache.ts < RATE_LIMIT_CACHE_MS) return rlCache.val
  if (!githubToken()) {
    rlCache = { ts: Date.now(), val: null }
    return null
  }
  try {
    await policyGate('GET')
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `Bearer ${githubToken()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
    })
    policyRecord('GET', res.status)
    if (!res.ok) {
      rlCache = { ts: Date.now(), val: { reachable: false, http: res.status } }
      return rlCache.val
    }
    const d = (await res.json()) as {
      resources?: { core?: { limit: number; used: number; remaining: number; reset: number } }
    }
    const core = d.resources?.core
    rlCache = {
      ts: Date.now(),
      val: core
        ? {
            reachable: true,
            limit: core.limit,
            used: core.used,
            remaining: core.remaining,
            resetAt: new Date(core.reset * 1000).toISOString(),
          }
        : { reachable: false, http: res.status },
    }
    return rlCache.val
  } catch (e) {
    // fail-honest: שער-חוסם/רשת — מדווח-ולא-ממציא
    rlCache = { ts: Date.now(), val: { reachable: false, reason: e instanceof Error ? e.message : String(e) } }
    return rlCache.val
  }
}

export async function GET() {
  const [quota] = await Promise.all([githubLiveQuota()])
  const anchors = [
    {
      id: 'github',
      role: 'ריבון-הכתיבה (העוגן-הקנוני)',
      status: 'active' as const,
      host: 'github.com/roshpinacare-sys/execution-fabric',
      note: 'תפעול-ממוזער תחת שער-הציות: אפס-יצירת-חשבונות, אפס-רעש, קומיטים-משמעותיים-בלבד',
    },
    {
      id: 'local-chain',
      role: 'שרשרת-האמת (עוגן-אלגוריתמי)',
      status: 'active' as const,
      host: 'db/custom.db + chain-witness :3050',
      note: 'עצמאי-מכל-מארח: אימות-prev/hash-מ-Genesis + עד-מימוש-נפרד; שורד-מחיקת-כל-מארח',
    },
    {
      id: 'sandbox-git',
      role: 'מטמון-ביצוע (לא-מקור-אמת)',
      status: 'active' as const,
      host: '.git מקומי — נשלף-מ-origin',
      note: 'לפי-חוק-אי-האמון: המקור = origin; הסנדבוקס מטמון-בלבד',
    },
    {
      id: 'codeberg',
      role: 'מראה-גיבוי (Forgejo ציבורי, ידידותי-ללא-מסחור)',
      status: 'awaiting-credentials' as const,
      host: 'codeberg.org',
      note: 'לא-לחבר עד: חשבון-שייווצר-על-ידי הבעלים באופן-אישי + טוקן-יוזרק-לכספת. אף-יצירת-חשבון-אוטונומית',
    },
    {
      id: 'gitlab',
      role: 'מראה-גיבוי (SaaS מלא, חינמי-לפרטי)',
      status: 'awaiting-credentials' as const,
      host: 'gitlab.com',
      note: 'כנ"ל: רק-בהוראת-בעלים ובקרדנציאלים-שהוא-מספק',
    },
    {
      id: 'gitea-selfhost',
      role: 'ריבון-פרטי-מלא (self-host)',
      status: 'awaiting-infrastructure' as const,
      host: 'דורש-שרת-חשוף-לרשת (הסנדבוקס מציג-פורט-יחיד)',
      note: 'המסלול-הריבוני-ביותר-בטווח-הארוך: אפס-תלות בגוף-מסחרי; לא-אפשרי-בסנדבוקס-הנוכחי',
    },
    {
      id: 'radicle',
      role: 'עוגן-P2P (ללא-שרת-מרכזי)',
      status: 'awaiting-infrastructure' as const,
      host: 'radicle.xyz',
      note: 'node-מקומי-כבד; מתאים-כעוגן-נגידות-שני-בעתיד, לא-חיוני-לריבונות-הנוכחית',
    },
  ]
  return NextResponse.json({
    ok: true,
    compliance: complianceReport(),
    githubQuota: quota,
    anchors,
    doctrine: {
      redLaws: [
        'איסור מוחלט על יצירת-חשבונות-אוטונומית בכל-מארח',
        'איסור על חשבונות-מרובים/עקיפת-חסימה (GitHub ToS — גורם-סגירה ישיר)',
        'איסור על קומיטים-ספאמיים/רעש-פעילות (דפוסי-דגלול מדודים)',
        'מראות-מארחים-חלופיים רק בקרדנציאלים-שהבעלים יוצר-ומספק בעצמו',
      ],
      growthPath: 'צמיחה = עומק בתוך-חשבון-אחד (repos/שרשרת/אינטליגנציה-רבת-ספקים: zai+NVIDIA+IPAI) + עוגנים-מקבילים-כשהבעלים מאשר — לא רוחב-חשבונות',
    },
  })
}
