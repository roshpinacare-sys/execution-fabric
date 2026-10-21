'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Radio, GitCommitHorizontal, CheckCircle2, FileStack, Workflow } from 'lucide-react'

// דופק-התנועה (Task 102) — התשובה-החזותית לשאלה "אני-לא-רואה-תנועה".
// כל-מספר נגזר-מסדרת-הזמן-של-איבר-המדידה (saos-metrics) — דלתות-מונים כנות,
// אפס-המצאה: אין-דגימות = "אין-ראיות-עדיין" ולא-אפס-מזויף. נקודה-פועמת =
// רעננות-חיים-בת-20ש'; תנועה-אחרונה-לפני-X-שניות = הראיה-בעין.
// RTL, פלטת-הרשת (emerald/teal/violet/zinc/amber/rose), אפס-תלות-חדשה.

interface Pulse {
  ok: boolean
  error?: string
  generatedAt: string
  last: {
    at: string
    ledgerTotal: number
    ledgerDone: number
    queueQueued: number
    queueRunning: number
    hbTicks: number
    hbExecuted: number
    hbGitPushes: number
    witnessTotal: number
    organsUp: number
  } | null
  velocity1h: {
    ledgerEntries: number
    completions: number
    heartExecutions: number
    gitPushes: number
    secondsSinceLastLedger: number | null
    counterResets: number
  }
  velocity24h: {
    ledgerEntries: number
    completions: number
    heartExecutions: number
    gitPushes: number
    counterResets: number
  }
  series: { at: string; ledgerTotal: number; queueQueued: number; queueRunning: number }[]
  organs: { name: string; up: boolean; error: string | null }[]
}

const POLL_MS = 20_000

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return new Intl.NumberFormat('he-IL').format(n)
}

function sinceText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—'
  if (sec < 90) return `${Math.max(0, Math.round(sec))} שניות`
  if (sec < 5400) return `${Math.round(sec / 60)} דקות`
  return `${(sec / 3600).toFixed(1)} שעות`
}

// גרף-SVG מקומי (אפס-תלות): צמיחת-הפנקס + עומק-תור מת-מסדרת-הזמן
function Sparkline({ series }: { series: Pulse['series'] }) {
  if (series.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
        אין-עדיין-סדרת-דגימות לגרף (דגימה-ראשונה-בדרך)
      </div>
    )
  }
  const w = 560
  const h = 96
  const pad = 4
  const vals = series.map((s) => s.ledgerTotal).filter((v) => v >= 0)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const x = (i: number) => pad + (i / (series.length - 1)) * (w - 2 * pad)
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad)
  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.ledgerTotal).toFixed(1)}`).join(' ')
  const area = `${line} L${x(series.length - 1).toFixed(1)},${h - pad} L${x(0).toFixed(1)},${h - pad} Z`
  // עומק-תור (queued+running) — קו-עליון-עדין
  const qMax = Math.max(1, ...series.map((s) => s.queueQueued + s.queueRunning))
  const qLine = series
    .map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${(h - pad - ((s.queueQueued + s.queueRunning) / qMax) * (h - 2 * pad) * 0.6).toFixed(1)}`)
    .join(' ')
  return (
    <div dir="ltr">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-full" role="img" aria-label="גרף צמיחת הפנקס ועומק התור בשלוש השעות האחרונות">
        <path d={area} fill="currentColor" className="text-emerald-500/10" />
        <path d={line} fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-500" />
        <path d={qLine} fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" className="text-violet-400/60" />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{new Date(series[0]!.at).toLocaleTimeString('he-IL')}</span>
        <span>פנקס: {fmtNum(min)} → {fmtNum(max)}</span>
        <span>{new Date(series[series.length - 1]!.at).toLocaleTimeString('he-IL')}</span>
      </div>
    </div>
  )
}

