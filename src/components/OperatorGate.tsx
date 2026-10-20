'use client'

// שער-הבעלים (Task 91): מנעול-לקוח-אחד — כל-קריאת-שינוי-מצב מהדפדפן נושאת-מפתח
// אוטומטית (יירוט-fetch גלובלי), והמצב נראה-בכנות בכרטיס. אפס-עריכות-פזורות ב-18-אתרי-קריאה.
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { KeyRound, Lock, LockOpen } from 'lucide-react'

const STORAGE_KEY = 'operator-key'

type GateStatus = { configured: boolean; unlocked: boolean; via: string } | null

export function OperatorGate() {
  const [status, setStatus] = useState<GateStatus>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  // יירוט-fetch: כל-בקשת-שינוי-מצב (POST/PUT/PATCH/DELETE, או GET עם force) לאותו-מקור
  // נושאת-אוטומטית x-operator-key מה-localStorage — חוק-אחד במקום עריכת-כל-הקוראים.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as typeof window & { __operatorFetchPatched?: boolean }
    if (w.__operatorFetchPatched) return
    w.__operatorFetchPatched = true
    const orig = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        const sameOrigin = url.startsWith('/') || url.startsWith(window.location.origin)
        if (sameOrigin) {
          const method = String(
            init?.method ??
              (typeof input === 'object' && input !== null && !(input instanceof URL) ? input.method : 'GET') ??
              'GET',
          ).toUpperCase()
          const force = /[?&]force=1/.test(url)
          const mutates = (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') || force
          if (mutates) {
            const stored = window.localStorage.getItem(STORAGE_KEY) || ''
            if (stored) {
              const base =
                init?.headers ??
                (typeof input === 'object' && input !== null && !(input instanceof URL) ? input.headers : undefined)
              const headers = new Headers(base)
              if (!headers.has('x-operator-key')) headers.set('x-operator-key', stored)
              return orig(input, { ...init, headers })
            }
          }
        }
      } catch {
        /* ממשיכים-רגיל — אף-הפרעה לא-נדרשת */
      }
      return orig(input, init)
    }
  }, [])

  const checkStatus = useCallback(async () => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY) || ''
      const res = await fetch('/api/operator', {
        cache: 'no-store',
        headers: stored ? { 'x-operator-key': stored } : undefined,
      })
      const j = (await res.json().catch(() => null)) as
        | { ok?: boolean; configured?: boolean; unlocked?: boolean; via?: string }
        | null
      if (j?.ok) setStatus({ configured: !!j.configured, unlocked: !!j.unlocked, via: String(j.via ?? '') })
      else setStatus(null)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void checkStatus()
  }, [checkStatus])

  const save = async () => {
    setBusy(true)
    try {
      window.localStorage.setItem(STORAGE_KEY, key.trim())
      setKey('')
      await checkStatus()
    } finally {
      setBusy(false)
    }
  }

  const lockAgain = () => {
    try {
      window.localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* שקט */
    }
    void checkStatus()
  }

  const state = !status
    ? { label: '…נבדק', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }
    : !status.configured
      ? { label: 'אין-מפתח-על-המכונה', tone: 'bg-rose-500/15 text-rose-300 border-rose-500/30' }
      : status.unlocked
        ? { label: 'מנועל — בעלים', tone: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' }
        : { label: 'נעול — קריאה-בלבד', tone: 'bg-amber-500/15 text-amber-300 border-amber-500/30' }

  return (
    <Card className="border-slate-700/60 bg-slate-900/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4 text-slate-300" aria-hidden="true" />
            שער-הבעלים
          </CardTitle>
          <span className={`rounded-full border px-3 py-0.5 text-xs font-medium ${state.tone}`}>{state.label}</span>
        </div>
        <CardDescription className="text-xs leading-relaxed">
          הציבור רואה קריאה בלבד. שינוי-מצב (חתימה/הרצה/תיקון) דורש מפתח-בעלים —{' '}
          <code className="rounded bg-slate-800 px-1 py-0.5 text-[11px]" dir="ltr">
            upload/operator.env
          </code>{' '}
          על-המכונה (gitignored, לעולם לא בגיט). המפתח נשמר בדפדפן שלך בלבד.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.unlocked ? (
          <Button
            variant="outline"
            size="sm"
            onClick={lockAgain}
            className="border-slate-600 text-slate-200 hover:bg-slate-800"
          >
            <Lock className="h-4 w-4" aria-hidden="true" />
            נעל-שוב (נקה-מפתח-מהדפדפן)
          </Button>
        ) : (
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault()
              if (key.trim() && !busy) void save()
            }}
          >
            <label htmlFor="operator-key-input" className="sr-only">
              מפתח-בעלים
            </label>
            <Input
              id="operator-key-input"
              type="password"
              inputMode="text"
              autoComplete="off"
              dir="ltr"
              placeholder="x-operator-key…"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="border-slate-600 bg-slate-800/70 text-slate-100 placeholder:text-slate-500"
            />
            <Button
              type="submit"
              size="sm"
              disabled={busy || !key.trim()}
              className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-500"
            >
              <LockOpen className="h-4 w-4" aria-hidden="true" />
              אמת-מפתח
            </Button>
          </form>
        )}
        {status && (
          <p className="text-[11px] text-slate-400" dir="ltr">
            via: {status.via}
          </p>
        )}
        <Badge variant="outline" className="border-slate-600 text-slate-300">
          חוק-אחד: proxy.ts מצערת-אחת לכל-ה-API
        </Badge>
      </CardContent>
    </Card>
  )
}
