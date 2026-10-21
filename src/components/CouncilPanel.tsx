'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { BrainCircuit, CircleCheck, CircleAlert, ShieldAlert, Gavel, RefreshCw, FlaskConical } from 'lucide-react'

// מגן-מועצת-השולחן (Task 107) — התרגום-החי-של-AutoHedge+agency-agents לריבונות:
//  · פסק-מנהל-הסיכון-המכני (ספים-קשיחים: חשיפה-צדית, כשלים-רצופים, שוק-מת)
//  · כרטיס-המועצה (Director-LLM): תזת-פרי, תזת-דוב, חסרון-כמותי, הנחיות-ייעודיות,
//    שוברי-תזה, פערי-נתונים — שני-הצדדים-תמיד, ייעוץ-בלבד (אף-פקודה)
//  · ה-backtest-המדיד מהגריד: הדמיה-על-היסטוריה-אמיתית — מתויג-בכנות
// כנות: fail-closed-פר-מקור; כשל-LLM מדווח-בשמו; רענון-45ש'.

type SourceState = { ok: boolean; ms: number; error?: string }
type Ruling = { verdict: string; findings: string[]; thresholds: { maxSideSkewPct: number; rebalanceSkewPct: number; gridErrorStreak: number; staleCycleSec: number } }
type Evidence = {
  at: string
  sources: Record<string, SourceState>
  quant: { openTotalSbd: number; exposureSkewPct: number | null; fillsTotal: number; arbFillsTotal?: number; arbHandsActive?: number | null; arbMtmPnlMu?: number | null }
  dex?: { twoSided: number | null; markets: number | null; avgTwoSidedSpreadBps: number | null } | null
}
type Escalation = { severity: string; trigger: string; resolutionOptions: string[]; authority: string; deadline: string }
type Card = {
  id: number
  at: string
  verdict: string
  confidence: number | null
  thesisBull: string
  thesisBear: string
  risk: string
  directives: string[]
  thesisBreakers: string[]
  dataGaps: string[]
  escalation?: Escalation | null
  llmMs: number
}
type Backtest = {
  label: string
  window: { from: string | null; to: string | null; trades: number; priceFrom: number; priceTo: number }
  params: { stepPct: number; sizeSbd: number; seedSbd: number }
  result: { buys: number; sells: number; realizedSbd: number; equitySbd: number; returnPct: number; unrealizedSbd: number }
}
type Payload = {
  ok: boolean
  error?: string
  state?: {
    startedAt: string
    evidenceCycles: number
    councilCycles: number
    lastEvidence?: Evidence
    ruling?: Ruling
    lastCard?: Card | null
    lastCardError?: string | null
    lastGovernorVerdict?: string | null
    mechanicalHalts?: number
    lastError?: string | null
  }
  cards?: Card[]
  backtest?: Backtest | null
  backtestError?: string | null
}

