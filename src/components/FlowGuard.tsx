'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Activity, CircleAlert, CircleCheck, CircleX, Gauge } from 'lucide-react'

// מגן-הזרימה (Task 104) — התשובה-החיה ל"הארכיטקטורה-סוגרת-על-עצמה".
// כל-15ש' שואל /api/flow: "איפה-הזרימה-נחסמת-עכשיו?" — ומציג-פסק-דין-מנומק-במספרים.
// סתימה-אינה-עוד-חוויה-שקטה: היא-מסומנת-בשמה (סערת-ספק / ריצה-תקועה / אין-תנועה /
// איבר-שקט) עם-העדויות-המדודות — והלב מזניק-במקביל-עורקי-ניקוז לבד.
// RTL, פלטת-הרשת (emerald/amber/rose/zinc), אפס-תלות-חדשה, fail-closed בכישלון.

interface FlowDiagnosis {
  ok: boolean
  error?: string
  state?: 'flowing' | 'degraded' | 'blocked'
  bottleneck?: { code: string | null; human: string; evidence: Record<string, unknown> }
  queue?: { queued: number; running: number; runningStale: number; transientFailed: number; permanentFailed: number }
  movement?: { lastMovementSec: number | null }
  organs?: Array<{ name: string; up: boolean; detail: string }>
  diagnosisMs?: number
}

const POLL_MS = 15_000

const STATE_META = {
  flowing: { label: 'הזרימה שוטפת', cls: 'bg-emerald-500', badge: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
  degraded: { label: 'הזרימה נגוסה', cls: 'bg-amber-500', badge: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  blocked: { label: 'הזרימה חסומה', cls: 'bg-rose-500', badge: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400' },
} as const

const ORGAN_NAMES: Record<string, string> = {
  heart: 'הלב',
  witness: 'העד',
  keeper: 'הזקיפה',
  metrics: 'המדיד',
}

function sinceText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—'
  if (sec < 90) return `${Math.max(0, Math.round(sec))} שניות`
  if (sec < 5400) return `${Math.round(sec / 60)} דקות`
  return `${(sec / 3600).toFixed(1)} שעות`
}

export function FlowGuard() {
  const [flow, setFlow] = useState<FlowDiagnosis | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/flow', { cache: 'no-store' })
        const d = (await res.json()) as FlowDiagnosis
        if (!alive) return
        if (res.ok && d.ok) {
          setFlow(d)
          setErr(null)
        } else {
          setErr(d.error ?? `HTTP ${res.status}`)
        }
        setUpdatedAt(new Date().toLocaleTimeString('he-IL', { hour12: false }))
      } catch (e) {
        if (!alive) return
        setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const meta = flow?.state ? STATE_META[flow.state] : null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Gauge className="size-4 text-teal-600 dark:text-teal-400" aria-hidden />
              מגן-הזרימה
            </CardTitle>
            <CardDescription>
              איפה-הזרימה-נחסמת-עכשיו — אבחון-חי כל 15 שניות, מנומק-במספרים
            </CardDescription>
          </div>
          {meta ? (
            <Badge variant="outline" className={`shrink-0 ${meta.badge}`}>
              <span className="relative flex size-2">
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${meta.cls} opacity-60`} />
                <span className={`relative inline-flex size-2 rounded-full ${meta.cls}`} />
              </span>
              {meta.label}
            </Badge>
          ) : err ? (
            <Badge variant="outline" className="shrink-0 border-zinc-500/40 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400">
              <CircleX className="size-3" aria-hidden /> אבחון-נכשל
            </Badge>
          ) : (
            <Skeleton className="h-6 w-28" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && !flow ? (
          <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-700 dark:text-rose-400">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            <span>
              האבחון-נכשל ({err}) — fail-closed: לא-מזייפים-בריאות. הזרימה-עצמה-עשויה-להיות-תקינה; המדידה-שנפלה.
            </span>
          </div>
        ) : !flow ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : (
          <>
            {/* פסק-הדין האנושי — מנומק-בעדויות */}
            <div
              className={`rounded-md border p-3 text-sm leading-relaxed ${
                flow.state === 'flowing'
                  ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300'
                  : flow.state === 'degraded'
                    ? 'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300'
                    : 'border-rose-500/30 bg-rose-500/5 text-rose-800 dark:text-rose-300'
              }`}
              role="status"
            >
              {flow.bottleneck?.human ?? '—'}
            </div>

            {/* מדדי-התור והתנועה */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="תור-ממתין" value={String(flow.queue?.queued ?? '—')} />
              <Metric label="רצות-עכשיו" value={String(flow.queue?.running ?? '—')} />
              <Metric
                label="רצות-תקועות"
                value={String(flow.queue?.runningStale ?? '—')}
                warn={(flow.queue?.runningStale ?? 0) > 0}
              />
              <Metric
                label="חוזרים-על"
                value={String(flow.queue?.transientFailed ?? '—')}
                warn={(flow.queue?.transientFailed ?? 0) >= 5}
              />
              <Metric label="פסילות-קבועות" value={String(flow.queue?.permanentFailed ?? '—')} />
              <Metric label="תנועה-אחרונה" value={sinceText(flow.movement?.lastMovementSec)} />
            </div>

            {/* איברי-הזרימה */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">איברי-הזרימה:</span>
              {(flow.organs ?? []).map((o) => (
                <Badge
                  key={o.name}
                  variant="outline"
                  className={`gap-1 ${
                    o.up
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400'
                  }`}
                  title={o.detail}
                >
                  {o.up ? (
                    <CircleCheck className="size-3" aria-hidden />
                  ) : (
                    <CircleX className="size-3" aria-hidden />
                  )}
                  {ORGAN_NAMES[o.name] ?? o.name}
                </Badge>
              ))}
              <span className="ms-auto text-[11px] text-muted-foreground">
                <Activity className="mb-0.5 inline size-3" aria-hidden /> אובחן ב-{flow.diagnosisMs ?? '?'} מ"ש
                {updatedAt ? ` · ${updatedAt}` : ''}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div
      className={`rounded-md border p-2.5 text-center ${
        warn ? 'border-amber-500/40 bg-amber-500/5' : 'bg-background'
      }`}
    >
      <div className={`text-lg font-semibold tabular-nums ${warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}
