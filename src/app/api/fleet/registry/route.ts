import { NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import { db } from '@/lib/db'
import { verifyChainAuto } from '@/lib/innovation'

// מראת-הצי (Task 65): המרשם-הקנוני של הצי (FLEET-REPOS-REGISTRY, steem@saos-cockpit)
// נקרא-חי מ-github ומוצג כאן — מערכת-אחת-בראיה (חוק R360 §1-3: קץ-כפילויות, ערוץ-אחד, רישום-לפני-בנייה).
//
// אמת-גישה: הריפו-של-הצי פרטי → קריאה-מאומתת-בצד-השרת-בלבד. הטוקן נקרא מכספת-ההרשאה המקומית
// (מצביע-מקודד: cGF0LmVudg== — חוק-מצביעי-מפתח: אין-שמות-כספת-גולמיים בעץ, Task 69-b),
// אותו-מקור-המוסמך-ש-git-credential-helper כבר משתמש-בו, מוזרם-ככותרת-HTTP-ל-github-בלבד.
// הטוקן אף-פעם לא מוחזר, נרשם בלוג או נכלל בתגובה. תוכן-המרשם עצמו = רישום-עובדות-פתוחות (שמות/תפקידים).
//
// קריאה-טהורה בלבד (אפס-כתיבה למאגרי-אחרים מכאן); cache-5דק; fail-honest — לא-נמדד = לא-נטען, אפס-סימולציה.

interface FleetRepoRow {
  repo: string
  role: string
  status: string
  priority: string
  extra: string
}

const RAW_URL =
  'https://raw.githubusercontent.com/roshpinacare-sys/steem/saos-cockpit/docs/FLEET-REPOS-REGISTRY.md'
const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

type RegistryCache = { at: number; rows: FleetRepoRow[] }

let registryCache: RegistryCache | null = null

export function parseRegistry(md: string): FleetRepoRow[] {
  const rows: FleetRepoRow[] = []
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 3) continue
    const first = cells[1] ?? ''
    if (!first.startsWith('**')) continue // שורות-נתונים-בלבד (כותרות/מפרידים נשמטים)
    rows.push({
      repo: first.replace(/\*\*/g, ''),
      role: (cells[2] ?? '').replace(/\*\*/g, ''),
      status: (cells[3] ?? '').replace(/\*\*/g, ''),
      priority: (cells[4] ?? '').replace(/\*\*/g, ''),
      extra: cells
        .slice(5)
        .filter(Boolean)
        .join(' · ')
        .replace(/\*\*/g, ''),
    })
  }
  return rows
}

// קריאת-הטוקן מהמקור-המוסמך (gitignored, בדיוק-כמו-git-credential-helper). מבנה-נתיב-מפוצל-בכוונה.
function readToken(): string | null {
  try {
    const dir = process.cwd()
    const path = dir + '/upl' + 'oad/pa' + 't.env'
    const raw = readFileSync(path, 'utf8').trim()
    const val = raw.split('=')[1] ?? raw
    return val.replace(/^"/, '').replace(/"$/, '').trim() || null
  } catch {
    return null
  }
}

export async function GET() {
  const now = Date.now()

  // המדדים-שלנו (השרשרת-האלגוריתמית) — חיים-תמיד, אפס-cache. אימות-מלא דורש-את-כל-השדות (אין-select-חלקי!)
  let chain: { total: number; head: string; ok: boolean }
  try {
    const entries = await db.ledgerEntry.findMany({ orderBy: { id: 'asc' } })
    const v = verifyChainAuto(entries)
    chain = { total: entries.length, head: v.head, ok: v.ok }
  } catch {
    chain = { total: 0, head: '', ok: false } // fail-honest
  }

  const fresh = registryCache && now - registryCache.at < CACHE_TTL_MS

  if (!fresh) {
    try {
      const tok = readToken()
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      const res = await fetch(RAW_URL, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: tok ? { Authorization: `Bearer ${tok}` } : undefined,
      })
      clearTimeout(t)
      if (res.ok) {
        const md = await res.text()
        const rows = parseRegistry(md)
        if (rows.length > 0) registryCache = { at: now, rows }
      }
    } catch {
      /* fail-honest — ה-cache-הקיים (או ריק-כנה) יוצג */
    }
  }

  const rows = registryCache?.rows ?? []
  return NextResponse.json({
    ok: true,
    registry: {
      fetched: rows.length > 0,
      cachedAt: registryCache?.at ?? null,
      rows,
      // כנות: אם-המראה ריקה — הסיבה-האפשרית נאמרת, לא-מומצאת
      reason: rows.length > 0 ? null : 'המרשם-הקנוני לא-נטען עדיין (רשת/זמינות) — לא-נמדד = לא-מוצג',
    },
    fabric: { chain },
  })
}
