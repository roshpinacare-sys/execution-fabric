'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Bot, Loader2, Play, Radar, ShieldAlert, ShieldCheck, Stethoscope } from 'lucide-react'

// לוח-תפעול-האוטונומיה (Task 43): הדף הוא משטח-תפעול, לא תצוגה.
// כל-סוכן — וגם הבעלים — רואה כאן את אותן-החלטות ויכול להריץ את אותו-טיק:
// GET /api/sovereign/ops (תמונת-מצב קריאה-למכונה) + POST /api/sovereign/ops/tick
// (סריקה → פסק-דין לפי review-policy.ts → פעולה → חתימת-שרשרת).

interface Verdict {
  id: string
  repo: string
  path: string
  ageMs: number
  verdict: 'DELIVERABLE' | 'SUSPENDED'
  reasons: string[]
}

interface OpsData {
  ok: boolean
  ops: {
    generatedAt: string
    machineContract: Record<string, string>
    reviewLaw: string
    pending: {
      count: number
      deliverable: number
      suspended: number
      verdicts: Verdict[]
    }
    budget: { used: number; cap: number; remaining: number }
    chain: { total: number; ok: boolean; head: string }
    ticks: Array<{ id: number; status: string; createdAt: string }>
  }
}

interface TickResult {
  ok: boolean
  tick: {
    scanned: number
    delivered: number
    suspended: number
    skipped: number
    durationMs: number
    budgetRemaining: number
  }
  outcomes?: Array<{ id: string; verdict: string; executed: boolean }>
}

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m} דק'`
  const h = Math.floor(m / 60)
  return `${h} שע' ${m % 60} דק'`
}

