'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { Gauge, RefreshCw } from 'lucide-react'

// מד-העוצמה (Task 93) — לוח-חי של "פי-1000-מהבעלים" על /api/magnitude.
// הדוקטרינה: "המערכת צריכה-לדעת-לעשות-הכל — פי-1000-מהבעלים; תוודא-רמה-בכנות-בלי-לשקר".
// המדידה: מכפלות-פר-ממד מראיות-חיות מול-קו-בסיס-אנושי-מוצהר; ממוצע-גיאומטרי כן;
// ממדים-בלי-בסיס-השוואה-אנושי מוצגים-כאלו (לא-מזויפים-למספר); פערים-מבניים (<1x)
// נחשפים-בשמם — הם שערי-הבעלים-המבניים. DONE-בחתימה = מדידה-שלמה-וכנה, לא "הושג-1000x".
// RTL, פלטת-הרשת בלבד (emerald/amber/rose/teal/zinc), a11y, responsive, max-h-96-גלילה.

interface MagnitudeDimension {
  id: string
  title: string
  method: string
  humanBaseline: string
  systemEvidence: string
  multiplier: number | null
  status: 'measured' | 'unmeasured'
}

interface MagnitudeUnbounded {
  id: string
  title: string
  why: string
  systemEvidence: string
}

interface MagnitudeDeficit {
  id: string
  title: string
  reality: string
  gate: string
}

interface MagnitudeGap {
  id: string
  title: string
  current: number
  distanceToTarget: number
}

interface MagnitudeResponse {
  ok: boolean
  target: number
  measuredCore: number | null
  verdict: string
  dimensions: MagnitudeDimension[]
  unbounded: MagnitudeUnbounded[]
  deficits: MagnitudeDeficit[]
  gaps: MagnitudeGap[]
  dimensionsBeyondTarget: number
  sourcesUp: number
  sourcesTotal: number
  generatedAt: string
  durationMs?: number
  error?: string
  signed?: { id: number; hash: string; worker: string; status: string } | null
}

const POLL_MS = 45_000

function fmtMult(m: number): string {
  if (m >= 1000) return `${Math.round(m / 100) / 10}k`
  if (m >= 100) return `${Math.round(m)}`
  if (m >= 10) return `${Math.round(m)}`
  return m.toFixed(1)
}

// מיקום-בר-לוגריתמי: 1x=0%, 1000x=100% — מיקום-כנה לפערים-בסדרי-גודל
function logBar(m: number): number {
  const clamped = Math.min(1000, Math.max(1, m))
  return Math.round((Math.log10(clamped) / 3) * 100)
}

