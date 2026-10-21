'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Activity, Ban, CircleAlert, CircleCheck, Layers, TrendingUp } from 'lucide-react'

// מגן-הגריד (Task 105) — היד-המסחרת-של-הגוף-על-השוק-המקומי-של-Steem.
// תשובה-חיה-ל"הגריד-לא-עובד": מציג-בכנות — מצב (צל/חי), כל-יד-ומה-היא-מחזיקה,
// מימושים, רווח-מתויג-בכנות (סימולציה-בצל / מדידה-בחיים), והחסימה-אם-יש.
// אפס-סודות בפלט, fail-closed, רענון-20ש'.

interface GridData {
  ok: boolean
  error?: string
  mode?: 'shadow' | 'live'
  fingerprint?: string
  price?: number | null
  stats?: { cycles: number; lastCycleAt: string | null; lastCycleMs: number; lastError: string | null }
  halt?: { halted: boolean; reason: string; at: string | null }
  config?: { levels: number; stepPct: number; orderSizeSbd: number; orderSizeSteem: number; reservePct: number }
  open?: Array<{ account: string; side: string; n: number; sbd: number; steem: number }>
  fills?: Array<{ account: string; side: string; n: number; sbd: number }>
  shadowPnlSbd?: number
  shadowPnlLabeled?: string
  recent?: Array<{ id: number; at: string; kind: string; account: string; side: string; price: number; detail: string | null }>
}

interface FfData {
  keyFound?: boolean
  source?: string
  currencies?: number | null
  steemSupported?: boolean
  btcSupported?: boolean
  lastError?: string | null
}

const POLL_MS = 20_000

const KIND_META: Record<string, { label: string; cls: string }> = {
  place: { label: 'הצבה', cls: 'text-emerald-600 dark:text-emerald-400' },
  fill: { label: 'מימוש', cls: 'text-teal-600 dark:text-teal-400' },
  cancel: { label: 'ביטול', cls: 'text-zinc-500' },
  error: { label: 'שגיאה', cls: 'text-rose-600 dark:text-rose-400' },
  halt: { label: 'עצירה', cls: 'text-rose-600 dark:text-rose-400' },
  'auto-halt': { label: 'עצירה-אוטומטית', cls: 'text-rose-600 dark:text-rose-400' },
  resume: { label: 'חזרה', cls: 'text-emerald-600 dark:text-emerald-400' },
}

