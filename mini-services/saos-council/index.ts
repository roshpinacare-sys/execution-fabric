// Task-120: רילוד-היגיינה — החיבור-להלן חייב-להיפתח-על inode חי; אחרי-פעולות-git על קבצי-מצב: העתק-WAL/SHM מה-fd החי ואז שנה-תוכן-קובץ-זה (לא touch) לרילוד.
// ===== saos-council — מועצת-השולחן הריבונית :3072 =====
// המוח-המייעץ-של-האורגניזם: ראיות-חיות מכל-איבר → פסק-מכני-קשיח (מנהל-הסיכון)
// → מועצת-Director (LLM, ייעוץ-בלבד) → כרטיס-החלטה-חתום-ועמיד.
// ארכיטקטורה-מאומצת: צינור-AutoHedge (Director→Quant→Sentiment→Risk→Execution)
// + חוקי-משמעת-מ-agency-agents (finance) — הכל-מותאם-לריבונות ולכנות-המלאה.
// חוק-ברזל: המועצה-אינה-יורה-פקודות-שידור; היא-מייעצת ומדווחת. רק-מנהל-הסיכון
// המכני רשאי-להשתיק-איבר — ורק-מטעמים-קשיחים-מתועדים.

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gatherEvidence, type EvidenceBundle } from './evidence'
import { rule, type GovernorRuling } from './governor'
import { deliberate, type CouncilCard } from './council'

const PORT = Number(process.env.PORT ?? 3072)
const EVIDENCE_MS = Number(process.env.EVIDENCE_MS ?? 60_000) // סבב-ראיות (חינם) — כל-דקה
const COUNCIL_MS = Number(process.env.COUNCIL_MS ?? 600_000) // מועצת-LLM — כל-10דק' (עלות-חסומה)
const HALT_COOLDOWN_MS = 3_600_000 // השתקה-מכנית: לכל-היותר-פעם-בשעה

