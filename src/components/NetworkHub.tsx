'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/hooks/use-toast'
import { Globe, RefreshCw } from 'lucide-react'

// רכזת-הרשת (Task 88) — לוח-חי של רישום-העוגנים על /api/hub.
// העיקרון: השרשרת-המקומית מרכז-העניינים; עוגני-חוץ נתמכים-סביבה — כל-עוגן מוצג
// במצבו-האמיתי (פעיל/מופחת/ממתין) ולא-מוסתר. דגימה-כל-20ש' של-GET בלבד
// (אפס-ניפוח-שרשרת); כפתור "בדוק-עכשיו" חותם-AUDIT פעם-אחת עם-toast-כן.
// RTL, פלטת-הרשת בלבד (emerald/amber/rose/teal/zinc — אפס-כחול/אינדיגו), a11y, responsive.

interface NetworkAnchor {
  name: string
  kind: string
  status: 'active' | 'degraded' | 'awaiting'
  detail: string
  lastCheckedAt: string
  latencyMs: number | null
}

interface HubResponse {
  ok: boolean
  networkStatus: 'active' | 'degraded' | 'critical'
  counts?: { total: number; active: number; degraded: number; awaiting: number }
  anchors: NetworkAnchor[]
  generatedAt: string
  error?: string
  signed?: { id: number; hash: string; kind: string; worker: string } | null
}

const POLL_MS = 20_000

// תוויות-מצב בעברית — ל-badge ול-toast
const STATUS_LABEL: Record<NetworkAnchor['status'], string> = {
  active: 'פעיל',
  degraded: 'מופחת',
  awaiting: 'ממתין',
}

const NET_LABEL: Record<HubResponse['networkStatus'], string> = {
  active: 'רשת: פעילה',
  degraded: 'רשת: מופחתת',
  critical: 'רשת: קריטית',
}

// נקודת-צבע לפי-מצב-עוגן: ירוק-פעיל / צהוב-מושהה / אדום-מופחת (טוקנים-קיימים)
const DOT_CLASS: Record<NetworkAnchor['status'], string> = {
  active: 'bg-emerald-500',
  awaiting: 'bg-amber-500',
  degraded: 'bg-rose-500',
}

const NET_BADGE_CLASS: Record<HubResponse['networkStatus'], string> = {
  active: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  degraded: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  critical: 'border-rose-500/40 text-rose-600 dark:text-rose-400',
}

export function NetworkHub() {
  const { toast } = useToast()
  const [hub, setHub] = useState<HubResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false) // שמירה-מפני-לחיצות-כפולות (הגנת-ניפוח-שרשרת)

  const apply = useCallback((data: HubResponse) => {
    setHub(data)
    setErr(null)
  }, [])

  // דגימה-חיה כל-20ש' — GET בלבד, אין-חתימה
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/hub', { cache: 'no-store' })
        const data = (await res.json()) as HubResponse
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

  // "בדוק-עכשיו" — POST ?subject=hub-check פעם-אחת + חתימת-AUDIT + toast-כן
  const checkNow = async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)
    try {
      const res = await fetch('/api/hub?subject=hub-check', { method: 'POST', cache: 'no-store' })
      const data = (await res.json()) as HubResponse
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      apply(data)
      const s = data.signed
      const c = data.counts
      toast({
        title: 'בדיקת-רשת הושלמה ונחתמה בשרשרת',
        description: `מצב: ${NET_LABEL[data.networkStatus]} · עוגנים: ${c ? `${c.active} פעילים, ${c.degraded} מופחתים, ${c.awaiting} ממתינים` : '—'}${s ? ` · רשומה #${s.id} (${s.worker})` : ''}`,
      })
    } catch (e) {
      // כנות-מלאה: הכישלון-מוצג-בשמו, המצב-הקודם נשאר על-המסך
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      toast({ title: 'בדיקת-הרשת נכשלה — מדווח-בכנות', description: msg, variant: 'destructive' })
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }

  const net = hub?.networkStatus
  const counts = hub?.counts

  return (
    <Card aria-label="רכזת-הרשת: רישום-עוגנים חי">
      <CardHeader className="pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="h-4 w-4 text-teal-600 dark:text-teal-400" aria-hidden="true" />
            רכזת-הרשת
            <Badge
              variant="outline"
              className={net ? NET_BADGE_CLASS[net] : 'border-zinc-400/40 text-zinc-500'}
            >
              {net ? NET_LABEL[net] : 'נטען…'}
            </Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" role="status">
              {hub ? `עודכן ${new Date(hub.generatedAt).toLocaleTimeString('he-IL')}` : 'דגימה-חיה מ-/api/hub'}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={checkNow}
              disabled={checking}
              aria-label="בדיקת-רשת עכשיו עם חתימה בשרשרת"
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />
              {checking ? 'בודק…' : 'בדוק-עכשיו'}
            </Button>
          </div>
        </div>
        <CardDescription>
          השרשרת-המקומית מרכז-העניינים; עוגני-חוץ נתמכים-סביבה. דגימה-חיה כל-20ש׳ — כל-עוגן מדווח-מצבו-האמיתי בשמו.
          {counts ? ` (${counts.active} פעילים · ${counts.degraded} מופחתים · ${counts.awaiting} ממתינים)` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {err && (
          <div className="mb-3 text-sm text-rose-600 dark:text-rose-400" role="alert">
            הדגימה-עצמה-כשלה: {err}
          </div>
        )}
        {!hub && !err && <Skeleton className="h-40 w-full" />}
        {hub && (
          <ul
            className="max-h-96 space-y-2 overflow-y-auto pl-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar]:w-1.5 dark:[&::-webkit-scrollbar-thumb]:bg-zinc-700"
            aria-label="רשימת-עוגני-הרשת"
          >
            {hub.anchors.map((a) => (
              <li
                key={a.name}
                className="flex items-start gap-2.5 rounded-lg border bg-card p-3 min-w-0"
                aria-label={`עוגן ${a.name}: ${STATUS_LABEL[a.status]}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[a.status]}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
                    <span dir="ltr" className="font-mono text-xs">
                      {a.name}
                    </span>
                    <Badge
                      variant="outline"
                      className={`h-auto px-1.5 py-0 text-[10px] leading-tight ${
                        a.status === 'active'
                          ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                          : a.status === 'awaiting'
                            ? 'border-amber-500/40 text-amber-600 dark:text-amber-400'
                            : 'border-rose-500/40 text-rose-600 dark:text-rose-400'
                      }`}
                    >
                      {STATUS_LABEL[a.status]}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground break-words">{a.detail}</div>
                  <div className="mt-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                    {a.latencyMs !== null ? `נמדד ${a.latencyMs}מ"ש · ` : ''}
                    נבדק {new Date(a.lastCheckedAt).toLocaleTimeString('he-IL')}
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