const VERDICT_STYLE: Record<string, { badge: string; icon: typeof CircleCheck; label: string }> = {
  flowing: { badge: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border-emerald-600/30', icon: CircleCheck, label: 'זורמת' },
  warn: { badge: 'bg-amber-600/15 text-amber-700 dark:text-amber-300 border-amber-600/30', icon: CircleAlert, label: 'נגוסה' },
  danger: { badge: 'bg-rose-600/15 text-rose-700 dark:text-rose-300 border-rose-600/30', icon: ShieldAlert, label: 'מסוכנת' },
}

export function CouncilPanel() {
  const [data, setData] = useState<Payload | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const [at, setAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/council', { cache: 'no-store' })
      const j = (await res.json()) as Payload
      if (!j.ok) throw new Error(j.error ?? 'תשובה-שגויה')
      setData(j)
      setFail(null)
      setAt(new Date().toLocaleTimeString('he-IL'))
    } catch (e) {
      setFail(e instanceof Error ? e.message : 'שגיאה')
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 45_000)
    return () => clearInterval(t)
  }, [load])

  const st = data?.state
  const ruling = st?.ruling
  const card = st?.lastCard
  const ev = st?.lastEvidence
  const v = VERDICT_STYLE[ruling?.verdict ?? ''] ?? null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <BrainCircuit className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
          מועצת-השולחן הריבונית
          {v && (
            <Badge variant="outline" className={`${v.badge} gap-1`}>
              <v.icon className="h-3 w-3" aria-hidden />
              {v.label}
            </Badge>
          )}
          <Badge variant="outline" className="font-normal text-muted-foreground">Task 107-108 · AutoHedge+agency-agents+NEXUS מותאם</Badge>
        </CardTitle>
        <CardDescription>
          ראיות-חיות מכל-איבר → פסק-מכני-קשיח → מועצת-Director (ייעוץ-בלבד, אף-פקודה-לא-יוצאת)
          {at ? ` · עודכן ${at}` : ''} · רענון 45ש&apos;
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {fail && (
          <div className="rounded-md border border-rose-600/30 bg-rose-600/10 p-3 text-sm text-rose-700 dark:text-rose-300">
            המועצה-לא-נגישה — {fail}. fail-closed: לא-מומצא-דבר-במקומה.
          </div>
        )}

        {!data && !fail && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {data && st && (
          <>
            {/* ממצאי-המנהל-המכני */}
            {ruling && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                  <Gavel className="h-3.5 w-3.5" aria-hidden />
                  פסק-מנהל-הסיכון המכני
                  <span className="text-xs font-normal text-muted-foreground">
                    (ספים-קשיחים: חשיפה-צדית {ruling.thresholds?.maxSideSkewPct ?? 80}% · איזון {ruling.thresholds?.rebalanceSkewPct ?? 65}% · כשלים {ruling.thresholds?.gridErrorStreak ?? 3})
                  </span>
                </div>
                <ul className="space-y-0.5 text-sm text-muted-foreground">
                  {(ruling.findings ?? []).map((f, i) => (
                    <li key={i} className={f.startsWith('DANGER') ? 'text-rose-700 dark:text-rose-300' : f.startsWith('WARN') ? 'text-amber-700 dark:text-amber-300' : ''}>
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* מדדי-הראיות */}
            {ev && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="מלאי-פתוח" value={`${ev.quant?.openTotalSbd?.toFixed(1) ?? '—'} SBD`} />
                <Metric
                  label="חשיפה-צדית"
                  value={ev.quant?.exposureSkewPct === null || ev.quant?.exposureSkewPct === undefined ? '—' : `${ev.quant.exposureSkewPct > 0 ? '+' : ''}${ev.quant.exposureSkewPct}%`}
                  warn={ev.quant?.exposureSkewPct !== null && ev.quant?.exposureSkewPct !== undefined && Math.abs(ev.quant.exposureSkewPct) >= (ruling?.thresholds?.rebalanceSkewPct ?? 65)}
                />
                <Metric label="מימושים" value={String(ev.quant?.fillsTotal ?? '—')} />
                <Metric
                  label="רוחב-הספר"
                  value={ev.dex?.twoSided != null && ev.dex?.markets != null ? `${ev.dex.twoSided}/${ev.dex.markets} דו-צדדיים` : '—'}
                  warn={ev.dex?.twoSided != null && ev.dex?.markets != null && ev.dex.twoSided < ev.dex.markets}
                />
                <Metric label="ידיים-על-הדקס" value={ev.quant?.arbHandsActive != null ? String(ev.quant.arbHandsActive) : '—'} />
                <Metric
                  label="MTM-הארב (sim-µ)"
                  value={ev.quant?.arbMtmPnlMu != null ? `${ev.quant.arbMtmPnlMu > 0 ? '+' : ''}${ev.quant.arbMtmPnlMu.toLocaleString('he-IL')}µ` : '—'}
                  warn={(ev.quant?.arbMtmPnlMu ?? 0) < 0}
                />
                <div className="rounded-md border bg-muted/40 p-2">
                  <div className="text-[11px] text-muted-foreground">מקורות-הראיות</div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {Object.entries(ev.sources ?? {}).map(([k, s2]) => (
                      <Badge key={k} variant="outline" className={`px-1.5 py-0 text-[10px] ${s2.ok ? 'border-emerald-600/40 text-emerald-700 dark:text-emerald-300' : 'border-rose-600/40 text-rose-700 dark:text-rose-300'}`}>
                        {k}{s2.ok ? '' : ' ✕'}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* כרטיס-המועצה האחרון */}
            {card ? (
              <div className="rounded-md border p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">כרטיס-#{card.id}</span>
                  <span className="text-xs text-muted-foreground">{new Date(card.at).toLocaleString('he-IL')} · {(card.llmMs / 1000).toFixed(1)}ש&apos;</span>
                  {card.confidence !== null && (
                    <Badge variant="outline" className="text-xs">
                      ביטחון {(card.confidence * 100).toFixed(0)}%
                    </Badge>
                  )}
                </div>
                <p className="mb-2 text-sm font-medium leading-relaxed">{card.verdict}</p>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-md border border-emerald-600/25 bg-emerald-600/5 p-2">
                    <div className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">תזת-הפרי</div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{card.thesisBull || '—'}</p>
                  </div>
                  <div className="rounded-md border border-rose-600/25 bg-rose-600/5 p-2">
                    <div className="mb-1 text-xs font-semibold text-rose-700 dark:text-rose-300">תזת-הדוב</div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{card.thesisBear || '—'}</p>
                  </div>
                </div>
                {card.risk && (
                  <p className="mt-2 rounded-md bg-amber-600/10 p-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                    <span className="font-semibold">החסרון-הכמותי: </span>
                    {card.risk}
                  </p>
                )}
                {card.directives?.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-xs font-semibold">הנחיות-ייעודיות (ייעוץ-בלבד)</div>
                    <ul className="list-inside list-decimal space-y-0.5 text-xs text-muted-foreground">
                      {card.directives.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {card.escalation && (
                  <div className="mt-2 rounded-md border border-rose-600/40 bg-rose-600/10 p-2">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
                      <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
                      בלוק-הסלמה (NEXUS) · סמכות: {card.escalation.authority}
                      {card.escalation.deadline && (
                        <span className="font-normal text-muted-foreground">· דדליין {new Date(card.escalation.deadline).toLocaleTimeString('he-IL')}</span>
                      )}
                    </div>
                    {card.escalation.trigger && <p className="text-xs leading-relaxed text-rose-800 dark:text-rose-200">טריגר-מדיד: {card.escalation.trigger}</p>}
                    {card.escalation.resolutionOptions?.length > 0 && (
                      <ul className="mt-1 list-inside list-decimal space-y-0.5 text-xs text-muted-foreground">
                        {card.escalation.resolutionOptions.map((o, i) => (
                          <li key={i}>{o}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {(card.thesisBreakers?.length > 0 || card.dataGaps?.length > 0) && (
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    {card.thesisBreakers?.length > 0 && (
                      <div>
                        <div className="mb-1 text-xs font-semibold text-muted-foreground">שוברי-תזה (מה-יהפוך-את-הפסק)</div>
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {card.thesisBreakers.map((d, i) => (
                            <li key={i}>· {d}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {card.dataGaps?.length > 0 && (
                      <div>
                        <div className="mb-1 text-xs font-semibold text-muted-foreground">פערי-נתונים מוצהרים</div>
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {card.dataGaps.map((d, i) => (
                            <li key={i}>· {d}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : st.lastCardError ? (
              <div className="rounded-md border border-amber-600/30 bg-amber-600/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                כשל-מועצת-LLM מדווח-בשמו: {st.lastCardError} — אין-כרטיס-מומצא; הסבב-הבא-ינסה.
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">המועצה-הראשונה-בדרך (סבב-{st.councilCycles ?? 0})…</div>
            )}

            {/* ה-backtest-המדיד */}
            {data.backtest ? (
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="mb-1 flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  <FlaskConical className="h-3.5 w-3.5" aria-hidden />
                  ה-backtest-המדיד (דפוס-AutoHedge)
                  <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">{data.backtest.label}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Metric label="עסקאות-אמת-בחלון" value={String(data.backtest.window.trades)} />
                  <Metric label="מימושי-גריד (ק/מ)" value={`${data.backtest.result.buys}/${data.backtest.result.sells}`} />
                  <Metric
                    label="תשואה-נמדדת"
                    value={`${data.backtest.result.returnPct > 0 ? '+' : ''}${data.backtest.result.returnPct}%`}
                    warn={data.backtest.result.returnPct < 0}
                  />
                  <Metric label="הון-סופי" value={`${data.backtest.result.equitySbd} SBD`} />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  חלון: {data.backtest.window.from ?? '—'} → {data.backtest.window.to ?? '—'} · מחיר {data.backtest.window.priceFrom?.toFixed(4)} → {data.backtest.window.priceTo?.toFixed(4)} · פרמטרים: מרווח {data.backtest.params.stepPct}% · פקודה {data.backtest.params.sizeSbd} SBD · סל {data.backtest.params.seedSbd} SBD
                </p>
              </div>
            ) : data.backtestError ? (
              <div className="text-xs text-muted-foreground">backtest-לא-נמדד-כעת: {data.backtestError}</div>
            ) : null}

            {/* שקיפות-התפעול */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span>סבבי-ראיות: {st.evidenceCycles ?? 0}</span>
              <span>סבבי-מועצה: {st.councilCycles ?? 0}</span>
              <span>השתקויות-מכניות: {st.mechanicalHalts ?? 0}</span>
              <span>על-האוויר מ-{new Date(st.startedAt).toLocaleTimeString('he-IL')}</span>
              <span>כרטיסים-בארכיון: {data.cards?.length ?? 0}</span>
              {st.lastError && <span className="text-rose-700 dark:text-rose-300">שגיאה-אחרונה: {st.lastError}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Metric({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-md border bg-muted/40 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-medium ${warn ? 'text-amber-700 dark:text-amber-300' : ''}`}>{value}</div>
    </div>
  )
}
