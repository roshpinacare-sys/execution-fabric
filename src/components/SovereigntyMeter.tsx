'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { Crown, RefreshCw } from 'lucide-react'

// מד-הריבונות-העצמית (Task 92) — לוח-חי של "הארכיטקטורה היא הבעלים" על /api/sovereignty.
// הדוקטרינה (דרישת-הבעלים): הארכיטקטורה האוטונומית היא-הבעלים; הפניות-אליו = חריגים-חתומים-בלבד;
// הרמה-נמדדת-מראיות-חיות (לא-מהצהרות), תקרה-96 (חוק-הצניעות), כל-ממד-שקט פוסל-את-הכותרת "ריבונות".
// דגימה-כל-45ש' של GET בלבד; "בדוק-וחתום" חותם-AUDIT-כן בשרשרת (overall≠sovereign → FAILED-חתום).
// RTL, פלטת-הרשת בלבד (emerald/amber/rose/teal/zinc — אפס-כחול/אינדיגו), a11y, responsive.

interface SovereigntyDimension {
  id: string
  title: string
  doctrine: string
  weight: number
  status: 'active' | 'degraded' | 'down'
  score: number
  evidence: string
}

interface SovereigntyGate {
  id: string
  title: string
  whyNotSelf: string
  tried: string
  need: string
  status: 'dormant' | 'demanding' | 'resolved'
  evidence: string
}

interface SovereigntyResponse {
  ok: boolean
  level: number
  overall: 'sovereign' | 'active-with-holes' | 'partial' | 'owner-dependent'
  dimensions: SovereigntyDimension[]
  gates: SovereigntyGate[]
  architectureSigned48h?: number
  ownerSigned48h?: number
  generatedAt: string
  durationMs?: number
  error?: string
  signed?: { id: number; hash: string; worker: string; status: string } | null
}

const POLL_MS = 45_000

const STATUS_LABEL: Record<SovereigntyDimension['status'], string> = {
  active: 'פעיל',
  degraded: 'מופחת',
  down: 'שתוק',
}

const OVERALL_LABEL: Record<SovereigntyResponse['overall'], string> = {
  sovereign: 'ריבונות-בפועל',
  'active-with-holes': 'ריבונות-פעילה · עם-חורים',
  partial: 'ריבונות-חלקית',
  'owner-dependent': 'תלות-בבעלים',
}

const DOT_CLASS: Record<SovereigntyDimension['status'], string> = {
  active: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-rose-500',
}

const BADGE_CLASS: Record<SovereigntyDimension['status'], string> = {
  active: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  degraded: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  down: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
}

const OVERALL_BADGE_CLASS: Record<SovereigntyResponse['overall'], string> = {
  sovereign: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  'active-with-holes': 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  partial: 'border-amber-600/40 text-amber-700 dark:text-amber-400',
  'owner-dependent': 'border-rose-500/40 text-rose-600 dark:text-rose-400',
}

const GATE_BADGE_CLASS: Record<SovereigntyGate['status'], string> = {
  dormant: 'border-teal-500/40 text-teal-600 dark:text-teal-400',
  demanding: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
  resolved: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
}

const GATE_LABEL: Record<SovereigntyGate['status'], string> = {
  dormant: 'ישן-ומנוטר',
  demanding: 'דורש-בעלים',
  resolved: 'נפתר-עצמאית',
}

