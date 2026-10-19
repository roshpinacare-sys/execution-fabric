import { NextRequest, NextResponse } from 'next/server'
import { buildCensus, memoryDigest } from '@/lib/census'
import { complianceReport } from '@/lib/githubPolicy'
import { lastRestoreDrill } from '@/lib/restore-drill'
import { lastHistoryDrill } from '@/lib/history-drill'
import { lastDocsDrill } from '@/lib/docs-drill'
import { lastDocsHistoryDrill } from '@/lib/docs-history-drill'

// פקח-הריבונות (worklog Task 30) — נקודת-האינטליגנציה של הרשת.
// עקרונות (tobi/disktree): כל-מספר נגזר-מאומת בזמן-בקשה; הפקח מסמן-ולא-מוחק;
// סיווג-סוגים לפסיפס-האחזות; לא-נמדד = לא-נטען. אף-סוד לא עובר מכאן (נוכחות-שמות בלבד).
//
// GET /api/census           → הפקח המלא (שרשרת/משימות/שער/תקציב/גישה/לב/פסיפס/שווה-מבט/זיכרון)
// GET /api/census?view=memory → חומר-הזיכרון הנגזר בלבד (מה-נלמד/נוצר/נאסף/פתוח)
//
// Task 67 — עד-השרשרת (chain-witness :3050): דפוס-נלמד-מהתאום
// (SANDBOX-DISTRUST-LAW: "הבקרה-המתמדת-היא-הכלל"). הפקח מצליב-את-הראש-שהוא
// מדווח מול-עדות-המימוש-העצמאי. fail-honest: עד-דמם = up:false, אף-המצאה.
//
// Task 71 — הזקיפה (survival-keeper :3051): שכבת-ההישרדות-הרביעית.
// מעקב-חי אחרי אפליקציה/לב/עד + החייאה-עצמית של הלב-והעד + מראת-גיבוי-מקומית
// + תמונות-db. fail-honest: זקיפה-דממה = up:false, אף-המצאה.

async function probeSurvival(): Promise<Record<string, unknown> | { up: false; reason: string }> {
  try {
    const res = await fetch('http://127.0.0.1:3051/health', {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    })
    if (!res.ok) return { up: false, reason: `http-${res.status}` }
    const k = (await res.json()) as {
      startedAt?: string
      uptimeMs?: number
      watches?: Record<string, { up?: boolean; restarts?: number; lastResult?: string | null }>
      mirror?: {
        exists?: boolean
        synced?: boolean | null
        lastUpdateAt?: string | null
        lastResult?: string | null
        mirrorHead?: string | null
      }
      snapshots?: { count?: number; lastAt?: string | null; lastResult?: string | null }
    }
    const lite = (x?: { up?: boolean; restarts?: number; lastResult?: string | null }) =>
      x
        ? { up: !!x.up, restarts: x.restarts ?? 0, lastResult: x.lastResult ?? null }
        : { up: false, restarts: 0, lastResult: null }
    return {
      up: true,
      startedAt: k.startedAt,
      uptimeMs: k.uptimeMs,
      watches: {
        app: lite(k.watches?.app),
        heartbeat: lite(k.watches?.heartbeat),
        witness: lite(k.watches?.witness),
      },
      mirror: k.mirror
        ? {
            exists: !!k.mirror.exists,
            synced: k.mirror.synced ?? null,
            lastUpdateAt: k.mirror.lastUpdateAt ?? null,
            lastResult: k.mirror.lastResult ?? null,
            mirrorHead: k.mirror.mirrorHead ?? null,
          }
        : null,
      snapshots: k.snapshots
        ? { count: k.snapshots.count ?? 0, lastAt: k.snapshots.lastAt ?? null, lastResult: k.snapshots.lastResult ?? null }
        : null,
    }
  } catch (e) {
    return { up: false, reason: `unreachable: ${(e as Error).message}` }
  }
}

async function probeWitness(): Promise<{
  up: boolean
  ok?: boolean
  total?: number
  head?: string
  agrees?: boolean
  reason?: string
}> {
  try {
    const res = await fetch('http://127.0.0.1:3050/witness', {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    })
    if (!res.ok) return { up: false, reason: `http-${res.status}` }
    const w = (await res.json()) as { ok: boolean; total: number; head: string; reason?: string }
    return { up: true, ok: w.ok, total: w.total, head: w.head }
  } catch (e) {
    return { up: false, reason: `unreachable: ${(e as Error).message}` }
  }
}

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view')
  if (view === 'memory') {
    return NextResponse.json({ ok: true, memory: await memoryDigest() })
  }
  const census = await buildCensus()
  const witness = await probeWitness()
  if (witness.up && witness.head !== undefined) {
    witness.agrees = witness.head === census.chain.verify.head
  }
  // Task 69 — שער-הציות: מטא-מקומי בלבד (אפס-קריאות-רשת) ל-badge-המשמרת
  const gate = complianceReport()
  // Task 70 — עדות-השחזור האחרונה מהשרשרת (אפס-רשת) ל-badge-המשמרת
  const restoreDrill = await lastRestoreDrill()
  // מחזור-#13 (Task 80) — עדות-לשלושת-מקורות-השחזור (גיט / תמונה-שעתית / ייצוא-JSONL) ל-badge
  const [restoreDrillSnapshot, restoreDrillExport] = await Promise.all([
    lastRestoreDrill('snapshot'),
    lastRestoreDrill('export'),
  ])
  // מחזור-#14 (Task 81) — עדות-אטימות-ההיסטוריה (fail-honest: null = טרם-רץ)
  const historyDrill = await lastHistoryDrill()
  // מחזור-#15 (Task 82) — עדות-אטימות-המסמכים (fail-honest: null = טרם-רץ)
  const docsDrill = await lastDocsDrill()
  // מחזור-#16 (Task 83) — עדות-אטימות-היסטוריית-המסמכים (fail-honest: null = טרם-רץ)
  const docsHistoryDrill = await lastDocsHistoryDrill()
  // Task 71 — הזקיפה: מעקב-הישרדות + מראת-גיבוי + תמונות-db (רשת-לוקאלית-בלבד)
  const survival = await probeSurvival()
  return NextResponse.json({
    ok: true,
    census,
    witness,
    githubGate: {
      used: gate.budget.used,
      cap: gate.budget.cap,
      backoffActive: gate.pacing.backoffActive,
    },
    restoreDrill,
    restoreDrillSources: {
      git: restoreDrill,
      snapshot: restoreDrillSnapshot,
      export: restoreDrillExport,
    },
    historyDrill,
    docsDrill,
    docsHistoryDrill,
    survival,
  })
}
