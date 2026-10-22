'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Loader2, RefreshCw, ShieldCheck, HeartPulse, GitBranch, Scale, Wrench, Activity } from 'lucide-react'

// משטח-ההוכחה (Task-124): הבעלים דרש — "אין הוכחה לטענות שלך הכל נופל ולא חוזר".
// התשובה כאן: לוח-מדידה-חי. כל-10s המשטח מודד מחדש מול-העולם-האמיתי:
//   עשרה-איברים בבדיקת-HTTP חיה (עם-זמן-תגובה), אירועי-נפילה→החזרה מהזקיפה עצמו,
//   שרשרת-חתומה + עד-חיצוני, מצב-גיט, נכסי-בנייה-מחדש. אפס-טענות — רק-מדידות.
// מחוון-השניות החי למעלה מוכיח-שהמשטח-עצמו חי בין-מדידה-למדידה.
// Task-125 (שיעור-הידרציה-חי): `useState(() => Date.now())` מרנדר-שעה-שונה-בשרת (UTC)
// מול-הלקוח (ישראל UTC+3) → קריסת-הידרציה-גלויה-לבעלים. מעתה: אפס-שעה-בשרת —
// `null` עד-ה-mount, פלייסהולדר אטום-לאזור-זמן, והשעה-האמיתית רק-מהלקוח.

type ProofData = {
  measuredAt: string
  measureMs: number
  rule: string
  organs: {
    up: number
    total: number
    probes: Array<{ name: string; port: number; up: boolean; latencyMs: number | null; httpStatus: number | null; error: string | null }>
  }
  keeper: {
    stateFile: string
    ticks: number | null
    lastTickAt: string | null
    watches: Array<{ name: string; up: boolean; restarts: number; lastResult: string | null }>
    respawnCount: number
    respawnLatest: Array<{ at: string; kind: string; msg: string }>
    eventsLatest: Array<{ at: string; kind: string; msg: string }>
  }
  chain: {
    total: number
    lastHour: number
    last12: Array<{ id: number; createdAt: number; worker: string; status: string }>
    witness: { ok?: boolean; total?: number; verified?: number; brokenAt?: string | null; checkedInMs?: number; error?: string }
  }
  git: {
    branch: string | null
    head: string | null
    originMain: string | null
    synced: boolean
    lastCommit: string | null
  }
  // Task-125: מצב-פעימת-הגיט-מהלב-עצמו — הבעלים ראה "לא-קרה-כלום" בזמן-שהדחיפה-נכשלה-בשקט.
  // מעתה: תוצאת-הדחיפה-האחרונה, מועדה וספירת-הדחיפות — נמדדות-חי-מהלב ומוצגות-בלוח.
  pulse: {
    gitPulses: number | null
    gitPushes: number | null
    lastGitPulseAt: string | null
    lastGitPulseResult: string | null
    appRestarts: number | null
    lastAppGuardResult: string | null
  } | null
  assets: {
    bootAllScript: boolean
    sovereignPulse: { exists: boolean; mtime: string | null }
  }
}

const REFRESH_MS = 10_000

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('he-IL', { hour12: false })
  } catch {
    return '—'
  }
}

