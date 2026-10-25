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
import { broadcast, buildHeader, harvestPulse, harvestState } from './harvest-engine'
import { executeGrowthPulse, type FleetGrowthState } from './fleet-growth'
import { dripPlan, type DripTransfer } from './soldier-drip'
import { hiveCustodyCheck, hiveMeshFromEnv } from './hive-tx'
import * as market from './market'
import { steemMesh } from './market'
import { OP_TRANSFER, buildTxBytes, serializeOperation, signTxBytes } from './steem-tx'
import { organAuth } from '../organ-auth'

const PORT = Number(process.env.PORT ?? 3070)
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 45_000)

let startedAt = new Date().toISOString()
let bootMs = Date.now()

// ── Task-137 §2: מנוע-צמיחת-הצי (claim→create→delegate→כספת — אפס-דלק-חוץ) ──
const fleetGrowth: FleetGrowthState = { soldiers: [], created: 0, delegated: 0, lastCycleAt: null, lastError: null, lastResult: 'טרם-רץ', running: false }
const GROWTH_MAX_NEW = Math.max(1, Math.min(3, Number(process.env.SAOS_GROWTH_MAX_NEW ?? 1)))

// ── Task-137 §2: רכבת-הדבורה (Hive) — מדידה-חיה-עם-שער-כספת-כנה ──
const hiveMesh = hiveMeshFromEnv()
let hiveState: { custody: { ok: boolean; pubkey: string | null; error: string | null; authorityPubkeys: string[] | null } | null; checkedAt: string | null; lastError: string | null } = { custody: null, checkedAt: null, lastError: null }

// ══ דירקטיבת-בעלים 25/10 §3: טפטוף-הון-אוצר→חיילים ═══════════════════════════
// השורש-הנמדד-חי (16:00Z): לחיילים-מפתחות-טעונים-אך-0.000 STEEM/SBD → המנוע-מדלג-בכנות.
// התיקון: טפטוף-מדוד-מהאוצר (רזרבה-קודשת 10%) — SBD-קודם (קנייה-חיה-זולה), STEEM-שני (מכירה-חיה).
// כל-העברה: חתימה-ACTIVE-של-האוצר → שידור-סינכרוני → קריאה-חוזרת-מהשרשרת-בטרם-נספרת.
interface DripState {
  cycles: number
  lastPulseAt: string | null
  lastResult: Record<string, unknown> | null
  transfersBroadcast: number
  lastError: string | null
}
const dripState: DripState = { cycles: 0, lastPulseAt: null, lastResult: null, transfersBroadcast: 0, lastError: null }
let dripRunning = false // נעילת-בודד (Task-138): ידני+אוטומטי אף-פעם-לא-רצים-במקביל — אפס-טפטוף-כפול
const DRIP_RESERVE_PCT = Number(process.env.SAOS_DRIP_RESERVE_PCT ?? 10)
const DRIP_BUY_TARGET_MU = Number(process.env.SAOS_DRIP_BUY_TARGET_MU ?? 150) // 0.150 SBD
const DRIP_SELL_TARGET_MU = Number(process.env.SAOS_DRIP_SELL_TARGET_MU ?? 600) // 0.600 STEEM
const DRIP_MAX_TRANSFERS = Number(process.env.SAOS_DRIP_MAX_TRANSFERS ?? 6)

function parseChainAsset(s: string | undefined): number {
  const v = parseFloat(String(s ?? '0'))
  return Number.isFinite(v) ? Math.round(v * 1000) : 0
}

async function dripBalances(names: string[]): Promise<Record<string, { steemMu: number; sbdMu: number }> | { error: string }> {
  const r = await steemMesh.call<Array<Record<string, string>>>('condenser_api.get_accounts', [names])
  if (!r.ok) return { error: `get_accounts: ${r.error}` }
  const out: Record<string, { steemMu: number; sbdMu: number }> = {}
  for (const a of r.data ?? []) out[a.name] = { steemMu: parseChainAsset(a.balance), sbdMu: parseChainAsset(a.sbd_balance) }
  return out
}