export function SovereigntyMeter() {
  const { toast } = useToast()
  const [report, setReport] = useState<SovereigntyResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)

  const apply = useCallback((data: SovereigntyResponse) => {
    setReport(data)
    setErr(null)
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/sovereignty', { cache: 'no-store' })
        const data = (await res.json()) as SovereigntyResponse
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
      const res = await fetch('/api/sovereignty?subject=sovereignty-audit', { method: 'POST', cache: 'no-store' })
      const data = (await res.json()) as SovereigntyResponse
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      apply(data)
      const s = data.signed
      toast({
        title: data.overall === 'sovereign' ? 'ריבונות-בפועל נמדדה-ונחתמה' : 'הרמה-נמדדה-ונחתמה-בכנות (ללא-כותרת-ריבונות)',
        description: `רמה ${data.level}/96 · ${OVERALL_LABEL[data.overall]}${s ? ` · רשומה #${s.id} status=${s.status}` : ''}`,
        variant: data.overall === 'sovereign' ? 'default' : 'destructive',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast({ title: 'מדידת-הריבונות נכשלה — מדווח-בכנות', description: msg, variant: 'destructive' })
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  const overall = report?.overall
  const level = report?.level

  return (
    <Card aria-label="מד-הריבונות-העצמית: הארכיטקטורה כבעלים — נמדד-בכנות">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Crown className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
            מד-הריבונות-העצמית
            <Badge
              variant="outline"
              className={overall ? OVERALL_BADGE_CLASS[overall] : 'border-zinc-400/40 text-zinc-500'}
            >
              {overall ? OVERALL_LABEL[overall] : 'נטען…'}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" role="status">
              {report ? `עודכן ${new Date(report.generatedAt).toLocaleTimeString('he-IL')}` : 'דגימה-חיה מ-/api/sovereignty'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={measureNow}
              disabled={checking}
              aria-label="מדידת-ריבונות עכשיו עם חתימה כנה בשרשרת"
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
              {checking ? 'מודד…' : 'מדוד-וחתום'}
            </Button>
          </div>
        </div>
        <CardDescription>
          הארכיטקטורה היא-הבעלים — הרמה נמדדת-מראיות-חיות, לא-מהצהרות. תקרה 96: מה-שלא-יודעים-שלא-יודעים.
          {report?.architectureSigned48h !== undefined
            ? ` (הכרעות-48שע': ארכיטקטורה ${report.architectureSigned48h} · בעלים ${report.ownerSigned48h})`
            : ''}
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
            {/* רמה-נמדדת */}
            <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
              <div
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 text-lg font-bold tabular-nums"
                style={{
                  borderColor: overall === 'sovereign' ? 'rgb(16 185 129)' : overall === 'owner-dependent' ? 'rgb(244 63 94)' : 'rgb(245 158 11)',
                  color: overall === 'sovereign' ? 'rgb(16 185 129)' : overall === 'owner-dependent' ? 'rgb(244 63 94)' : 'rgb(245 158 11)',
                }}
                aria-label={`רמת-ריבונות נמדדת: ${level} מתוך 96`}
              >
                {level}
              </div>
              <div className="min-w-0 text-sm">
                <div className="font-medium">
                  רמת-ריבונות-עצמית: {level}/96 — {overall ? OVERALL_LABEL[overall] : '—'}
                </div>
                <div className="text-xs text-muted-foreground">
                  ממד-שקט-אחד פוסל-את-הכותרת &quot;ריבונות&quot; — הכנות-קודמת-לתואר
                </div>
              </div>
            </div>

            {/* ששת-הממדים */}
            <ul
              className="max-h-96 space-y-2 overflow-y-auto pl-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar]:w-1.5 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700"
              aria-label="ששת-ממדי-הריבונות ומצבם-הנמדד"
            >
              {report.dimensions.map((d) => (
                <li
                  key={d.id}
                  className="flex items-start gap-2.5 rounded-lg border bg-card p-3 min-w-0"
                  aria-label={`ממד ${d.title}: ${STATUS_LABEL[d.status]} — ${d.score}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[d.status]}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                      <span>{d.title}</span>
                      <Badge
                        variant="outline"
                        className={`h-auto px-1.5 py-0 text-[10px] leading-tight ${BADGE_CLASS[d.status]}`}
                      >
                        {STATUS_LABEL[d.status]} · {d.score}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground/70">משקל {Math.round(d.weight * 100)}%</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground break-words">{d.doctrine}</div>
                    <div className="mt-0.5 text-xs break-words">{d.evidence}</div>
                  </div>
                </li>
              ))}

              {/* מרשם-החריגים: הערוץ-הלגיטימי-היחיד להפניית-בעלים */}
              {report.gates.map((g) => (
                <li
                  key={g.id}
                  className="flex items-start gap-2.5 rounded-lg border border-dashed bg-card p-3 min-w-0"
                  aria-label={`שער-בעלים ${g.title}: ${GATE_LABEL[g.status]}`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${g.status === 'demanding' ? 'bg-rose-500' : 'bg-teal-500'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                      <span>שער-בעלים: {g.title}</span>
                      <Badge
                        variant="outline"
                        className={`h-auto px-1.5 py-0 text-[10px] leading-tight ${GATE_BADGE_CLASS[g.status]}`}
                      >
                        {GATE_LABEL[g.status]}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground break-words">למה-לא-לבד: {g.whyNotSelf}</div>
                    <div className="mt-0.5 text-xs break-words">נוסה: {g.tried}</div>
                    <div className="mt-0.5 text-xs break-words">נדרש-מהבעלים: {g.need}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