export function LivePulse() {
  const [pulse, setPulse] = useState<Pulse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/pulse', { cache: 'no-store' })
        const data = (await res.json()) as Pulse
        if (alive) {
          setPulse(data)
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

  const flowing = (pulse?.velocity1h.secondsSinceLastLedger ?? null) !== null && (pulse?.velocity1h.secondsSinceLastLedger ?? Infinity) < 600
  const v1 = pulse?.velocity1h
  const v24 = pulse?.velocity24h

  const stats: { label: string; value: string; sub: string; icon: typeof FileStack }[] =
    v1 && v24
      ? [
          {
            label: 'רישומי-פנקס',
            value: `${fmtNum(v1.ledgerEntries)}/שעה`,
            sub: `24ש': ${fmtNum(v24.ledgerEntries)}`,
            icon: FileStack,
          },
          {
            label: 'השלמות',
            value: `${fmtNum(v1.completions)}/שעה`,
            sub: `24ש': ${fmtNum(v24.completions)}`,
            icon: CheckCircle2,
          },
          {
            label: 'ביצועי-הלב',
            value: `${fmtNum(v1.heartExecutions)}/שעה`,
            sub: `24ש': ${fmtNum(v24.heartExecutions)}`,
            icon: Workflow,
          },
          {
            label: 'דחיפות-גיט',
            value: `${fmtNum(v1.gitPushes)}/שעה`,
            sub: `24ש': ${fmtNum(v24.gitPushes)}`,
            icon: GitCommitHorizontal,
          },
        ]
      : []

  return (
    <Card aria-label="דופק התנועה של הרשת">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <span className="relative flex h-3 w-3" aria-hidden="true">
              {flowing && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              )}
              <span className={`relative inline-flex h-3 w-3 rounded-full ${flowing ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            </span>
            דופק-התנועה
            <Badge
              variant="outline"
              className={
                flowing
                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                  : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
              }
            >
              {pulse ? (flowing ? 'הרשת זורמת' : 'תנועה-איטית') : 'נטען…'}
            </Badge>
          </CardTitle>
          <span className="text-xs text-muted-foreground" role="status">
            {pulse
              ? `תנועה-אחרונה: לפני ${sinceText(pulse.velocity1h.secondsSinceLastLedger)} · רענון-20ש'`
              : 'מדידה-חיה מאיבר-המדידה'}
          </span>
        </div>
        <CardDescription>
          הראיה-בעין-שהרשת חיה: מהירות-תנועה אמת (דלתות-מונים בין-דגימות-דקה), סדרת-צמיחה חיה, ומצב-כל-האיברים.
          אפס-המצאה — מונה-שהתאפס (התחדשות-שירות) מדווח-כן ({pulse?.velocity1h.counterResets ?? 0} איפוסים בשעה).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && !pulse && (
          <div className="text-sm text-rose-600 dark:text-rose-400" role="alert">
            איבר-המדידה לא-מגיש: {err}
          </div>
        )}
        {!pulse && !err && <Skeleton className="h-48 w-full" />}
        {pulse && !pulse.ok && (
          <div className="text-sm text-rose-600 dark:text-rose-400" role="alert">
            fail-closed: {pulse.error}
          </div>
        )}
        {pulse && pulse.ok && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {stats.map((s) => {
                const Icon = s.icon
                return (
                  <div key={s.label} className="rounded-lg border bg-card p-3 min-w-0">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                      {s.label}
                    </div>
                    <div className="mt-1 text-lg font-semibold tabular-nums" dir="ltr" style={{ textAlign: 'right' }}>
                      {s.value}
                    </div>
                    <div className="text-xs text-muted-foreground">{s.sub}</div>
                  </div>
                )
              })}
            </div>

            <div className="rounded-lg border bg-card p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium text-foreground">צמיחת-הפנקס — 3 שעות אחרונות</span>
                <span dir="ltr">ledger ▬ · תור ⋯</span>
              </div>
              <Sparkline series={pulse.series} />
            </div>

            <div className="flex flex-wrap gap-2">
              {pulse.organs.map((o) => (
                <Badge
                  key={o.name}
                  variant="outline"
                  className={o.up ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-rose-500/40 text-rose-600 dark:text-rose-400'}
                >
                  {o.up ? '✓' : '✗'} {o.name}
                  {o.error ? ` · ${o.error.slice(0, 40)}` : ''}
                </Badge>
              ))}
              {pulse.last && (
                <Badge variant="outline" className="border-zinc-400/40 text-zinc-600 dark:text-zinc-300">
                  <Radio className="mr-1 h-3 w-3" aria-hidden="true" />
                  דגימה: {new Date(pulse.last.at).toLocaleTimeString('he-IL')} · תור {fmtNum(pulse.last.queueQueued)}/{fmtNum(pulse.last.queueRunning)}
                </Badge>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