async function executeDripPulse(): Promise<void> {
  if (dripRunning) {
    dripState.lastResult = { status: 'skipped — פעימה-קודמת-עוד-בריצה (נעילת-בודד)' }
    return
  }
  dripRunning = true
  try {
    await executeDripPulseInner()
  } finally {
    dripRunning = false
  }
}

async function executeDripPulseInner(): Promise<void> {
  dripState.cycles++
  dripState.lastPulseAt = new Date().toISOString()
  try {
    const names = engine
      .fingerprint()
      .split(',')
      .map((s) => s.split(':')[0].trim())
      .filter(Boolean)
    if (names.length < 2) {
      dripState.lastResult = { status: 'no-soldiers (חיילים-נולדים-דרך-צמיחת-הצי-קודם)' }
      return
    }
    const bals = await dripBalances(names)
    if ('error' in bals) {
      dripState.lastError = bals.error
      dripState.lastResult = { status: 'balances-error' }
      return
    }
    const treasury = names[0]
    const treasuryWifKey = `${treasury.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_ACTIVE_WIF`
    const envRaw = (await import('fs')).readFileSync('/home/z/my-project/upload/steem.env', 'utf-8')
    const activeWif = envRaw.match(new RegExp(`${treasuryWifKey}=(\\S+)`))?.[1] ?? null
    if (!activeWif) {
      dripState.lastError = 'custody-gated: אין-ACTIVE-WIF-לאוצר'
      dripState.lastResult = { status: 'custody-gated' }
      return
    }
    const plan = dripPlan({
      treasury: { steemMu: bals[treasury]?.steemMu ?? 0, sbdMu: bals[treasury]?.sbdMu ?? 0 },
      soldiers: names.slice(1).map((n) => ({ name: n, steemMu: bals[n]?.steemMu ?? 0, sbdMu: bals[n]?.sbdMu ?? 0 })),
      reservePct: DRIP_RESERVE_PCT,
      buySideTargetSbdMu: DRIP_BUY_TARGET_MU,
      sellSideTargetSteemMu: DRIP_SELL_TARGET_MU,
      maxTransfersPerPulse: DRIP_MAX_TRANSFERS,
    })
    const executed: Record<string, unknown>[] = []
    for (const t of plan.transfers as DripTransfer[]) {
      const header = await buildHeader()
      if ('error' in header) {
        dripState.lastError = header.error
        break
      }
      const sym = t.asset
      const chainAmount = `${(t.amountMu / 1000).toFixed(3)} ${sym}`
      const opData = { from: treasury, to: t.to, amount: t.amountMu, symbol: sym, memo: 'fleet-drip §3 — דלק-מסחר לחייל (רזרבת-אוצר-קודשת)' }
      const tx = buildTxBytes(header, [serializeOperation(OP_TRANSFER, opData)])
      const signed = signTxBytes(tx, activeWif)
      const b = await broadcast(signed, header, [
        ['transfer', { from: treasury, to: t.to, amount: chainAmount, memo: opData.memo }],
      ])
      if (!b.ok) {
        executed.push({ to: t.to, asset: sym, amountMu: t.amountMu, status: 'rejected', error: b.error })
        dripState.lastError = `transfer-broadcast: ${b.error}`
        continue
      }
      // קריאה-חוזרת: יתרת-הנמען-חייבת-לשקף (אימות-לאחר-מעשה — דפוס-הקציר)
      const after = await dripBalances([t.to])
      const got = 'error' in after ? null : after[t.to]?.[sym === 'STEEM' ? 'steemMu' : 'sbdMu'] ?? null
      const verified = got !== null && got > 0
      if (verified) dripState.transfersBroadcast++
      executed.push({ to: t.to, asset: sym, amountMu: t.amountMu, trxId: b.trxId ?? null, blockNum: b.blockNum ?? null, status: verified ? 'broadcast+verified' : 'broadcast-טרם-נמדד-בקריאה-חוזרת (כנות)', recipientBalanceMu: got })
      console.log(`[saos-grid] טפטוף: ${t.amountMu / 1000} ${sym} → ${t.to} (${t.reason}) — ${verified ? 'נקרא-חזרה-מהשרשרת' : 'שודר'}`)
    }
    dripState.lastResult = { status: 'pulse-done', planSkipped: plan.skipped, executed }
    dripState.lastError = plan.transfers.length === 0 ? null : dripState.lastError
  } catch (e) {
    dripState.lastError = e instanceof Error ? e.message : String(e)
  }
}
async function hiveProbe(): Promise<void> {
  try {
    const env = (await import('fs')).readFileSync('/home/z/my-project/upload/steem.env', 'utf-8')
    const posting = env.match(/HEADCORNER_POSTING_WIF=(\S+)/)?.[1] ?? null
    const c = await hiveCustodyCheck(hiveMesh, 'headcorner', posting)
    hiveState = { custody: c, checkedAt: new Date().toISOString(), lastError: c.ok ? null : c.error }
  } catch (e) {
    hiveState.lastError = e instanceof Error ? e.message : String(e)
  }
}
async function growthPulse(): Promise<void> {
  try {
    await executeGrowthPulse(
      {
        vaultPath: '/home/z/my-project/upload/steem.env',
        log: (m) => console.log(`[saos-grid] ${m}`),
        random32: () => crypto.getRandomValues(new Uint8Array(32)),
        call: (m, p) => steemMesh.call(m, p),
        buildHeader,
        broadcast,
      },
      fleetGrowth,
      GROWTH_MAX_NEW,
    )
  } catch (e) {
    fleetGrowth.lastError = e instanceof Error ? e.message : String(e)
    fleetGrowth.running = false
  }
}

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

