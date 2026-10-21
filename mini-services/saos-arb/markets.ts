// ===== שער-כשירות-שווקים — הרחבת-השוק-הריבוני במדידה-ולא-באמונה =====
// דפוס-מ-AutoHedge (autohedge/tools/jupiter_search.py): סינון-שווקים-לפי-איכות-מדידה
// (liquidity / organicScore / isVerified). ההתאמה-הריבונית: האיכות-כאן-נמדדת-רק-מהספר-
// שלנו-עצמו (עומק, פרישה, יציבות-מגע) — אף-שירות-חוץ, אף-ניקוד-מומצא.
// כלל-הברזל: שער-כנות — שוק-שלא-עובר-אינו-נפתח; שוק-שעובר-נפתח-ביד-קטנה-ומתויגת.

export type MarketRow = {
  base: string
  quote: string
  fair: number
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number
  poolMid?: number
}

export type GateVerdict = 'mm' | 'depth' | 'off'

export type MarketGate = {
  base: string
  quote: string
  fair: number
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number
  twoSided: boolean
  verdict: GateVerdict
  reasons: string[]
  scoredAt: string
}

// ספי-השער (מקבילות-מדידות-של-סינון-AutoHedge):
//   · פרישה-מקסימלית לשוק-מייקר-דו-צדדי: 1500bps (מעל-זה — עומק-חסר-ערך-למכירה)
//   · פרישה-מינימלית: 5bps (מתחת-זה — אין-חדר-רווח למייקר)
//   · מגע-מינימלי: fair>0 (אפס-מחיר = אין-שוק)
const MAX_MM_SPREAD_BPS = 1_500
const MIN_MM_SPREAD_BPS = 5

export function gateMarkets(markets: MarketRow[]): MarketGate[] {
  const at = new Date().toISOString()
  return markets.map((m) => {
    const reasons: string[] = []
    const fairOk = Number.isFinite(m.fair) && m.fair > 0
    const twoSided = !!m.bestBid && m.bestBid > 0 && !!m.bestAsk && m.bestAsk > 0
    if (!fairOk) reasons.push('אין-מגע-מחיר (fair=0) — שוק-כבוי')
    if (!twoSided) reasons.push('ספר-חד-צדדי — נדרש-בונה-עומק')
    let verdict: GateVerdict = 'off'
    if (fairOk && twoSided) {
      if (m.spreadBps >= MIN_MM_SPREAD_BPS && m.spreadBps <= MAX_MM_SPREAD_BPS) {
        verdict = 'mm'
        reasons.push(`דו-צדדי-צפוף (${m.spreadBps}bps) — יד-מייקר-מלאה-מאושרת`)
      } else {
        verdict = 'depth'
        reasons.push(
          m.spreadBps < MIN_MM_SPREAD_BPS
            ? `פרישה-${m.spreadBps}bps-צרה-מדי — אין-חדר-למייקר; בונה-עומק-בלבד`
            : `פרישה-${m.spreadBps}bps-רחבה-מדי — בונה-עומק-עד-התכווצות`,
        )
      }
    } else if (fairOk) {
      verdict = 'depth'
    }
    return {
      base: m.base,
      quote: m.quote,
      fair: m.fair,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      spreadBps: m.spreadBps,
      twoSided,
      verdict,
      reasons,
      scoredAt: at,
    }
  })
}

export function gateSummary(gates: MarketGate[]): {
  total: number
  twoSided: number
  oneSided: number
  off: number
  mmMarkets: string[]
  depthMarkets: string[]
  avgTwoSidedSpreadBps: number | null
} {
  const mm = gates.filter((g) => g.verdict === 'mm')
  const depth = gates.filter((g) => g.verdict === 'depth')
  const spreads = gates.filter((g) => g.twoSided).map((g) => g.spreadBps)
  return {
    total: gates.length,
    twoSided: gates.filter((g) => g.twoSided).length,
    oneSided: gates.filter((g) => !g.twoSided && g.verdict !== 'off').length,
    off: gates.filter((g) => g.verdict === 'off').length,
    mmMarkets: mm.map((g) => `${g.base}/${g.quote}`),
    depthMarkets: depth.map((g) => `${g.base}/${g.quote}`),
    avgTwoSidedSpreadBps: spreads.length ? Math.round(spreads.reduce((a, b) => a + b, 0) / spreads.length) : null,
  }
}
