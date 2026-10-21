'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Activity, Flame, CircleAlert, CircleCheck, Landmark, Lock, RefreshCw } from 'lucide-react'

// פאנל-השוק-החריף (Task 106) — התשובה-החיה-לחזון: "שוק-חריף-של-גרידים-וארביטראזים
// דווקא-על-הדקס-שלנו, עם-תזרים-אמת-מבחוץ". מציג-בכנות:
//  · הדקס-הריבוני (:3010) — גובה, מימושים, פקודות-חיות, שווקים
//  · אמת-החוץ-המדידה (steemUsd רב-מקורות) מול-הפאריטי-והפרמיה-הפנימית
//  · הידיים-שלנו על הספר (arb-peg — ארב-מול-פאריטי; grid-mm — גריד-מייקר)
//  · רכיבי-ריצה-מאומתים (run-cards) — ההחלטה-האחרונה-במלואה
//  · מפת-הדרכים-החוץ: FF (ממתין-לאימות-השירות), HTX (נשלל-KYC), מסילת-Hive
// כנות: הספר-סימולציה-מוצהרת; אין-המצאת-מספרים; fail-closed-פר-מקור; רענון-15ש'.

interface Truth {
  steemUsd: number | null
  feedOk: boolean
  feedStale: boolean
  realSteemSbd: number | null
  parityMu: number | null
  sources: string[]
}
interface Book { internalMidMu: number | null; bestBid: number | null; bestAsk: number | null; premiumBps: number | null }
interface Action { hand: string; what: string; detail?: string; ok: boolean }
interface Fill { hand: string; side: string; price: number; qtyMu: number; edgeBpsVsParity: number | null }
interface LastCard {
  at: string
  cycle: number
  truth: Truth
  book: Book
  actions: Action[]
  fills: Fill[]
  mtmPnlMu: number
  note: string
}
interface ArbState {
  ok?: boolean
  cycles?: number
  lastCycleAt?: string | null
  halted?: boolean
  lastError?: string | null
  hands?: string[]
  minEdgeBps?: number
  lastCard?: LastCard | null
}
interface DexState {
  height?: number | null
  fills?: number | null
  liveOrders?: number | null
  halted?: boolean | null
  tps?: number | null
  markets?: Array<{ key: string; fair: number; bestBid: number | null; bestAsk: number | null; spreadBps: number }>
  hands?: Array<{ name: string; balances: Record<string, number>; locked: Record<string, number> }>
}
interface FfData {
  keyFound?: boolean
  source?: string
  lastError?: string | null
  checkedAt?: string | null
}

interface HotData {
  ok: boolean
  arb?: ArbState | null
  arbError?: string | null
  dex?: DexState | null
  dexError?: string | null
  ff?: FfData | null
}

const POLL_MS = 15_000
const fmtMu = (v: number | null | undefined) => (v === null || v === undefined ? '—' : (v / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 }))