// Task-119: שומר-יחידות — פורט-תפוס = מנוע-אחר-כבר-חי-על-החשבון → יציאה-שקטה.
// הלקח-החי (00:24Z): מחזור-החייאה הזניק מפעיל-שני; מי-שהפסיד-את-הפורט נשאר-זומבי-עם-ידיים-על-הפנקס.
// מעתה: מפסיד-הפורט מת-מיד — מנוע-אחד-בלבד כותב-לחשבון-ולפנקס.
try {
  Bun.serve({
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
          // Task-135 §3 — בריאות-רשת-ה-RPC-המקומית (failover/שובר-מעגלים — מדידה-חיה)
          rpcMesh: market.meshHealth(),
          // Task-136 §1 — מנוע-הקציר-העצמי (קיורציה+פרסים — מדידה-חיה)
          harvest: harvestState,
          // Task-137 §2 — מנוע-צמיחת-הצי (חיילים-חדשים-מבפנים — מדידה-חיה; אף-מפתח-לא-נחשף)
          fleetGrowth: {
            soldiers: fleetGrowth.soldiers.map((s) => ({ name: s.name, createdAt: s.createdAt, delegatedVestsRaw: s.delegatedVestsRaw })),
            created: fleetGrowth.created,
            delegated: fleetGrowth.delegated,
            lastCycleAt: fleetGrowth.lastCycleAt,
            lastError: fleetGrowth.lastError,
            lastResult: fleetGrowth.lastResult,
            maxNewPerPulse: GROWTH_MAX_NEW,
            running: fleetGrowth.running,
          },
        })
      }
      if (p === '/harvest') {
        return Response.json({ ok: true, harvest: harvestState })
      }
      if (p === '/fleet-growth') {
        return Response.json({ ok: true, fleetGrowth })
      }
      if (p === '/fleet-drip') {
        return Response.json({ ok: true, drip: dripState })
      }
      if (p === '/fleet-drip/run' && req.method === 'POST') {
        const deny = organAuth(req)
        if (deny) return deny
        await executeDripPulse()
        return Response.json({ ok: true, drip: dripState })
      }
      if (p === '/fleet-growth/run' && req.method === 'POST') {
        const deny = organAuth(req)
        if (deny) return deny
        await growthPulse()
        return Response.json({ ok: true, fleetGrowth })
      }
      if (p === '/hive/state') {
        return Response.json({ ok: true, hive: { ...hiveState, mesh: hiveMesh.health() } })
      }
      if (p === '/hive/probe' && req.method === 'POST') {
        const deny = organAuth(req)
        if (deny) return deny
        await hiveProbe()
        return Response.json({ ok: true, hive: hiveState })
      }
      if (p === '/grid') {
        const s = engine.summary()
        return Response.json({ ok: true, ...s })
      }
      if (p === '/ff') {
        return Response.json({ ok: true, ff: await ff.probe() })
      }
      if (p === '/halt' && req.method === 'POST') {
        // Task-121 audit fix (fingerprint saos-grid:3070-mutating-endpoints-without-authority-check):
        // שער-סמכות — ה-bind-המקומי איננו גבול (שער-ה-Caddy מגיע אליו מבחוץ)
        const deny = organAuth(req)
        if (deny) return deny
        engine.halt('בקשת-עצירה-ידנית', false)
        return Response.json({ ok: true, halted: true })
      }
      if (p === '/resume' && req.method === 'POST') {
        const deny = organAuth(req)
        if (deny) return deny
        engine.resume()
        return Response.json({ ok: true, halted: false })
      }
      if (p === '/cycle' && req.method === 'POST') {
        const deny = organAuth(req)
        if (deny) return deny
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
} catch (e) {
  console.log(`[saos-grid] :${PORT} תפוס — מנוע-אחר-חי-כבר → יציאה-שקטה (Task-119: מנוע-יחיד, אין-כותב-כפול)`)
  process.exit(0)
}

