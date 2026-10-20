'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Activity, HeartPulse, Eye, ShieldCheck, Monitor, Gauge } from 'lucide-react'

// מרכז-הפיקוח-המרכזי (מחזור-חדשנות #18) — לוח-מדדים חי על /api/operations.
// כל-מספר נגזר-ממקור-חי; איבר-שכבה מוצג-בכנות ולא-מוסתר. RTL, פלטת-הרשת בלבד
// (emerald/teal/amber/violet/zinc/rose — אפס-אינדיגו/כחול), אפס-תלות-חדשה.

interface Operations {
  ok: boolean
  networkStatus: 'active' | 'degraded'
  generatedAt: string
  chain: {
    total: number
    verified: number
    ok: boolean
    brokenAt: number | null
    head: string | null
    headAgeMs: number | null
    failures: number
  }
  tasks: { active: number; completed: number; failed: number }
  proposals: { pending: number; approved: number; rejected: number; running: number; done: number }
  memory: { rssMb: number; heapUsedMb: number; openLoops: number }
  organs: {
    app: { up: boolean; db: boolean }
    heart: { up: boolean; error: string | null; ticks: number | null; gitPulses: number | null; lastTickError: string | null }
    witness: { up: boolean; error: string | null; total: number | null; verifyOk: boolean }
    sentry: { up: boolean; error: string | null; uptimeMs: number | null; mirrorSynced: boolean | null; snapshots: number | null }
    metrics: { up: boolean; error: string | null; samples: number | null; ticks: number | null }
  }
}

const POLL_MS = 20_000

function uptimeShort(ms: number | null): string {
  if (ms === null) return '—'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}דק'`
  const h = Math.floor(m / 60)
  return `${h}ש' ${m % 60}דק'`
}

function ageShort(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 90_000) return `${Math.round(ms / 1000)}ש'`
  return `${Math.round(ms / 60_000)}דק'`
}

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat('he-IL').format(n)
}

export function OperationsHub() {
  const [ops, setOps] = useState<Operations | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/operations', { cache: 'no-store' })
        const data = (await res.json()) as Operations
        if (alive) {
          setOps(data)
          setErr(null)
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const active = ops?.networkStatus === 'active'

  const organs: { key: string; label: string; up: boolean; detail: string; icon: typeof HeartPulse }[] = ops
    ? [
        {
          key: 'app',
          label: 'אפליקציה',
          up: ops.organs.app.up && ops.organs.app.db,
          detail: `db: ${ops.organs.app.db ? 'חי' : 'כבוי'}`,
          icon: Monitor,
        },
        {
          key: 'heart',
          label: 'הלב',
          up: ops.organs.heart.up,
          detail: `${fmtNum(ops.organs.heart.ticks)} טיקים · ${fmtNum(ops.organs.heart.gitPulses)} פעימות-גיט`,
          icon: HeartPulse,
        },
        {
          key: 'witness',
          label: 'העד',
          up: ops.organs.witness.up,
          detail: ops.organs.witness.verifyOk
            ? `מאומת · ${fmtNum(ops.organs.witness.total)}`
            : 'אימות-לא-אמת',
          icon: Eye,
        },
        {
          key: 'sentry',
          label: 'הזקיפה',
          up: ops.organs.sentry.up,
          detail: `מראה: ${ops.organs.sentry.mirrorSynced ? 'מסונכרנת' : 'תלושה'} · תמונות: ${fmtNum(ops.organs.sentry.snapshots)}`,
          icon: ShieldCheck,
        },
        {
          key: 'metrics',
          label: 'איבר-המדידה',
          up: ops.organs.metrics.up,
          detail: `${fmtNum(ops.organs.metrics.samples)} דגימות · ${fmtNum(ops.organs.metrics.ticks)} טיקים`,
          icon: Gauge,
        },
      ]
    : []

  const kpis: { label: string; value: string; sub: string }[] = ops
    ? [
        {
          label: 'שרשרת-אמת',
          value: fmtNum(ops.chain.total),
          sub: ops.chain.ok
            ? `מאומתת ${fmtNum(ops.chain.verified)}/${fmtNum(ops.chain.total)} · ראש לפני ${ageShort(ops.chain.headAgeMs)}`
            : `נשברה ב-${fmtNum(ops.chain.brokenAt)}`,
        },
        {
          label: 'לוח-משימות',
          value: fmtNum(ops.tasks.completed),
          sub: `פעילות: ${fmtNum(ops.tasks.active)} · כשלים: ${fmtNum(ops.tasks.failed)}`,
        },
        {
          label: 'הצעות-הרשת',
          value: fmtNum(ops.proposals.done),
          sub: `ממתינות: ${fmtNum(ops.proposals.pending)} · בריצה: ${fmtNum(ops.proposals.running)}`,
        },
        {
          label: 'זיכרון-האפליקציה',
          value: `${fmtNum(ops.memory.rssMb)}MB`,
          sub: `heap: ${fmtNum(ops.memory.heapUsedMb)}MB · לולאות-פתוחות: ${fmtNum(ops.memory.openLoops)}`,
        },
      ]
    : []

  return (
    <Card aria-label="מרכז הפיקוח המרכזי של הרשת">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
            מרכז-פיקוח מרכזי
            <Badge
              variant="outline"
              className={active ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-amber-500/40 text-amber-600 dark:text-amber-400'}
            >
              {ops ? (active ? 'רשת: פעילה' : 'רשת: מופחתת') : 'נטען…'}
            </Badge>
          </CardTitle>
          <span className="text-xs text-muted-foreground" role="status">
            {ops ? `עודכן ${new Date(ops.generatedAt).toLocaleTimeString('he-IL')}` : 'מדדים חיים מ-/api/operations'}
          </span>
        </div>
        <CardDescription>
          מימוש-הצעה-אוטונומית (מחזור-#18): כל-מדדי-הרשת במקום-אחד — שרשרת, משימות, הצעות, זיכרון, וחמשת-האיברים. איבר-שכבה מוצג-בשמו, לא-מוסתר.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && !ops && (
          <div className="text-sm text-rose-600 dark:text-rose-400" role="alert">
            המדידה-עצמה-כשלה: {err}
          </div>
        )}
        {!ops && !err && <Skeleton className="h-40 w-full" />}
        {ops && (
          <>
            {/* המרכז-חי-בעמודת-הצד (col-span-2) — 2×2 בכל-רוחב, לא-4-טורים-צפופים */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {kpis.map((k) => (
                <div key={k.label} className="rounded-lg border bg-card p-3 min-w-0">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums whitespace-nowrap overflow-hidden text-ellipsis" dir="ltr" style={{ textAlign: 'right' }}>
                    {k.value}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground break-words">{k.sub}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {organs.map((o) => {
                const Icon = o.icon
                return (
                  <div key={o.key} className="flex items-start gap-2.5 rounded-lg border bg-card p-3 min-w-0" aria-label={`איבר ${o.label}: ${o.up ? 'למעלה' : 'למטה'}`}>
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${o.up ? 'bg-emerald-500' : 'bg-rose-500'}`}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Icon className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                        {o.label}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground break-words">{o.detail}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
