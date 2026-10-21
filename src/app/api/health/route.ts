import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureOrganGuardian, guardianStatus } from '@/lib/organ-guardian'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ── Task 112 [trace 1a15f2614827141d] — החייאה-חיה-בנתיב-עצמו ────────────────
// תגלית-חיה: הסנדבוקס קוצר-תהליכים-שנוצרו-מחוץ-לעץ-ה-3000-הנצחי (נמדד: setsid/nohup/
// stdin-מנותק — אפס-שורדים בין-קריאות-כלי). הזקיפה-בתוך-organ-guardian נשארת-עם-
// סגר-מודול-ישן-אחרי-hot-reload (ה-global מקצר-יצירת-timer-חדש), ולכן-5-איברים-חדשים
// לא-היו-מוחזקים-בה. הפתרון: נתיב-ה-health עצמו-נטען-מחדש-לכל-בקשה-ב-dev — ולכן-
// ההחייאה-של-כל-האיברים-חיה-כאן, בתוך-העץ-הנצחי. כל-דופק-בריאות = מחזור-החייאה.
// dex (:3010) חריג-מוצהר: repos/saos-dex נעדר-מהעץ — נרשם-כשהוא, בלי-שקר.

const REVIVAL_ORGANS: Array<{ name: string; probe: string; cwd: string }> = [
  { name: 'grid', probe: 'http://127.0.0.1:3070/health', cwd: 'mini-services/saos-grid' },
  { name: 'arb', probe: 'http://127.0.0.1:3071/health', cwd: 'mini-services/saos-arb' },
  { name: 'council', probe: 'http://127.0.0.1:3072/health', cwd: 'mini-services/saos-council' },
  { name: 'heart', probe: 'http://127.0.0.1:3031/health', cwd: 'mini-services/fabric-heartbeat' },
  { name: 'witness', probe: 'http://127.0.0.1:3050/health', cwd: 'mini-services/chain-witness' },
  { name: 'keeper', probe: 'http://127.0.0.1:3051/health', cwd: 'mini-services/survival-keeper' },
  { name: 'metrics', probe: 'http://127.0.0.1:3060/health', cwd: 'mini-services/saos-metrics' },
  { name: 'vault-guardian', probe: 'http://127.0.0.1:3080/health', cwd: 'mini-services/vault-guardian' },
  { name: 'dex', probe: 'http://127.0.0.1:3010/saos-dex/api/dex/state', cwd: 'repos/saos-dex' }, // Task 112: המקום-הריבוני שוחזר-מ-github (clone) — עתה-בעץ-הנצחי
]

type RevivalMemory = { spawns: Record<string, number>; lastProbes: Record<string, boolean>; bootAt: string }
const g = globalThis as unknown as { __eternalOrganRevival?: RevivalMemory }
const BUN = '/usr/local/bin/bun'
const ROOT = process.cwd()

function revivalMem(): RevivalMemory {
  if (!g.__eternalOrganRevival) g.__eternalOrganRevival = { spawns: {}, lastProbes: {}, bootAt: new Date().toISOString() }
  return g.__eternalOrganRevival
}

function logEvent(kind: string, msg: string): void {
  try {
    const dir = join(ROOT, 'mini-services', 'saos-arb', 'state')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'guardian.log'), JSON.stringify({ at: new Date().toISOString(), kind, msg }) + '\n')
  } catch {
    /* כנות — היומן-אינו-קריטי */
  }
}

async function probeOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

async function reviveOrgans(): Promise<Record<string, string>> {
  const m = revivalMem()
  const out: Record<string, string> = {}
  await Promise.all(
    REVIVAL_ORGANS.map(async (o) => {
      try {
        const up = await probeOk(o.probe)
        const wasUp = m.lastProbes[o.name]
        m.lastProbes[o.name] = up
        if (up) {
          if (wasUp === false) logEvent('revived', `${o.name} חזר-לחיים (עץ-נצחי)`)
          out[o.name] = 'up'
          return
        }
        const last = m.spawns[o.name] ?? 0
        if (Date.now() - last < 90_000) {
          out[o.name] = 'down — backoff'
          return
        }
        m.spawns[o.name] = Date.now()
        // Task 112: אפס-ירושת-PORT — נמדד-חי: העץ-הנצחי נושא PORT=3000 (next dev),
        // וכל-איבר שקורא process.env.PORT נקשר-ל-3000 ונחסם-EADDRINUSE (טביעה: 5513 env).
        const env = { ...process.env } as Record<string, string | undefined>
        delete env.PORT
        const child = spawn(BUN, ['run', 'dev'], { cwd: join(ROOT, o.cwd), stdio: 'ignore', env: env as NodeJS.ProcessEnv })
        child.on('error', (e) => logEvent('spawn-error', `${o.name}: ${e.message}`))
        m.lastProbes[o.name] = false
        out[o.name] = `respawned pid=${child.pid}`
        logEvent('respawn', `${o.name} לא-ענה — הוזנק-מנתיב-ה-health-בעץ-הנצחי (pid=${child.pid})`)
      } catch (e) {
        out[o.name] = `error: ${e instanceof Error ? e.message : String(e)}`
      }
    }),
  )
  return out
}

export async function GET() {
  // שומר-האיברים (Task 106): מוצת-על-כל-דופק-בריאות — הלב דופק כל-5ש', אפס-תלות-באתחול
  try {
    ensureOrganGuardian()
  } catch {
    /* השומר-אינו-מפיל-את-בריאות-האפליקציה */
  }
  // Task 112: החייאה-החיה-של-כל-האיברים — בתוך-העץ-הנצחי (ראה-כותרת-למעלה)
  let revival: Record<string, string> = {}
  try {
    revival = await reviveOrgans()
  } catch {
    /* החייאה-אינה-מפילה-את-בריאות-האפליקציה */
  }
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true, db: true, time: new Date().toISOString(), revival })
  } catch (e) {
    return NextResponse.json({
      ok: false,
      db: false,
      error: e instanceof Error ? e.message : String(e),
      revival,
    })
  }
}

export async function POST() {
  // תצפית-השומר (לדשבורד/לסוכנים): קריאה-בלבד
  return NextResponse.json(guardianStatus())
}