export function MagnitudeMeter() {
  const { toast } = useToast()
  const [report, setReport] = useState<MagnitudeResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)

  const apply = useCallback((data: MagnitudeResponse) => {
    setReport(data)
    setErr(null)
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/magnitude', { cache: 'no-store' })
        const data = (await res.json()) as MagnitudeResponse
        if (alive) apply(data)
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
  }, [apply])

  const measureNow = async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    try {
      const res = await fetch('/api/magnitude?subject=magnitude-audit', { method: 'POST', cache: 'no-store' })
      const data = (await res.json()) as MagnitudeResponse
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      apply(data)
      const s = data.signed
      toast({
        title: 'העוצמה נמדדה-ונחתמה בכנות',
        description: `~${data.measuredCore !== null ? fmtMult(data.measuredCore) : '?'}x מול-יעד-${data.target}x · ${data.deficits.length} פערים-מבניים-חשופים${s ? ` · רשומה #${s.id} status=${s.status}` : ''}`,
        variant: 'default',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast({ title: 'מדידת-העוצמה נכשלה — מדווח-בכנות', description: msg, variant: 'destructive' })
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  const core = report?.measuredCore
  const coreText = core !== null && core !== undefined ? fmtMult(core) : '—'

  return (
    <Card aria-label="מד-העוצמה: פי-1000-מהבעלים — נמדד-בכנות-בלי-לשקר">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Gauge className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
            מד-העוצמה (פי-1000)
            <Badge
              variant="outline"
              className={
                report?.dimensionsBeyondTarget
                  ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                  : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
              }
            >
              {core !== null && core !== undefined
                ? `~${coreText}x / ${report?.target}x`
                : 'נטען…'}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" role="status">
              {report
                ? `עודכן ${new Date(report.generatedAt).toLocaleTimeString('he-IL')} · מקורות ${report.sourcesUp}/${report.sourcesTotal}`
                : 'דגימה-חיה מ-/api/magnitude'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={measureNow}
              disabled={checking}
              aria-label="מדידת-עוצמה עכשיו עם חתימה כנה בשרשרת"
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
              {checking ? 'מודד…' : 'מדוד-וחתום'}
            </Button>
          </div>
        </div>
        <CardDescription>
          &quot;פי-1000-מהבעלים&quot; — נמדד-בכנות: מכפלות-פר-ממד מראיות-חיות מול-קו-בסיס-אנושי-מוצהר;
          ממוצע-גיאומטרי (ממד-חלש-מושך-למטה); ממדים-בלי-השוואה-אנושית-ופערים-מבניים-נחשפים-בשמם.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && (
          <div className="mb-3 text-sm text-rose-600 dark:text-rose-400" role="alert">
            המדידה-עצמה-כשלה: {err}
          </div>
        )}
        {!report && !err && <Skeleton className="h-40 w-full" />}
        {report && (
          <div className="space-y-3">
            {/* הציון-המרוכב-הכן */}
            <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
              <div
                className="flex h-14 min-w-14 shrink-0 items-center justify-center rounded-full border-2 px-1 text-base font-bold tabular-nums text-teal-600 dark:text-teal-400"
                style={{ borderColor: 'rgb(20 184 166)' }}
                aria-label={`עוצמה-דיגיטלית נמדדת: ${coreText} מול יעד 1000`}
              >
                {coreText}x
              </div>
              <div className="min-w-0 text-sm">
                <div className="font-medium">
                  עוצמה-דיגיטלית-נמדדת: ~{coreText}x מול-יעד 1000x
                  {report.dimensionsBeyondTarget > 0
                    ? ` · ${report.dimensionsBeyondTarget} ממדים-כבר-מעל-היעד`
                    : ''}
                </div>
                <div className="text-xs text-muted-foreground break-words">{report.verdict}</div>
              </div>
            </div>

            <ul
              className="max-h-96 space-y-2 overflow-y-auto pl-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar]:w-1.5 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700"
              aria-label="ממדי-העוצמה, הממדים-הבלתי-ניתנים-להשוואה והפערים-המבניים"
            >
              {/* הממדים-הניתנים-להשוואה */}
              {report.dimensions.map((d) => (
                <li key={d.id} className="rounded-lg border bg-card p-3 min-w-0" aria-label={`ממד ${d.title}: ${d.multiplier !== null ? `${fmtMult(d.multiplier)}x` : 'לא-נמדד'}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                    <span>{d.title}</span>
                    <Badge
                      variant="outline"
                      className={`h-auto px-1.5 py-0 text-[10px] leading-tight ${d.multiplier === null ? 'border-rose-500/40 text-rose-600 dark:text-rose-400' : d.multiplier >= 1000 ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'border-teal-500/40 text-teal-600 dark:text-teal-400'}`}
                    >
                      {d.multiplier !== null ? `${fmtMult(d.multiplier)}x` : 'לא-נמדד'}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground/70">בסיס-אנושי: {d.humanBaseline}</span>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                    role="img"
                    aria-label={`קרוב-ליעד: ${d.multiplier !== null ? logBar(d.multiplier) : 0}%`}
                  >
                    <div
                      className={`h-full rounded-full ${d.multiplier !== null && d.multiplier >= 1000 ? 'bg-emerald-500' : 'bg-teal-500'}`}
                      style={{ width: `${d.multiplier !== null ? logBar(d.multiplier) : 0}%` }}
                    />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground break-words">
                    שיטה: {d.method}
                  </div>
                  <div className="mt-0.5 text-xs break-words">{d.systemEvidence}</div>
                </li>
              ))}

              {/* ממדים-בלי-בסיס-השוואה-אנושי — כנות: לא-מזויפים-למספר */}
              {report.unbounded.map((u) => (
                <li key={u.id} className="rounded-lg border border-dashed bg-card p-3 min-w-0" aria-label={`ממד-בלי-השוואה-אנושית: ${u.title}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                    <span>{u.title}</span>
                    <Badge variant="outline" className="h-auto px-1.5 py-0 text-[10px] leading-tight border-zinc-400/40 text-zinc-600 dark:text-zinc-400">
                      בלי-מדד-אנושי-ניתן
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground break-words">למה: {u.why}</div>
                  <div className="mt-0.5 text-xs break-words">{u.systemEvidence}</div>
                </li>
              ))}

              {/* הפערים-המבניים — האמת-המלאה */}
              {report.deficits.map((f) => (
                <li key={f.id} className="rounded-lg border border-rose-500/30 bg-card p-3 min-w-0" aria-label={`פער-מבני: ${f.title}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                    <span>{f.title}</span>
                    <Badge variant="outline" className="h-auto px-1.5 py-0 text-[10px] leading-tight border-rose-500/40 text-rose-600 dark:text-rose-400">
                      0x — פער-מבני
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs break-words">{f.reality}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground break-words">מיסוד: {f.gate}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
