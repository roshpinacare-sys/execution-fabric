// ===== saos-grid — איבר-הגריד :3070 =====
// גוף-אחד-חכם-עם-הרבה-ידיים: מנוע-גריד על שוק-הפנים של Steem (STEEM/SBD),
// צי-חשבונות-מהכספת, אפס-דריסות-בין-ידיים, צל→חי אוטומטי, כנות-מלאה.
//
// Task-114: הייבוא-הראשון-חייב-להיות-מתקין-ה-shim-של-secp256k1 (pure-JS) —
// ה-binding-ה-native ממית-את-התהליך-תחת-Bun-בשידור-הראשון; התיקון-חי-בגיט
// ומיישם-את-עצמו-בכל-אתחול (חוק-עץ-נצחי).
import './lib/install-secp-shim.cjs'

import * as engine from './engine'
import * as ff from './ff'
import * as market from './market'

const PORT = Number(process.env.PORT ?? 3070)
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 45_000)

let startedAt = new Date().toISOString()
let bootMs = Date.now()

async function tickCycle(): Promise<void> {
  try {
    const r = await engine.cycle()
    if (r.placed || r.canceled || r.filledShadow || r.filledLive || r.decisions.length) {
      console.log(
        `[saos-grid] מחזור: הצבות=${r.placed} ביטולים=${r.canceled} מימושי-צל=${r.filledShadow} מילויים-חיים=${r.filledLive} | ${r.decisions.slice(0, 3).join(' | ')}`,
      )
    }
  } catch (e) {
    console.log(`[saos-grid] כשל-מחזור: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    try {
      if (p === '/health') {
        return Response.json({
          ok: true,
          service: 'saos-grid',
          port: PORT,
          startedAt,
          uptimeMs: Date.now() - bootMs,
          mode: engine.mode(),
          fingerprint: engine.fingerprint(),
          halted: engine.haltInfo().halted,
          cycles: engine.stats.cycles,
          lastCycleAt: engine.stats.lastCycleAt,
          lastError: engine.stats.lastError,
          price: engine.stats.price,
          // Task-118: אמת-פאריטי-ומסילה-חוצה חיים-בבריאות — הבעלים רואה למה הווליום היכן-שהוא
          identityLine: engine.stats.identityLine,
          floor: engine.stats.floor,
          spreadToParityPct: engine.stats.price !== null && engine.stats.floor !== null
            ? ((engine.stats.floor - engine.stats.price) / engine.stats.price) * 100
            : null,
          ffRail: engine.stats.ffRail,
        })
      }
      if (p === '/grid') {
        const s = engine.summary()
        return Response.json({ ok: true, ...s })
      }
      if (p === '/ff') {
        return Response.json({ ok: true, ff: await ff.probe() })
      }
      if (p === '/halt' && req.method === 'POST') {
        engine.halt('בקשת-עצירה-ידנית', false)
        return Response.json({ ok: true, halted: true })
      }
      if (p === '/resume' && req.method === 'POST') {
        engine.resume()
        return Response.json({ ok: true, halted: false })
      }
      if (p === '/cycle' && req.method === 'POST') {
        const r = await engine.cycle()
        return Response.json({ ok: true, ...r })
      }
      if (p === '/backtest') {
        // Task-107 — backtest-מדיד (דפוס-AutoHedge backtest_market_maker, הותאם):
        // מהלך-על-היסטוריית-עסקאות-אמיתית-מהשרשרת ומדיד-תשואת-הגריד.
        // כנות: זו-הדמייה-על-נתוני-עבר — מתויג-ככזה, אין-הבטחת-עתיד.
        const u = new URL(req.url)
        const stepPct = Math.min(3, Math.max(0.3, parseFloat(u.searchParams.get('stepPct') ?? '') || 0.75))
        const sizeSbd = Math.min(50, Math.max(1, parseFloat(u.searchParams.get('sizeSbd') ?? '') || 5))
        const tradesRes = await market.getRecentTrades(1000)
        if (!tradesRes.ok) return Response.json({ ok: false, error: `שוק-לא-נקרא: ${tradesRes.error}` }, { status: 502 })
        const trades = [...tradesRes.data]
          .map((t) => ({ price: t.price, amount: t.amount, at: String(t.at ?? '') }))
          .sort((a, b) => a.at.localeCompare(b.at)) // כרונולוגי
        if (trades.length < 20) return Response.json({ ok: false, error: `נתונים-דלים (${trades.length} עסקאות) — מסרב-להסיק-מעטים` }, { status: 502 })
        let anchor = trades[0].price
        let quote = 100 // סל-הדמיה: 100 SBD
        let buyLevel = anchor * (1 - stepPct / 100)
        let sellLevel = anchor * (1 + stepPct / 100)
        let heldCost = 0
        let heldSteem = 0
        let buys = 0
        let sells = 0
        let realized = 0
        const last = trades[trades.length - 1].price
        for (const t of trades) {
          if (heldSteem === 0 && t.price <= buyLevel && quote >= sizeSbd) {
            const spend = sizeSbd
            quote -= spend
            heldCost = spend
            heldSteem = spend / t.price
            buys++
            sellLevel = t.price * (1 + (stepPct * 2) / 100) // רשת: מכירה-נגדית-מעל
            buyLevel = t.price * (1 - stepPct / 100)
          } else if (heldSteem > 0 && t.price >= sellLevel) {
            const proceeds = heldSteem * t.price
            quote += proceeds
            realized += proceeds - heldCost
            heldSteem = 0
            sells++
            buyLevel = t.price * (1 - stepPct / 100)
          } else if (heldSteem === 0 && Math.abs(t.price - anchor) / anchor > 0.03) {
            // רי-עיגון: המחיר-נדד-3% — הסולם-מתיישר (דפוס-קיזוז-הסטיות-של-המנוע)
            anchor = t.price
            buyLevel = anchor * (1 - stepPct / 100)
          }
        }
        const openValue = heldSteem * last
        return Response.json({
          ok: true,
          label: 'הדמייה-על-היסטוריה-אמיתית — מדידה, לא-הבטחה',
          window: { from: trades[0].at || null, to: trades[trades.length - 1].at || null, trades: trades.length, priceFrom: trades[0].price, priceTo: last },
          params: { stepPct, sizeSbd, seedSbd: 100 },
          result: {
            buys,
            sells,
            realizedSbd: Math.round(realized * 1000) / 1000,
            openPositionSbd: Math.round(openValue * 1000) / 1000,
            unrealizedSbd: Math.round((openValue - heldCost) * 1000) / 1000,
            equitySbd: Math.round((quote + openValue) * 1000) / 1000,
            returnPct: Math.round(((quote + openValue - 100) / 100) * 10000) / 100,
          },
        })
      }
      return Response.json({ ok: false, error: 'not found' }, { status: 404 })
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  },
})

console.log(`[saos-grid] חי על :${PORT} — מנוע-גריד STEEM/SBD; מחזור כל ${CYCLE_MS / 1000}ש'; מצב: ${engine.mode()}; ידיים: ${engine.fingerprint()}`)
console.log(`[saos-grid] כספת: upload/steem.env (תבנית: steem.env.template) — נחתמו-מפתחות? עובר-לחיים-אוטומטית`)

setInterval(() => void tickCycle(), CYCLE_MS)
// מחזור-ראשון-מיידי (לקח-Task-103: אין-המתנה-בפעם-הראשונה)
setTimeout(() => void tickCycle(), 3_000)