export function AutonomyOps() {
  const [ops, setOps] = useState<OpsData | null>(null)
  const [ticking, setTicking] = useState(false)
  const [selftesting, setSelftesting] = useState(false)
  const [tickResult, setTickResult] = useState<TickResult | null>(null)
  const [tickError, setTickError] = useState<string | null>(null)
  const [selftestResult, setSelftestResult] = useState<string | null>(null)

  const loadOps = useCallback(async () => {
    try {
      const res = await fetch('/api/sovereign/ops')
      const j = (await res.json()) as OpsData
      if (j.ok) setOps(j)
    } catch {
      /* polling — שקט */
    }
  }, [])

  useEffect(() => {
    loadOps()
    const iv = setInterval(loadOps, 30000)
    return () => clearInterval(iv)
  }, [loadOps])

  const runTick = useCallback(async () => {
    setTicking(true)
    setTickError(null)
    try {
      const res = await fetch('/api/sovereign/ops/tick', { method: 'POST' })
      const j = (await res.json()) as TickResult
      setTickResult(j.ok ? j : null)
      if (!j.ok) setTickError('הטיק נכשל — ראה dev.log')
      await loadOps()
    } catch {
      setTickError('הטיק נכשל — ראה dev.log')
    } finally {
      setTicking(false)
    }
  }, [loadOps])

  const runSelftest = useCallback(async () => {
    setSelftesting(true)
    setSelftestResult(null)
    try {
      const res = await fetch('/api/sovereign/ops/selftest', { method: 'POST' })
      const j = (await res.json()) as {
        ok: boolean
        selftest?: { allOk: boolean; passed: number; tools: number; durationMs: number }
      }
      setSelftestResult(
        j.ok && j.selftest
          ? `${j.selftest.allOk ? '✓ כל-הכלים חיים' : '⚠ כשלים זוהו'} — ${j.selftest.passed}/${j.selftest.tools} עברו · ${j.selftest.durationMs}ms`
          : 'selftest נכשל — ראה dev.log'
      )
      await loadOps()
    } catch {
      setSelftestResult('selftest נכשל — ראה dev.log')
    } finally {
      setSelftesting(false)
    }
  }, [loadOps])

  return (
    <Card id="sec-ops" className="scroll-mt-20">
      <CardHeader className="pb-4">
        <CardTitle className="text-base flex items-center gap-2">
          <Bot className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
          תפעול-האוטונומיה
        </CardTitle>
        <CardDescription>
          משטח-התפעול של הרשת — לא תצוגה-לבעלים: כל-סוכן (ארכיטקטורה/הנדסה/ריבונות) קורא{' '}
          <code dir="ltr" className="rounded bg-muted px-1 py-0.5 text-[10px]">GET /api/sovereign/ops</code>{' '}
          ומריץ{' '}
          <code dir="ltr" className="rounded bg-muted px-1 py-0.5 text-[10px]">POST /api/sovereign/ops/tick</code>{' '}
          — אותו-סף, אותו-חוק, אותו-שרשרת.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!ops ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            {/* מדדי-מצב */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">ממתינים</div>
                <div className="text-lg font-semibold">{ops.ops.pending.count}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">כשירים</div>
                <div className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                  {ops.ops.pending.deliverable}
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">מושהים</div>
                <div className="text-lg font-semibold text-rose-600 dark:text-rose-400">
                  {ops.ops.pending.suspended}
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">תקציב</div>
                <div className="text-lg font-semibold">
                  {ops.ops.budget.remaining}
                  <span className="text-xs text-muted-foreground">/{ops.ops.budget.cap}</span>
                </div>
              </div>
            </div>

            {/* פסקי-דין חיים */}
            {ops.ops.pending.verdicts.length > 0 && (
              <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border p-2">
                {ops.ops.pending.verdicts.map((v) => (
                  <div key={v.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                    {v.verdict === 'DELIVERABLE' ? (
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-500" />
                    )}
                    <span dir="ltr" className="font-mono text-[10px] text-muted-foreground">
                      {v.id.slice(-8)}
                    </span>
                    <span dir="ltr" className="truncate font-mono text-[10px]">
                      {v.path}
                    </span>
                    <span className="text-muted-foreground">· {fmtAge(v.ageMs)}</span>
                    <span
                      className={
                        v.verdict === 'DELIVERABLE'
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-rose-600 dark:text-rose-400'
                      }
                    >
                      {v.verdict === 'DELIVERABLE' ? 'כשיר-למסירה' : `מושהה: ${v.reasons.join(', ')}`}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* טיק-אחרון */}
            {tickResult && (
              <div
                className={`rounded-md border p-3 text-sm ${
                  tickResult.tick.delivered > 0
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-amber-500/30 bg-amber-500/5'
                }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Radar className="h-4 w-4" />
                  טיק-ריבונות: נסרקו {tickResult.tick.scanned} · נמסרו {tickResult.tick.delivered} ·
                  הושהו {tickResult.tick.suspended} · דולגו {tickResult.tick.skipped}
                </div>
                <p dir="ltr" className="mt-1 font-mono text-[11px] text-muted-foreground">
                  duration: {tickResult.tick.durationMs}ms · budgetRemaining: {tickResult.tick.budgetRemaining}
                </p>
              </div>
            )}
            {tickError && (
              <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-600 dark:text-rose-400">
                {tickError}
              </div>
            )}

            {/* selftest — בדיקת-סרט-כלים חיה */}
            {selftestResult && (
              <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <Stethoscope className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
                  בדיקת-סרט-כלים: {selftestResult}
                </div>
              </div>
            )}

            {/* היסטוריית-טיקים (שרשרת) */}
            {ops.ops.ticks.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  טיקים חתומים-בשרשרת ({ops.ops.ticks.length} אחרונים)
                </div>
                {ops.ops.ticks.slice(0, 4).map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck className="h-3 w-3 text-emerald-500" />
                    <span dir="ltr" className="font-mono">seq #{t.id}</span>
                    <span>{new Date(t.createdAt).toLocaleTimeString('he-IL')}</span>
                    <span>· {t.status}</span>
                  </div>
                ))}
              </div>
            )}

            {/* החוק + הכפתור */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <p dir="ltr" className="font-mono text-[10px] text-muted-foreground">
                {ops.ops.reviewLaw}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  onClick={runSelftest}
                  disabled={selftesting}
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                >
                  {selftesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />}
                  בדיקת-סרט-כלים
                </Button>
                <Button onClick={runTick} disabled={ticking} size="sm" className="gap-1.5">
                  {ticking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  הרץ טיק-ריבונות
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