mkdirSync(join(import.meta.dir, 'state'), { recursive: true })
const db = new Database(join(import.meta.dir, 'state', 'council.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec(`CREATE TABLE IF NOT EXISTS council_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  verdict TEXT NOT NULL,
  confidence REAL,
  payload TEXT NOT NULL
)`)
db.exec(`CREATE TABLE IF NOT EXISTS council_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,   -- evidence|council|governor|action|error
  detail TEXT
)`)
function ev(kind: string, detail: string): void {
  db.query('INSERT INTO council_events(at,kind,detail) VALUES(?,?,?)').run(new Date().toISOString(), kind, detail.slice(0, 500))
}

// ── מצב-חי ───────────────────────────────────────────────────────────────────
const state = {
  startedAt: new Date().toISOString(),
  evidenceCycles: 0,
  councilCycles: 0,
  lastEvidence: null as EvidenceBundle | null,
  lastRuling: null as GovernorRuling | null,
  lastCard: null as CouncilCard | null,
  lastCardError: null as string | null,
  lastCouncilAt: null as string | null,
  lastEvidenceAt: null as string | null,
  lastEvidenceMs: 0,
  lastCouncilMs: 0,
  lastGovernorVerdict: null as string | null,
  dexFailStreak: 0,
  mechanicalHaltCount: 0,
  lastMechanicalHaltAt: 0,
  errors: 0,
  lastError: null as string | null,
}

// ── פעולות-מכניות-מוגבלות ────────────────────────────────────────────────────
async function mechanicalHaltArb(reason: string): Promise<void> {
  if (Date.now() - state.lastMechanicalHaltAt < HALT_COOLDOWN_MS) {
    ev('action', `עצירה-מכנית-נמנעה (cooldown): ${reason}`)
    return
  }
  state.lastMechanicalHaltAt = Date.now()
  state.mechanicalHaltCount++
  try {
    const res = await fetch('http://127.0.0.1:3071/halt', { method: 'POST', signal: AbortSignal.timeout(4_000) })
    ev('action', `השתקה-מכנית-של-הארב (${res.ok ? 'OK' : `HTTP-${res.status}`}): ${reason}`)
  } catch (e) {
    ev('action', `כשל-השתקת-ארב: ${e instanceof Error ? e.message : String(e)} — דווח-בכנות`)
  }
}

// ── סבב-ראיות + פסק-המנהל ───────────────────────────────────────────────────
async function evidenceCycle(): Promise<void> {
  const t0 = Date.now()
  try {
    const e = await gatherEvidence()
    state.lastEvidenceMs = Date.now() - t0
    state.lastEvidence = e
    state.lastEvidenceAt = e.at
    state.evidenceCycles++
    state.dexFailStreak = e.sources.dex.ok ? 0 : state.dexFailStreak + 1

    const arbHalted = e.arb?.halted === true
    const { ruling, actions } = rule(e, state.dexFailStreak, arbHalted)
    state.lastRuling = ruling
    state.lastGovernorVerdict = ruling.verdict
    for (const a of actions) {
      if (a.kind === 'halt-arb') void mechanicalHaltArb(a.detail)
    }
    ev('evidence', `פסק=${ruling.verdict} | מקורות: grid=${e.sources.grid.ok} arb=${e.sources.arb.ok} dex=${e.sources.dex.ok} flow=${e.sources.flow.ok} | ${ruling.findings[0] ?? ''}`)
    state.lastError = null
  } catch (err) {
    state.errors++
    state.lastError = err instanceof Error ? err.message : String(err)
    ev('error', state.lastError)
  }
}

// ── סבב-מועצה (ראיות-טריות → מנהל → LLM → כרטיס) ────────────────────────────
async function councilCycle(): Promise<void> {
  try {
    // ראיות-טריות-ברגע-ההכרעה (לא-מקרר-ישן)
    const e = state.lastEvidence && Date.now() - new Date(state.lastEvidence.at).getTime() < 45_000 ? state.lastEvidence : await (async () => {
      await evidenceCycle()
      return state.lastEvidence
    })()
    if (!e) throw new Error('אין-ראיות — המועצה-מסרבת-להכריע-בעיוורון (fail-closed)')
    const ruling = state.lastRuling ?? rule(e, state.dexFailStreak, e.arb?.halted === true).ruling

    state.councilCycles++
    state.lastCouncilAt = new Date().toISOString()
    const res = await deliberate(e, ruling)
    if ('ok' in res && res.ok === false) {
      state.lastCardError = res.error
      state.lastCouncilMs = res.llmMs
      ev('council', `כשל-מועצה: ${res.error} (${res.llmMs}ms)`)
      return
    }
    const card = res as CouncilCard
    state.lastCardError = null
    state.lastCouncilMs = card.llmMs
    // אכיפת-פרוטוקול-ההסלמה (Task 108 — NEXUS §11.3): פסק-danger בלי-בלוק-הסלמה
    // מוזרק-מכנית-מהממצאים — אין-כרטיס-danger-שנמלט-מהכללים
    if (ruling.verdict === 'danger' && !card.escalation) {
      card.escalation = {
        severity: 'danger',
        trigger: ruling.findings.find((f) => f.startsWith('DANGER')) ?? ruling.findings[0] ?? '',
        resolutionOptions: card.directives.length ? card.directives : ['בחינת-שורש-בקוד-האיבר-הכושל', 'השתקה-מכנית-מוגבלת-ודיווח-בכנות'],
        authority: 'מנהל-הסיכון-המכני · הבעלים-לחריגות-חוץ',
        deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
      }
      ev('governor', `הסלמה-הוזרקה-מכנית (ה-Director-החסיר-אותה): ${card.escalation.trigger.slice(0, 120)}`)
    }
    const r = db.query('INSERT INTO council_cards(at,verdict,confidence,payload) VALUES(?,?,?,?)').run(
      card.at, card.verdict, card.confidence, JSON.stringify(card),
    )
    card.id = Number(r.lastInsertRowid)
    state.lastCard = card
    ev('council', `כרטיס-#${card.id}: פסק="${card.verdict.slice(0, 80)}" ביטחון=${card.confidence} (${card.llmMs}ms)`)
  } catch (err) {
    state.errors++
    state.lastError = err instanceof Error ? err.message : String(err)
    ev('error', state.lastError)
  }
}

