// ===== saos-grid — איבר-הגריד :3070 =====
// גוף-אחד-חכם-עם-הרבה-ידיים: מנוע-גריד על שוק-הפנים של Steem (STEEM/SBD),
// צי-חשבונות-מהכספת, אפס-דריסות-בין-ידיים, צל→חי אוטומטי, כנות-מלאה.

import * as engine from './engine'
import * as ff from './ff'

const PORT = Number(process.env.PORT ?? 3070)
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 45_000)

let startedAt = new Date().toISOString()
let bootMs = Date.now()

async function tickCycle(): Promise<void> {
  try {
    const r = await engine.cycle()
    if (r.placed || r.canceled || r.filledShadow || r.decisions.length) {
      console.log(
        `[saos-grid] מחזור: הצבות=${r.placed} ביטולים=${r.canceled} מימושי-צל=${r.filledShadow} | ${r.decisions.slice(0, 3).join(' | ')}`,
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
