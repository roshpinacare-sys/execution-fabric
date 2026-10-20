import { NextResponse } from 'next/server'
import { buildCensus } from '@/lib/census'
import { dbReady } from '@/lib/restore-drill'

// מרכז-הפיקוח-המרכזי (מחזור-חדשנות #18 — מימוש-הצעה-אוטונומית שנולדה-מהרשת-עצמה:
// sovereign/site/2026-10-19T18-58-08-improvement.md "מרכז פיקוח מרכזי לרשת").
//
// נקודת-הקצה מאגדת-בקריאה-אחת את-כל-מדדי-הרשת-החיים:
//  · השרשרת-אמת — total/verified/ok/כשלים/ראש/גיל-הראש (מה-census-הקנוני, אימות-מלא)
//  · לוח-המשימות — active/completed/failed
//  · ההצעות — pending/approved/rejected (handoff-הרשת)
//  · הזיכרון — rss/heap של-תהליך-האפליקציה + מספר-הלולאות-הפתוחות (RUNNING)
//  · האיברים — app/heart/witness/sentry, כל-אחד-נבדק-חי-עם-timeout-קצר
//
// כנות-fail-closed: איבר-שכבה = up:false + השגיאה-בשמה; networkStatus 'degraded' אם
// שרשרת-לא-מאומתת או איבר-חסר. אפס-המצאת-מספרים — כל-שדה נגזר-ממקור-חי.
export const dynamic = 'force-dynamic'

async function probeOrgan(
  name: string,
  url: string,
  timeoutMs = 2500
): Promise<{ up: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    if (!res.ok) return { up: false, error: `http-${res.status}` }
    const data = (await res.json()) as Record<string, unknown>
    return { up: data.ok === true, data }
  } catch (e) {
    return { up: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET() {
  await dbReady()
  const census = await buildCensus()

  const [heart, witness, sentry] = await Promise.all([
    probeOrgan('heart', 'http://127.0.0.1:3031/health'),
    probeOrgan('witness', 'http://127.0.0.1:3050/health'),
    probeOrgan('sentry', 'http://127.0.0.1:3051/health'),
  ])

  const chain = census.chain
  const tasksByStatus = census.tasks?.byStatus ?? {}
  const handoffByStatus = census.handoff?.byStatus ?? {}

  const mem = process.memoryUsage()
  const chainOk = chain?.verify?.ok === true
  const organsUp = { app: true, heart: heart.up, witness: witness.up, sentry: sentry.up }
  const networkStatus = chainOk && Object.values(organsUp).every(Boolean) ? 'active' : 'degraded'

  return NextResponse.json({
    ok: true,
    networkStatus,
    generatedAt: new Date().toISOString(),
    chain: {
      total: chain?.total ?? 0,
      verified: chain?.verify?.verified ?? 0,
      ok: chainOk,
      brokenAt: chain?.verify?.brokenAt ?? null,
      head: chain?.head ?? null,
      headAgeMs: chain?.headAgeMs ?? null,
      failures: chain?.failed ?? 0,
    },
    tasks: {
      active: (tasksByStatus['RUNNING'] ?? 0) + (tasksByStatus['QUEUED'] ?? 0),
      completed: tasksByStatus['DONE'] ?? 0,
      failed: tasksByStatus['FAILED'] ?? 0,
    },
    proposals: {
      pending: handoffByStatus['PROPOSED'] ?? 0,
      approved: handoffByStatus['APPROVED'] ?? 0,
      rejected: handoffByStatus['WITHDRAWN'] ?? 0,
      running: handoffByStatus['RUNNING'] ?? 0,
      done: handoffByStatus['DONE'] ?? 0,
    },
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      openLoops: (handoffByStatus['RUNNING'] ?? 0) + (tasksByStatus['RUNNING'] ?? 0),
    },
    organs: {
      app: { up: true, db: true },
      heart: {
        up: heart.up,
        error: heart.error ?? null,
        ticks: heart.data?.['ticks'] ?? null,
        gitPulses: heart.data?.['gitPulses'] ?? null,
        lastTickError: heart.data?.['lastTickError'] ?? null,
      },
      witness: {
        up: witness.up,
        error: witness.error ?? null,
        total: (witness.data?.['last'] as { total?: number } | undefined)?.total ?? null,
        verifyOk: witness.data?.['ok'] === true && (witness.data?.['last'] as { ok?: boolean } | undefined)?.ok === true,
      },
      sentry: {
        up: sentry.up,
        error: sentry.error ?? null,
        uptimeMs: sentry.data?.['uptimeMs'] ?? null,
        mirrorSynced: (sentry.data?.['mirror'] as { synced?: boolean } | undefined)?.synced ?? null,
        snapshots: (sentry.data?.['snapshots'] as { count?: number } | undefined)?.count ?? null,
      },
    },
  })
}