export function HotMarketPanel() {
  const [d, setD] = useState<HotData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/dex-hot', { cache: 'no-store' })
        const j = (await res.json()) as HotData
        if (!alive) return
        if (res.ok && j.ok) {
          setD(j)
          setErr(null)
        } else setErr(`HTTP ${res.status}`)
        setUpdatedAt(new Date().toLocaleTimeString('he-IL', { hour12: false }))
      } catch (e) {
        if (!alive) return
        setErr(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    const t = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const arb = d?.arb ?? null
  const dex = d?.dex ?? null
  const card = arb?.lastCard ?? null
  const truth = card?.truth ?? null
  const wsteemMarket = d?.dex?.markets?.find((m) => m.key === 'WSTEEM/USDS' || m.key === 'USDS/WSTEEM') ?? null
  const ffPending = d?.ff?.keyFound && !!d.ff.lastError

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flame className="size-5 text-orange-500" aria-hidden />
          השוק-החריף-שלנו — גריד+ארביטראז על הדקס-הריבוני
          {arb?.halted ? (
            <Badge variant="destructive" className="gap-1">
              <CircleAlert className="size-3" aria-hidden /> עצור
            </Badge>
          ) : card ? (
            <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
              <Activity className="size-3 animate-pulse" aria-hidden /> סוחר
            </Badge>
          ) : (
            <Badge variant="outline" className="gap-1">
              <RefreshCw className="size-3 animate-spin" aria-hidden /> מתחיל
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          ידיים-חיות-על-הספר-של-הדקס-שלנו, מחוברות-לאמת-חוץ-מדידה. הפרמיה-מעל-פאריטי-האמת =
          הרווח-הנמדד; כל-החלטה = רכיב-ריצה-מאומת. הספר-סימולציה-מוצהרת — הכנות-קודמת-לכל-דבר.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {err ? (
          <div className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            <span>אין-קשר-לשוק-החריף: {err}</span>
          </div>
        ) : !d ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : (
          <>
            {/* אמת-חוץ מול ספר-פנים */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md border p-2.5">
                <div className="text-[11px] text-zinc-500">אמת-חוץ STEEM (מדיד-רב-מקורות)</div>
                <div className="font-mono text-sm font-semibold">${truth?.steemUsd ? truth.steemUsd.toFixed(6) : '—'}</div>
                {truth?.feedOk ? (
                  <div className="text-[10px] text-emerald-600 dark:text-emerald-400">פיד-חי{truth.feedStale ? ' (מיושן)' : ''}</div>
                ) : (
                  <div className="text-[10px] text-amber-600 dark:text-amber-400">פיד-כשל — מדווח-כן</div>
                )}
              </div>
              <div className="rounded-md border p-2.5">
                <div className="text-[11px] text-zinc-500">פאריטי-ספר (µ)</div>
                <div className="font-mono text-sm font-semibold">{truth?.parityMu ?? '—'}µ</div>
                <div className="text-[10px] text-zinc-400">שוק-אמת :3070 — {truth?.realSteemSbd ? `${truth.realSteemSbd.toFixed(5)} SBD/STEEM` : '—'}</div>
              </div>
              <div className="rounded-md border p-2.5">
                <div className="text-[11px] text-zinc-500">פרמיה-פנימית-מעל-אמת</div>
                <div className="font-mono text-sm font-semibold">{card?.book?.premiumBps !== null && card?.book?.premiumBps !== undefined ? `${(card.book.premiumBps / 100).toFixed(1)}%` : '—'}</div>
                <div className="text-[10px] text-zinc-400">המרווח-שהארב-קוצר-ומושך-מטה</div>
              </div>
              <div className="rounded-md border p-2.5">
                <div className="text-[11px] text-zinc-500">רווח-ידיים (sim-µ מתויג)</div>
                <div className={`font-mono text-sm font-semibold ${(card?.mtmPnlMu ?? 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                  {fmtMu(card?.mtmPnlMu)}µ
                </div>
                <div className="text-[10px] text-zinc-400">מצטבר-מול-זרע-ידוע</div>
              </div>
            </div>

            {/* מדדי-השוק */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                { l: 'גובה-שרשרת', v: dex?.height ?? '—' },
                { l: 'מימושים-סה"כ', v: dex?.fills ?? '—' },
                { l: 'פקודות-חיות', v: dex?.liveOrders ?? '—' },
                { l: 'מחזורי-ארב', v: arb?.cycles ?? '—' },
              ].map((x) => (
                <div key={x.l} className="rounded-md border p-2.5">
                  <div className="text-[11px] text-zinc-500">{x.l}</div>
                  <div className="font-mono text-sm font-semibold">{x.v}</div>
                </div>
              ))}
            </div>

            {/* שווקים */}
            {d.dex?.markets && d.dex.markets.length > 0 ? (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-zinc-50 dark:bg-zinc-900">
                    <tr className="text-right text-zinc-500">
                      <th className="p-2 font-medium">שוק</th>
                      <th className="p-2 font-medium">מגע</th>
                      <th className="p-2 font-medium">הצעה-הטובה</th>
                      <th className="p-2 font-medium">בקשה-הטובה</th>
                      <th className="p-2 font-medium">פיזור</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.dex.markets.map((m) => (
                      <tr key={m.key} className="border-t">
                        <td className="p-2 font-mono">{m.key}</td>
                        <td className="p-2 font-mono">{m.fair}µ</td>
                        <td className="p-2 font-mono">{m.bestBid ? `${m.bestBid}µ` : '—'}</td>
                        <td className="p-2 font-mono">{m.bestAsk ? `${m.bestAsk}µ` : '—'}</td>
                        <td className="p-2 font-mono">{m.spreadBps ? `${m.spreadBps}bps` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-xs text-zinc-400">טבלת-השווקים-טרם-נטענה מהדקס{d.dexError ? ` (${d.dexError})` : ''}</div>
            )}

            {/* ההחלטה-האחרונה — רכיב-ריצה-מאומת */}
            {card ? (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex items-center justify-between text-xs">
                  <span className="font-medium">רכיב-הריצה-האחרון #{card.cycle} — ההחלטות-החיות</span>
                  <span className="text-zinc-400">
                    {new Date(card.at + 'Z').toLocaleTimeString('he-IL', { hour12: false })}
                  </span>
                </div>
                <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                  {card.actions.length === 0 && card.fills.length === 0 ? (
                    <div className="text-xs text-zinc-400">מחזור-שקט — הסולמות-מצוטטים</div>
                  ) : (
                    <>
                      {card.fills.map((f, i) => (
                        <div key={`f${i}`} className="flex items-center gap-2 text-xs">
                          <CircleCheck className="size-3.5 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden />
                          <span className="font-medium text-teal-700 dark:text-teal-300">מימוש</span>
                          <span className="text-zinc-500">[{f.hand}]</span>
                          <span className="font-mono">{f.side === 'sell' ? 'מכר' : 'קנה'} {fmtMu(f.qtyMu)}µ @ {f.price}µ</span>
                          {f.edgeBpsVsParity !== null && (
                            <span className="font-mono text-emerald-600 dark:text-emerald-400">קצה {(f.edgeBpsVsParity / 100).toFixed(1)}% מעל-פאריטי</span>
                          )}
                        </div>
                      ))}
                      {card.actions.map((a, i) => (
                        <div key={`a${i}`} className="flex items-center gap-2 text-xs">
                          {a.ok ? (
                            <CircleCheck className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                          ) : (
                            <CircleAlert className="size-3.5 shrink-0 text-amber-500" aria-hidden />
                          )}
                          <span className="font-medium text-zinc-600 dark:text-zinc-300">{a.what}</span>
                          <span className="font-mono text-[11px] text-zinc-500">{a.detail}</span>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {/* מפת-הדרכים-החוץ — כנות */}
            <div className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium">
                <Landmark className="size-3.5" aria-hidden /> תזרים-אמת-מבחוץ — מפת-הדרכים-בכנות
              </div>
              <div className="grid gap-1.5 text-xs sm:grid-cols-3">
                <div className="flex items-center gap-1.5">
                  {ffPending ? (
                    <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-400">
                      <Lock className="size-3" aria-hidden /> FF ממתין-לאימותם
                    </Badge>
                  ) : d?.ff?.keyFound ? (
                    <Badge variant="outline" className="gap-1 border-emerald-300 text-emerald-700 dark:text-emerald-400">
                      <CircleCheck className="size-3" aria-hidden /> FF חי
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1">
                      <CircleAlert className="size-3" aria-hidden /> FF חסר-מפתח
                    </Badge>
                  )}
                  <span className="text-zinc-500">STEEM→BTC — השער-לכסף-אמת</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline">HTX נשלל</Badge>
                  <span className="text-zinc-500">KYC-שהבעלים-סירב-לו — סופי</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline">מסילת-Hive-קיימת</Badge>
                  <span className="text-zinc-500">בדקס — דורשת-מפתח-פעיל</span>
                </div>
              </div>
              <div className="mt-2 text-[11px] text-zinc-400">
                הנתיב-המלא-לכסף-אמת: גריד-האמת-על-שוק-הפנים-של-Steem (:3070, צל-עד-שמפתחות-נוחתים) →
                רווחי-STEEM/SBD אמת → FF (ברגע-האישור) → BTC. השוק-החריף-כאן-מאמן-את-המסחר-ומחבר-את-הספר-לאמת-כבר-עכשיו.
              </div>
            </div>

            {(arb?.lastError || d.arbError || d.dexError) && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400">
                כנות: {arb?.lastError ? `ארב-אחרון: ${arb.lastError} · ` : ''}{d.arbError ? `איבר-ארב: ${d.arbError} · ` : ''}{d.dexError ? `דקס: ${d.dexError}` : ''}
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>
                מחזור-אחרון: {card ? new Date(card.at + 'Z').toLocaleTimeString('he-IL', { hour12: false }) : '—'} ·
                ידיים: {arb?.hands?.join(', ') ?? '—'} · קצה-מינימום: {arb?.minEdgeBps ?? '—'}bps
              </span>
              <span>עודכן {updatedAt}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