// ── השרת ─────────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const p = new URL(req.url).pathname
    try {
      if (p === '/health') {
        return Response.json({
          ok: true,
          service: 'saos-council',
          port: PORT,
          startedAt: state.startedAt,
          role: 'מועצת-השולחן הריבונית: ראיות→מנהל-מכני→Director-LLM (ייעוץ-בלבד)',
          evidenceCycles: state.evidenceCycles,
          councilCycles: state.councilCycles,
          lastEvidenceAt: state.lastEvidenceAt,
          lastEvidenceMs: state.lastEvidenceMs,
          lastCouncilAt: state.lastCouncilAt,
          lastCouncilMs: state.lastCouncilMs,
          governorVerdict: state.lastGovernorVerdict,
          cardId: state.lastCard?.id ?? null,
          lastCardError: state.lastCardError,
          mechanicalHalts: state.mechanicalHaltCount,
          errors: state.errors,
          lastError: state.lastError,
          sources: state.lastEvidence?.sources ?? null,
        })
      }
      if (p === '/state') {
        return Response.json({
          ok: true,
          startedAt: state.startedAt,
          evidenceCycles: state.evidenceCycles,
          councilCycles: state.councilCycles,
          lastEvidence: state.lastEvidence,
          ruling: state.lastRuling,
          lastCard: state.lastCard,
          lastCardError: state.lastCardError,
          lastCardAt: state.lastCard?.at ?? null,
          lastGovernorVerdict: state.lastGovernorVerdict,
          mechanicalHalts: state.mechanicalHaltCount,
          errors: state.errors,
          lastError: state.lastError,
        })
      }
      if (p === '/cards') {
        const rows = db.query('SELECT id, at, verdict, confidence, payload FROM council_cards ORDER BY id DESC LIMIT 12').all() as Array<{ id: number; at: string; verdict: string; confidence: number | null; payload: string }>
        return Response.json({
          ok: true,
          cards: rows.map((r) => {
            try {
              return { ...JSON.parse(r.payload), id: r.id }
            } catch {
              return { id: r.id, at: r.at, verdict: r.verdict, confidence: r.confidence, raw: r.payload.slice(0, 400) }
            }
          }),
        })
      }
      if (p === '/cycle' && req.method === 'POST') {
        await evidenceCycle()
        return Response.json({ ok: true, verdict: state.lastGovernorVerdict, evidence: state.lastEvidenceAt })
      }
      if (p === '/deliberate' && req.method === 'POST') {
        void councilCycle().then(() => ev('council', 'מועצה-מיידית-בדרישה-הושלמה'))
        return Response.json({ ok: true, note: 'מועצה-מוזנקת — הכרטיס-יחי-ב-/state תוך-דקות' })
      }
      return Response.json({ ok: false, error: 'not found' }, { status: 404 })
    } catch (e) {
      return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  },
})

console.log(`[saos-council] חי על :${server.port} — מועצת-השולחן הריבונית (AutoHedge-צינור מותאם + agency-agents-משמעת)`)
console.log(`[saos-council] ראיות-כל-${EVIDENCE_MS / 1000}ש' · מועצת-LLM-כל-${COUNCIL_MS / 60_000}דק' · ייעוץ-בלבד, אף-פקודה-לא-יוצאת-מכאן`)

// לקח-Task-103: אין-המתנה-בפעם-הראשונה
setTimeout(() => void evidenceCycle(), 3_000)
setTimeout(() => void councilCycle(), 25_000)
setInterval(() => void evidenceCycle(), EVIDENCE_MS)
setInterval(() => void councilCycle(), COUNCIL_MS)