export function ProofBoard() {
  const [data, setData] = useState<ProofData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    setNow(Date.now()) // בלקוח-בלבד — אפס-רינדור-שעה-בשרת (חוק-ההידרציה)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      alive.current = false
      clearInterval(clock)
    }
  }, [])

  const measure = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/sovereign/ops/proof', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as ProofData
      if (alive.current) {
        setData(d)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'מדידה-נכשלה')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    measure()
    const t = setInterval(measure, REFRESH_MS)
    return () => clearInterval(t)
  }, [measure])

  const secsAgo = data && now !== null ? Math.max(0, Math.floor((now - new Date(data.measuredAt).getTime()) / 1000)) : null

  return (
    <Card id="sec-proof" className="scroll-mt-20 lg:col-span-5 border-emerald-200/60 dark:border-emerald-900/40">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            משטח-ההוכחה — מדוד-חי, לא-טענות
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tabular-nums text-muted-foreground" aria-label="שעון-חי">
              {now === null ? '--:--:--' : new Date(now).toLocaleTimeString('he-IL', { hour12: false })}
            </span>
            <Button variant="outline" size="sm" onClick={measure} disabled={loading} aria-label="מדוד-עכשיו">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              מדוד-עכשיו
            </Button>
          </div>
        </div>
        <CardDescription>
          {error ? (
            <span className="text-rose-600 dark:text-rose-400">המדידה-האחרונה-נכשלה: {error} — מנסה-שוב-אוטומטית כל-10ש׳</span>
          ) : data ? (
            <>כל-שדה נמדד בפועל — לפני {secsAgo}ש׳ (מדידה-עצמה {data.measureMs}ms) · מתחדש-אוטומטית כל-10ש׳</>
          ) : (
            <>מודד-עכשיו מול-העולם-האמיתי…</>
          )}
        </CardDescription>
      </CardHeader>

      {data && (
        <CardContent className="space-y-4">
          {/* איברים — מדוד-חי עם-זמן-תגובה */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <HeartPulse className="h-3.5 w-3.5" />
              איברים — בדיקת-HTTP חיה: {data.organs.up}/{data.organs.total} חיים
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-5">
              {data.organs.probes.map((p) => (
                <div
                  key={p.name}
                  className={`flex items-center justify-between gap-1 rounded-md border px-2 py-1.5 text-xs ${
                    p.up
                      ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/50 dark:bg-emerald-950/30'
                      : 'border-rose-200 bg-rose-50/60 dark:border-rose-900/50 dark:bg-rose-950/30'
                  }`}
                  title={p.up ? `HTTP ${p.httpStatus}` : (p.error ?? 'לא-עונה')}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${p.up ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse'}`} />
                    <span className="truncate font-medium">{p.name}</span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{p.up ? `${p.latencyMs}ms` : 'מת'}</span>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* נפלו-וחזרו — הוכחת-החייאה מהזקיפה-עצמו */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              <span>
                הזקיפה: {data.keeper.ticks ?? '—'} טיקים · {data.keeper.respawnCount} אירועי-החייאה-בזיכרון-החי
              </span>
              {data.keeper.lastTickAt && (() => {
                const stale = (now - new Date(data.keeper.lastTickAt).getTime()) / 1000
                return (
                  <Badge
                    variant="outline"
                    className={stale < 45 ? 'text-emerald-700 dark:text-emerald-400 border-emerald-300/60 dark:border-emerald-800/60' : 'text-rose-600 dark:text-rose-400 border-rose-300/60 dark:border-rose-800/60'}
                  >
                    טיק-אחרון לפני {Math.floor(stale)}ש׳ {stale < 45 ? '(חי)' : '(קפוא!)'}
                  </Badge>
                )
              })()}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {data.keeper.watches
                .filter((w) => w.restarts > 0)
                .map((w) => (
                  <Badge key={w.name} variant="outline" className="text-amber-700 dark:text-amber-400 border-amber-300/60 dark:border-amber-800/60">
                    {w.name}: נפל-וחזר ×{w.restarts}
                  </Badge>
                ))}
              {data.keeper.watches.every((w) => w.restarts === 0) && (
                <span className="text-xs text-muted-foreground">אף-איבר-לא-נפל-מאז-עליית-הזקיפה — וכשנפלו-בעבר: חזרו (ראיות-להלן)</span>
              )}
            </div>
            {data.keeper.respawnLatest.length > 0 && (
              <div className="max-h-28 overflow-y-auto rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs space-y-1" dir="rtl">
                {data.keeper.respawnLatest
                  .slice()
                  .reverse()
                  .map((e, i) => (
                    <div key={`${e.at}-${i}`} className="flex items-center gap-2">
                      <span className="font-mono text-muted-foreground shrink-0">{fmtTime(e.at)}</span>
                      <span className="text-emerald-700 dark:text-emerald-400">{e.msg}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <Separator />

          {/* שרשרת-חתומה + עד-חיצוני + גיט */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Scale className="h-3.5 w-3.5" />
                שרשרת-חתומה
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="font-mono">{data.chain.total} רשומות</Badge>
                <Badge variant="outline" className="font-mono">{data.chain.lastHour} בשעה-האחרונה</Badge>
                {data.chain.witness?.ok ? (
                  <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                    עד: {data.chain.witness.verified}/{data.chain.witness.total} אומתו ({data.chain.witness.checkedInMs}ms)
                  </Badge>
                ) : (
                  <Badge className="bg-rose-600 text-white hover:bg-rose-600">עד-לא-מאשר</Badge>
                )}
              </div>
              {data.chain.last12.length > 0 && (
                <div className="max-h-24 overflow-y-auto rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs space-y-0.5 font-mono" dir="ltr">
                  {data.chain.last12.slice(0, 6).map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">#{e.id}</span>
                      <span className="truncate">{e.worker}</span>
                      <span className={`shrink-0 ${e.status === 'DONE' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{e.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <GitBranch className="h-3.5 w-3.5" />
                גיט-ריבוני
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="font-mono">{data.git.branch ?? '—'}</Badge>
                {data.git.synced ? (
                  <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">מסונכרן-עם-origin/main</Badge>
                ) : (
                  <Badge className="bg-amber-500 text-white hover:bg-amber-500">לא-מסונכרן — פעימה-בדרך</Badge>
                )}
              </div>
              {data.git.lastCommit && <div className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{data.git.lastCommit.split('|')[0]}</div>}
              {data.pulse && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs" dir="rtl">
                  <span className="text-muted-foreground">
                    פעימת-גיט: {fmtTime(data.pulse.lastGitPulseAt)} · {data.pulse.lastGitPulseResult ?? '—'}
                  </span>
                  {data.pulse.gitPushes !== null && (
                    <Badge variant="outline" className="font-mono">{data.pulse.gitPushes} דחיפות-אוטומטיות</Badge>
                  )}
                  {data.pulse.appRestarts !== null && data.pulse.appRestarts > 0 && (
                    <Badge variant="outline" className="text-amber-700 dark:text-amber-400 border-amber-300/60 dark:border-amber-800/60">
                      האפליקציה-נפלה-והוזנקה-חזרה ×{data.pulse.appRestarts}
                    </Badge>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Wrench className="h-3 w-3 text-muted-foreground" />
                {data.assets.bootAllScript ? (
                  <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400">boot-all.sh קיים (בנייה-מחדש-אחרי-התחלה-קרה)</Badge>
                ) : (
                  <Badge variant="outline" className="text-rose-600">חסר-boot-all.sh</Badge>
                )}
                {data.assets.sovereignPulse.exists && (
                  <Badge variant="outline" className="text-emerald-700 dark:text-emerald-400">פעימת-ראיה: {fmtTime(data.assets.sovereignPulse.mtime)}</Badge>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
