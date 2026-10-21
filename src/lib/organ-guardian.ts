// organ-guardian — שומר-האיברים-בעץ-ה-3000-הנצחי (Task 106)
// ═══════════════════════════════════════════════════════════════════════════════
// לקח-חי-משותף-עם-דוקטרינת-הדקס (guardian-שלהם-בעץ-ה-3000-שלהם, מוכח-חי):
// תהליך-שרת-ה-:3000 של הפלטפורמה חי-ברציפות-ולא-נשחט, ותהליכים-מנותקים-
// ארוכי-חיים (זקיפה וכד') נחסמים-ליצירת-תהליכים (posix_spawn ENOENT נמדד-חי
// על 'bun', '/usr/local/bin/bun' ואף '/bin/sh' — שלוש-שכבות-ניסיון).
// לכן: ההחייאה-מתבצעת-מכאן — בני-העץ-הנצחי (child_process של node) יורשים-סשן-
// חי ושורדים (אותה-הוכחה-של-הדקס: "בני-תהליך-ה-DEX-החי נולדים-לסשן-הישן").
//
// סמכות-אחת-לכל-איבר: הזקיפה (:3051) נשארת-המודד-והמדווח-הכן; ההחייאה-בפועל —
// רק-כאן (אפס-תחרות-הזנקות: הגריד-הראשון-שמגיע-לפורט-מנצח, השני-נכשל-כן-EADDRINUSE).
// אפס-סודות; fail-honest-בכל-שכבה; כל-פעולה-מתועדת.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

interface GuardianMemory {
  timer?: ReturnType<typeof setInterval>
  events: Array<{ at: string; kind: string; msg: string }>
  lastProbes: Record<string, { up: boolean; at: string; lastAction: string }>
  spawns: Record<string, number>
}

const g = globalThis as unknown as { __organGuardian?: GuardianMemory }

function mem(): GuardianMemory {
  if (!g.__organGuardian) g.__organGuardian = { events: [], lastProbes: {}, spawns: {} }
  return g.__organGuardian
}

const ROOT = process.cwd()
const LOG_DIR = join(ROOT, 'mini-services', 'saos-arb', 'state')
const BUN = '/usr/local/bin/bun'

// האיברים-שהשומר-מחזיק: נתיב-בדיקה + תיקיית-הרצה
const ORGANS: Array<{ name: string; probe: string; cwd: string }> = [
  { name: 'grid', probe: 'http://127.0.0.1:3070/health', cwd: join(ROOT, 'mini-services', 'saos-grid') }, // Task 105
  { name: 'arb', probe: 'http://127.0.0.1:3071/health', cwd: join(ROOT, 'mini-services', 'saos-arb') }, // Task 106
  { name: 'dex', probe: 'http://127.0.0.1:3010/saos-dex/api/dex/state', cwd: join(ROOT, 'repos', 'saos-dex') }, // Task 106 — השוק-שלנו
  { name: 'council', probe: 'http://127.0.0.1:3072/health', cwd: join(ROOT, 'mini-services', 'saos-council') }, // Task 107 — מועצת-השולחן (AutoHedge+agency-agents מותאם)
]

function logEvent(kind: string, msg: string): void {
  const m = mem()
  m.events.unshift({ at: new Date().toISOString(), kind, msg })
  if (m.events.length > 40) m.events.length = 40
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(join(LOG_DIR, 'guardian.log'), JSON.stringify({ at: new Date().toISOString(), kind, msg }) + '\n')
  } catch {
    /* כנות — היומן-אינו-קריטי */
  }
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

async function checkOrgan(name: string, probeUrl: string, cwd: string): Promise<void> {
  const m = mem()
  const up = await probe(probeUrl)
  const prev = m.lastProbes[name]
  m.lastProbes[name] = { up, at: new Date().toISOString(), lastAction: prev?.lastAction ?? 'monitoring' }
  if (up) {
    if (prev && !prev.up) logEvent('revived', `${name} חזר-לחיים`)
    return
  }
  // הזנקה-כבן-של-העץ-הנצחי; backoff-פנימי-גס: לא-יותר-מ-פעם-ב-90ש'-לאיבר
  const lastSpawn = m.spawns[name] ?? 0
  if (Date.now() - lastSpawn < 90_000) return
  m.spawns[name] = Date.now()
  try {
    const child = spawn(BUN, ['run', 'dev'], { cwd, stdio: 'ignore', env: process.env })
    child.on('error', (e) => {
      m.lastProbes[name].lastAction = `spawn-error: ${e.message}`
      logEvent('spawn-error', `${name}: ${e.message}`)
    })
    m.lastProbes[name].lastAction = `respawned pid=${child.pid}`
    logEvent('respawn', `${name} לא-ענה — הוזנק-מהעץ-הנצחי (pid=${child.pid})`)
  } catch (e) {
    m.lastProbes[name].lastAction = `spawn-threw: ${e instanceof Error ? e.message : String(e)}`
    logEvent('spawn-threw', `${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function tick(): Promise<void> {
  await Promise.all(ORGANS.map((o) => checkOrgan(o.name, o.probe, o.cwd)))
}

/** נקודת-ההצתה — נקראת-מהנתיבים-החיים (הלב דופק על /api/health כל-5ש' — ההצתה-ודאית) */
export function ensureOrganGuardian(): void {
  const m = mem()
  if (m.timer) return
  m.timer = setInterval(() => void tick(), 60_000)
  void tick()
  logEvent('boot', 'שומר-האיברים הוצת-בעץ-ה-3000-הנצחי (grid/arb/dex/council)')
}

export function guardianStatus(): Record<string, unknown> {
  const m = mem()
  return {
    ok: true,
    service: 'organ-guardian',
    doctrine: 'ההחייאה-חיה-בעץ-ה-3000-הנצחי (לקח-משותף-עם-הדקס); הזקיפה-מודדת-ומדווחת-בלבד',
    organs: ORGANS.map((o) => ({ name: o.name, probe: o.probe, ...m.lastProbes[o.name] })),
    spawns: m.spawns,
    events: m.events,
  }
}