function fmtPct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${v.toFixed(5)}`
}

export function GridPanel() {
  const [grid, setGrid] = useState<GridData | null>(null)
  const [ff, setFf] = useState<FfData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/grid', { cache: 'no-store' })
        const d = (await res.json()) as { ok: boolean; error?: string; grid?: GridData; ff?: FfData }
        if (!alive) return
        if (res.ok && d.ok && d.grid) {
          setGrid(d.grid)
          setFf(d.ff ?? null)
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

  const isShadow = grid?.mode === 'shadow'
  const liveMode = grid?.mode === 'live'
  const totalOpen = (grid?.open ?? []).reduce((s, o) => s + o.n, 0)
  const totalFills = (grid?.fills ?? []).reduce((s, f) => s + f.n, 0)

  return (
    <Card className="border-zinc-200 dark:border-zinc-800">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="size-4 text-teal-600 dark:text-teal-400" aria-hidden />
            גריד-הריבונות — היד-המסחרת על שוק Steem
          </CardTitle>
          <div className="flex items-center gap-2">
            {grid?.halt?.halted ? (
              <Badge className="border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400" variant="outline">
                עצור: {grid.halt.reason?.slice(0, 40)}
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className={
                liveMode
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }
            >
              {liveMode ? 'חי — מסחר אמיתי' : 'צל — שוק אמיתי, ביצוע מדומה'}
            </Badge>
          </div>
        </div>
        <CardDescription>
          גוף אחד חכם עם הרבה ידיים: מחזור כל 45 שניות, רמות מחולקות בין חשבונות (אפס דריסות), עצירה-בטיחותית על תנודה קיצונית
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err && !grid ? (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-600 dark:text-rose-400">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            איבר-הגריד לא נראה — כנות: {err}
          </div>
        ) : null}

        {!grid && !err ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : null}

        {grid ? (
          <>
            {/* שורת-שוק */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <div className="text-[11px] text-zinc-500">מחיר STEEM/SBD</div>
                <div className="font-mono text-sm font-semibold">{fmtPct(grid.price)}</div>
              </div>
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <div className="text-[11px] text-zinc-500">פקודות פתוחות</div>
                <div className="font-mono text-sm font-semibold">{totalOpen}</div>
              </div>
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <div className="text-[11px] text-zinc-500">מימושים</div>
                <div className="font-mono text-sm font-semibold">{totalFills}</div>
              </div>
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <div className="text-[11px] text-zinc-500">רווח {grid.shadowPnlLabeled === 'simulated' ? '(סימולציה)' : '(מדידה)'}</div>
                <div className="font-mono text-sm font-semibold text-teal-600 dark:text-teal-400">
                  {grid.shadowPnlSbd ?? 0} SBD
                </div>
              </div>
            </div>

            {/* ידיים — חשבונות */}
            <div>
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                <Activity className="size-3.5" aria-hidden /> הידיים ({grid.fingerprint ?? '—'}):
              </div>
              <div className="space-y-1.5">
                {(grid.open ?? []).length === 0 ? (
                  <div className="rounded-lg border border-zinc-200 p-2.5 text-xs text-zinc-500 dark:border-zinc-800">
                    אין פקודות פתוחות כרגע — המחזור הבא מציב מחדש
                  </div>
                ) : (
                  (grid.open ?? []).map((o, i) => (
                    <div
                      key={`${o.account}-${o.side}-${i}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 p-2.5 text-sm dark:border-zinc-800"
                    >
                      <span className="font-medium">{o.account}</span>
                      <span className="flex items-center gap-2 text-xs">
                        <Badge variant="outline" className={o.side === 'buy' ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-violet-500/40 text-violet-600 dark:text-violet-400'}>
                          {o.side === 'buy' ? 'קנייה' : 'מכירה'}
                        </Badge>
                        <span className="font-mono">
                          {o.n} פקודות · {o.side === 'buy' ? `${o.sbd.toFixed(2)} SBD` : `${o.steem.toFixed(1)} STEEM`}
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* החלטות-אחרונות — אודיט חי */}
            <div>
              <div className="mb-1.5 text-xs font-medium text-zinc-500">החלטות אחרונות (אודיט חי):</div>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 p-2 dark:border-zinc-800 [scrollbar-width:thin]">
                {(grid.recent ?? []).slice(0, 12).map((e) => {
                  const m = KIND_META[e.kind] ?? { label: e.kind, cls: 'text-zinc-500' }
                  return (
                    <div key={e.id} className="flex items-center gap-2 text-[11px] leading-relaxed">
                      <span className="shrink-0 font-mono text-zinc-400">{new Date(e.at + 'Z').toLocaleTimeString('he-IL', { hour12: false })}</span>
                      <span className={`shrink-0 font-semibold ${m.cls}`}>{m.label}</span>
                      <span className="shrink-0">{e.account}</span>
                      {e.price > 0 ? <span className="shrink-0 font-mono text-zinc-500">@{e.price.toFixed(5)}</span> : null}
                      <span className="truncate text-zinc-500">{e.detail ?? ''}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* עורק-FF */}
            {ff ? (
              <div className="rounded-lg border border-zinc-200 p-2.5 text-xs dark:border-zinc-800">
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <TrendingUp className="size-3.5" aria-hidden /> עורק-ההמרה (FixedFloat → כסף אמיתי):
                </div>
                {ff.keyFound ? (
                  ff.lastError ? (
                    <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      מפתח בכספת אותר אך ה-API משיב: <span className="font-mono text-[10px]">{ff.lastError.slice(0, 90)}</span> — נדרש לבדוק הרשאות-מפתח
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                      <CircleCheck className="size-3.5" aria-hidden />
                      מחובר — {ff.currencies} מטבעות; STEEM: {ff.steemSupported ? 'נתמך' : 'לא נתמך'}, BTC: {ff.btcSupported ? 'נתמך' : 'לא נתמך'}
                    </div>
                  )
                ) : (
                  <div className="flex items-center gap-1.5 text-zinc-500">
                    <Ban className="size-3.5" aria-hidden /> אין מפתח-FF בכספת
                  </div>
                )}
              </div>
            ) : null}

            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>
                מחזורים: {grid.stats?.cycles ?? 0} · מחזור-אחרון: {grid.stats?.lastCycleAt ? new Date(grid.stats.lastCycleAt + 'Z').toLocaleTimeString('he-IL', { hour12: false }) : '—'}
                {grid.stats?.lastError ? ` · שגיאה-אחרונה: ${grid.stats.lastError.slice(0, 50)}` : ''}
              </span>
              <span>עודכן {updatedAt}</span>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
