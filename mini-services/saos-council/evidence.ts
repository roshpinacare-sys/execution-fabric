// ===== אספקת-הראיות — אמת-חיה-מכל-איבר, fail-closed-פר-מקור =====
// עיקרון-משותף-עם-AutoHedge (MarketData רב-מקורות) ו-agency-agents
// ("State your assumptions before your conclusions"): כל-ראיה מסומנת-במקורה,
// כל-כשל-מקור מדווח-בשמו — אף-מספר-לא-מומצא.

export type SourceResult<T> = { ok: true; data: T; ms: number } | { ok: false; error: string; ms: number }

async function fetchJSON<T>(url: string, timeoutMs = 5_000): Promise<SourceResult<T>> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' })
    const ms = Date.now() - t0
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms }
    const data = (await res.json()) as T
    return { ok: true, data, ms }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120), ms: Date.now() - t0 }
  }
}

type Num = Record<string, unknown>

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function s(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ── גריד (:3070) ─────────────────────────────────────────────────────────────
export type GridEvidence = {
  price: number | null
  mode: string | null
  halted: boolean
  haltReason: string | null
  cycles: number | null
  lastCycleAt: string | null
  consecutiveErrors: number | null
  lastError: string | null
  openBuySbd: number
  openSellValueSbd: number
  openBuys: number
  openSells: number
  fillsBuy: number
  fillsSell: number
  shadowPnlSbd: number | null
  recentKinds: Record<string, number>
}

function gridEvidence(d: Num): GridEvidence {
  const open = Array.isArray(d.open) ? (d.open as Num[]) : []
  const fills = Array.isArray(d.fills) ? (d.fills as Num[]) : []
  let openBuySbd = 0
  let openSellValueSbd = 0
  let openBuys = 0
  let openSells = 0
  for (const o of open) {
    const side = s(o.side)
    const sbd = n(o.sbd) ?? 0
    if (side === 'buy') { openBuySbd += sbd; openBuys++ }
    if (side === 'sell') { openSellValueSbd += sbd; openSells++ }
  }
  let fillsBuy = 0
  let fillsSell = 0
  for (const f of fills) {
    if (s(f.side) === 'buy') fillsBuy += n(f.n) ?? 0
    if (s(f.side) === 'sell') fillsSell += n(f.n) ?? 0
  }
  const stats = (d.stats ?? {}) as Num
  const recent = Array.isArray(d.recent) ? (d.recent as Num[]) : []
  const kinds: Record<string, number> = {}
  for (const r of recent.slice(0, 30)) {
    const k = s(r.kind) ?? '?'
    kinds[k] = (kinds[k] ?? 0) + 1
  }
  const halt = (d.halt ?? {}) as Num
  return {
    price: n(d.price),
    mode: s(d.mode),
    halted: halt.halted === true,
    haltReason: s(halt.reason),
    cycles: n(stats.cycles),
    lastCycleAt: s(stats.lastCycleAt),
    consecutiveErrors: n(stats.consecutiveErrors) ?? 0,
    lastError: s(stats.lastError),
    openBuySbd: Math.round(openBuySbd * 100) / 100,
    openSellValueSbd: Math.round(openSellValueSbd * 100) / 100,
    openBuys,
    openSells,
    fillsBuy,
    fillsSell,
    shadowPnlSbd: n(d.shadowPnlSbd),
    recentKinds: kinds,
  }
}

// ── ארב (:3071) — חילוץ-הגנתי (לא-מניחים-שדות) ──────────────────────────────
export type ArbEvidence = {
  halted: boolean | null
  cycles: number | null
  premiumBps: number | null
  lastDecision: string | null
  fills: number | null
  feedOk: boolean | null
  feedStale: boolean | null
  parityMu: number | null
  internalMidMu: number | null
  mtmPnlMu: number | null
  fillsByHand: Record<string, number>
  hands: Record<string, { usdsMu: number; baseMu: number }> | null
  expansion: {
    twoSided: number | null
    oneSided: number | null
    total: number | null
    mmMarkets: string[]
    depthMarkets: string[]
    handsActive: number | null
  } | null
}

function arbEvidence(d: Num): ArbEvidence {
  const lastCard = (d.lastCard ?? {}) as Num
  // Task 108: השדה-נקרא actions (לא decisions) — הפער-שהמועצה-עצמה-הצהירה-בכרטיס-#1
  const acts = Array.isArray(lastCard.actions) ? (lastCard.actions as Num[]) : []
  const lastAct = acts.length ? acts[acts.length - 1] : null
  const lastDecision = lastAct ? `${s(lastAct.hand) ?? '?'}:${s(lastAct.what) ?? '?'} — ${s(lastAct.detail)?.slice(0, 120) ?? ''}` : null
  const book = (lastCard.book ?? {}) as Num
  const truth = (lastCard.truth ?? {}) as Num
  let premiumBps: number | null = null
  for (const k of ['premiumBps', 'premium_bps', 'premium']) {
    const v = n(d[k]) ?? n(book[k]) ?? n(lastCard[k])
    if (v !== null) { premiumBps = v; break }
  }
  const fillsArr = Array.isArray(lastCard.fills) ? (lastCard.fills as Num[]) : null
  const fillsByHand: Record<string, number> = {}
  if (fillsArr) for (const f of fillsArr) { const h = s(f.hand) ?? '?'; fillsByHand[h] = (fillsByHand[h] ?? 0) + 1 }
  const handsRaw = (lastCard.hands ?? {}) as Record<string, Num>
  const hands: Record<string, { usdsMu: number; baseMu: number }> = {}
  for (const [h, v] of Object.entries(handsRaw)) {
    hands[h] = { usdsMu: n(v.usdsMu) ?? 0, baseMu: n(v.baseMu) ?? 0 }
  }
  const expRaw = (lastCard.expansion ?? {}) as Num
  const expSum = (expRaw.summary ?? {}) as Num
  const expansion = expRaw.summary
    ? {
        twoSided: n(expSum.twoSided),
        oneSided: n(expSum.oneSided),
        total: n(expSum.total),
        mmMarkets: Array.isArray(expSum.mmMarkets) ? expSum.mmMarkets.filter((x): x is string => typeof x === 'string') : [],
        depthMarkets: Array.isArray(expSum.depthMarkets) ? expSum.depthMarkets.filter((x): x is string => typeof x === 'string') : [],
        handsActive: n(expRaw.handsActive),
      }
    : null
  return {
    halted: d.halted === true ? true : d.halted === false ? false : null,
    cycles: n(d.cycles) ?? n(d.runs),
    premiumBps,
    lastDecision,
    fills: fillsArr ? fillsArr.length : n(d.fills) ?? n(d.realizations),
    feedOk: truth.feedOk === true ? true : truth.feedOk === false ? false : null,
    feedStale: truth.feedStale === true ? true : truth.feedStale === false ? false : null,
    parityMu: n(truth.parityMu),
    internalMidMu: n(book.internalMidMu),
    mtmPnlMu: n(lastCard.mtmPnlMu),
    fillsByHand,
    hands: Object.keys(hands).length ? hands : null,
    expansion,
  }
}

// ── דקס (:3010) ──────────────────────────────────────────────────────────────
export type DexEvidence = {
  markets: number | null
  priceProof: unknown
  okFields: number
  twoSided: number | null
  avgTwoSidedSpreadBps: number | null
  oneSidedMarkets: string[] | null
}

function dexEvidence(d: Num): DexEvidence {
  const st = (d.state ?? {}) as Num
  const rowsRaw = (Array.isArray(d.markets) ? d.markets : Array.isArray(st.markets) ? st.markets : []) as Num[]
  const markets = Array.isArray(d.markets) ? d.markets.length : n(d.markets) ?? (rowsRaw.length || null)
  const pp = d.priceProof ?? d.price_proof ?? d['price-proof'] ?? null
  let twoSided = 0
  let spreadSum = 0
  const oneSided: string[] = []
  for (const r of rowsRaw) {
    const bb = n(r.bestBid)
    const ba = n(r.bestAsk)
    if (bb && ba && bb > 0 && ba > 0) { twoSided++; spreadSum += n(r.spreadBps) ?? 0 }
    else oneSided.push(`${s(r.base) ?? '?'}/${s(r.quote) ?? '?'}`)
  }
  return {
    markets: typeof markets === 'number' ? markets : null,
    priceProof: pp,
    okFields: Object.keys(d).length,
    twoSided: rowsRaw.length ? twoSided : null,
    avgTwoSidedSpreadBps: twoSided ? Math.round(spreadSum / twoSided) : null,
    oneSidedMarkets: rowsRaw.length ? oneSided : null,
  }
}

// ── זרימה (:3000/api/flow) ───────────────────────────────────────────────────
export type FlowEvidence = {
  verdict: string | null
  movementsPerHour: number | null
  detail: string | null
}

function flowEvidence(d: Num): FlowEvidence {
  const verdict = s(d.verdict) ?? s((d.diagnosis as Num | undefined)?.verdict)
  return { verdict, movementsPerHour: n(d.movementsPerHour) ?? n(d['movements-per-hour']), detail: s(d.reason) ?? s(d.detail) }
}

// ── חבילת-הראיות ─────────────────────────────────────────────────────────────
export type EvidenceBundle = {
  at: string
  sources: Record<string, { ok: boolean; ms: number; error?: string }>
  grid: GridEvidence | null
  arb: ArbEvidence | null
  dex: DexEvidence | null
  flow: FlowEvidence | null
  quant: {
    openTotalSbd: number
    exposureSkewPct: number | null // (buy−sell)/(buy+sell) ×100 — חשיפה-צדית
    fillsTotal: number
    arbFillsTotal: number
    arbHandsActive: number | null
    arbMtmPnlMu: number | null
  }
}

export async function gatherEvidence(): Promise<EvidenceBundle> {
  const [grid, arb, dex, flow] = await Promise.all([
    fetchJSON<Num>('http://127.0.0.1:3070/grid', 6_000),
    fetchJSON<Num>('http://127.0.0.1:3071/state', 6_000),
    fetchJSON<Num>('http://127.0.0.1:3010/saos-dex/api/dex/state', 8_000),
    fetchJSON<Num>('http://127.0.0.1:3000/api/flow', 8_000),
  ])
  const g = grid.ok ? gridEvidence(grid.data) : null
  const a = arb.ok ? arbEvidence(arb.data) : null
  const x = dex.ok ? dexEvidence(dex.data) : null
  const f = flow.ok ? flowEvidence(flow.data) : null
  const openTotalSbd = (g?.openBuySbd ?? 0) + (g?.openSellValueSbd ?? 0)
  const skew = openTotalSbd > 0 ? Math.round(((g!.openBuySbd - g!.openSellValueSbd) / openTotalSbd) * 100) : null
  return {
    at: new Date().toISOString(),
    sources: {
      grid: grid.ok ? { ok: true, ms: grid.ms } : { ok: false, ms: grid.ms, error: grid.error },
      arb: arb.ok ? { ok: true, ms: arb.ms } : { ok: false, ms: arb.ms, error: arb.error },
      dex: dex.ok ? { ok: true, ms: dex.ms } : { ok: false, ms: dex.ms, error: dex.error },
      flow: flow.ok ? { ok: true, ms: flow.ms } : { ok: false, ms: flow.ms, error: flow.error },
    },
    grid: g,
    arb: a,
    dex: x,
    flow: f,
    quant: {
      openTotalSbd: Math.round(openTotalSbd * 100) / 100,
      exposureSkewPct: skew,
      fillsTotal: (g?.fillsBuy ?? 0) + (g?.fillsSell ?? 0),
      arbFillsTotal: Object.values(a?.fillsByHand ?? {}).reduce((x, y) => x + y, 0),
      arbHandsActive: a?.expansion?.handsActive ?? null,
      arbMtmPnlMu: a?.mtmPnlMu ?? null,
    },
  }
}