console.log(`[saos-grid] חי על :${PORT} — מנוע-גריד STEEM/SBD; מחזור כל ${CYCLE_MS / 1000}ש'; מצב: ${engine.mode()}; ידיים: ${engine.fingerprint()}`)
console.log(`[saos-grid] כספת: upload/steem.env (תבנית: steem.env.template) — נחתמו-מפתחות? עובר-לחיים-אוטומטית`)

setInterval(() => void tickCycle(), CYCLE_MS)
// מחזור-ראשון-מיידי (לקח-Task-103: אין-המתנה-בפעם-הראשונה)
setTimeout(() => void tickCycle(), 3_000)

// ── Task-136 §1: פעימת-הקציר-העצמי — קציר-פרסים + קיורציה-חתומה, כל-15 דק' ──
const HARVEST_MS = Number(process.env.SAOS_HARVEST_MS ?? 15 * 60_000)
setInterval(() => {
  harvestPulse().catch((e) => {
    harvestState.lastError = e instanceof Error ? e.message : String(e)
  })
}, HARVEST_MS)
setTimeout(() => {
  harvestPulse().catch((e) => {
    harvestState.lastError = e instanceof Error ? e.message : String(e)
  })
}, 25_000)

// ── Task-137 §2: פעימת-צמיחת-הצי — חיילים-חדשים-מבפנים, כל-30 דק' (השרשרת-מחליטה-על-RC) ──
const GROWTH_MS = Number(process.env.SAOS_GROWTH_MS ?? 30 * 60_000)
setInterval(() => {
  void growthPulse()
}, GROWTH_MS)
setTimeout(() => {
  void growthPulse()
}, 40_000)

// ── דירקטיבת-בעלים 25/10 §3: פעימת-טפטוף-דלק-לחיילים — כל-30 דק' (האוצר-מחליט-על-רזרבה) ──
const DRIP_MS = Number(process.env.SAOS_DRIP_MS ?? 30 * 60_000)
setInterval(() => {
  void executeDripPulse()
}, DRIP_MS)
setTimeout(() => {
  void executeDripPulse()
}, 70_000) // אחרי-המחזור-הראשון-של-הגריד — שהידיים-כבר-טעונות

// ── Task-137 §2: סקר-כספת-דבורה כל-15 דק' — השער-נפתח-אוטומטית-כשמפתח-תקף-מופיע ──
const HIVE_PROBE_MS = Number(process.env.SAOS_HIVE_PROBE_MS ?? 15 * 60_000)
setInterval(() => {
  void hiveProbe()
}, HIVE_PROBE_MS)
setTimeout(() => {
  void hiveProbe()
}, 50_000)
