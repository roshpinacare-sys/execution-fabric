'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { Scale, RefreshCw } from 'lucide-react'

// בודק-הטענות (Claims-vs-Reality) — לוח-חי של הפער בין-ההצהרות למציאות על /api/claims.
// העיקרון (דרישת-הבעלים): כל-טענה-ארכיטקטונית נשפטת-על-ידי-בדיקה-חיה — לא-על-ידי-הדיווח-שלה-על-עצמה.
// דגימה-כל-45ש' של-GET בלבד (אפס-ניפוח-שרשרת); "בדוק-וחתום" חותם-AUDIT כן בשרשרת.
// RTL, פלטת-הרשת בלבד (emerald/amber/rose/teal/zinc — אפס-כחול/אינדיגו), a11y, responsive.

interface ClaimProbe {
  id: string
  claim: string
  status: 'active' | 'degraded' | 'down'
  evidence: string
  latencyMs: number | null
  probedAt: string
}

interface ClaimsResponse {
  ok: boolean
  overall: 'active' | 'degraded' | 'critical'
  counts?: { total: number; active: number; degraded: number; down: number }
  claims: ClaimProbe[]
  generatedAt: string
  durationMs?: number
  error?: string
  signed?: { id: number; hash: string; worker: string; status: string } | null
}

const POLL_MS = 45_000

const STATUS_LABEL: Record<ClaimProbe['status'], string> = {
  active: 'מאומתת',
  degraded: 'מופחתת',
  down: 'שתוקה',
}

const OVERALL_LABEL: Record<ClaimsResponse['overall'], string> = {
  active: 'טענות: מאומצות',
  degraded: 'טענות: מופחתות',
  critical: 'טענות: שבורות',
}

const DOT_CLASS: Record<ClaimProbe['status'], string> = {
  active: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  down: 'bg-rose-500',
}

const BADGE_CLASS: Record<ClaimProbe['status'], string> = {
  active: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  degraded: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  down: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
}

const OVERALL_BADGE_CLASS: Record<ClaimsResponse['overall'], string> = {
  active: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  degraded: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  critical: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
}

export function ClaimsAuditor() {
  const { toast } = useToast()
  const [report, setReport] = useState<ClaimsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false) // הגנת-ניפוח-שרשרת — לחיצה-אחת-בכל-רגע

  const apply = useCallback((data: ClaimsResponse) => {
    setReport(data)
    setErr(null)
  }, [])

  // דגימה-חיה כל-45ש' — GET בלבד, אין-חתימה
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/claims', { cache: 'no-store' })
        const data = (await res.json()) as ClaimsResponse
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

  // "בדוק-וחתום" — POST ?subject=claims-audit + חתימת-AUDIT-כנה + toast
  const checkNow = async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    try {
      const res = await fetch('/api/claims?subject=claims-audit', { method: 'POST', cache: 'no-store' })
      const data = (await res.json()) as ClaimsResponse
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      apply(data)
      const c = data.counts
      const s = data.signed
      toast({
        title: data.overall === 'active' ? 'כל-הטענות אומתו-חי ונחתמו' : 'נמצאו-פערים — נחתם-בכנות (FAILED)',
        description: `${c ? `${c.active}/${c.total} מאומתות · ${c.degraded} מופחתות · ${c.down} שתוקות` : '—'}${s ? ` · רשומה #${s.id} status=${s.status}` : ''}`,
        variant: data.overall === 'active' ? 'default' : 'destructive',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast({ title: 'בדיקת-הטענות נכשלה — מדווח-בכנות', description: msg, variant: 'destructive' })
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  const overall = report?.overall
  const counts = report?.counts

  return (
    <Card aria-label="בודק-הטענות: הפער בין-ההצהרות למציאות">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Scale className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
            בודק-הטענות
            <Badge
              variant="outline"
              className={overall ? OVERALL_BADGE_CLASS[overall] : 'border-zinc-400/40 text-zinc-500'}
            >
              {overall ? OVERALL_LABEL[overall] : 'נטען…'}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" role="status">
              {report ? `עודכן ${new Date(report.generatedAt).toLocaleTimeString('he-IL')}` : 'דגימה-חיה מ-/api/claims'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={checkNow}
              disabled={checking}
              aria-label="בדיקת-טענות עכשיו עם חתימה כנה בשרשרת"
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
              {checking ? 'בודק…' : 'בדוק-וחתום'}
            </Button>
          </div>
        </div>
        <CardDescription>
          כל-טענה-ארכיטקטונית נשפטת-על-ידי-בדיקה-חיה עם-ראייה — לא-על-ידי-הדיווח-שלה-על-עצמה.
          {counts ? ` (${counts.active} מאומתות · ${counts.degraded} מופחתות · ${counts.down} שתוקות)` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && (
          <div className="mb-3 text-sm text-rose-600 dark:text-rose-400" role="alert">
            הדגימה-עצמה-כשלה: {err}
          </div>
        )}
        {!report && !err && <Skeleton className="h-40 w-full" />}
        {report && (
          <ul
            className="max-h-96 space-y-2 overflow-y-auto pl-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar]:w-1.5 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700"
            aria-label="רשימת-הטענות-ומצבן-הנמדד"
          >
            {report.claims.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-2.5 rounded-lg border bg-card p-3 min-w-0"
                aria-label={`טענה ${c.id}: ${STATUS_LABEL[c.status]}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[c.status]}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                    <span dir="ltr" className="font-mono text-xs">
                      {c.id}
                    </span>
                    <Badge
                      variant="outline"
                      className={`h-auto px-1.5 py-0 text-[10px] leading-tight ${BADGE_CLASS[c.status]}`}
                    >
                      {STATUS_LABEL[c.status]}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground break-words">{c.claim}</div>
                  <div className="mt-0.5 text-xs break-words">{c.evidence}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                    {c.latencyMs !== null ? `נמדד ${c.latencyMs}מ"ש · ` : ''}
                    נבדק {new Date(c.probedAt).toLocaleTimeString('he-IL')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
