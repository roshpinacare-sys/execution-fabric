// ===== מועצת-השולחן — המוח-המייעץ (LLM) =====
// צינור-AutoHedge מותאם: Director מקבל ראיות-כמותיות-חתומות + פסק-מנהל-הסיכון
// ומייצר כרטיס-החלטה: תזת-פרי, תזת-דוב, סיכון-כמותי, הנחיות-ייעודיות, שוברי-תזה.
// חוק-ברזל: המועצה-מייעצת-בלבד — אף-פקודה-שידור-אינה-יוצאת-מכאן.

import ZAI from 'z-ai-web-dev-sdk'
import type { EvidenceBundle } from './evidence'
import type { GovernorRuling } from './governor'

export type CouncilCard = {
  id: number
  at: string
  verdict: string // פסק-המועצה (עברית-קצרה)
  confidence: number | null // 0-1
  thesisBull: string
  thesisBear: string
  risk: string
  directives: string[]
  thesisBreakers: string[]
  dataGaps: string[]
  raw: string
  llmMs: number
}

const SYSTEM = `אתה מועצת-השולחן הריבונית של אורגניזם-מסחר-אוטונומי על דקס-עצמאי (Steem/SBD + שווקי-הדקס).

הצינור שקדם לך: מנתח-כמותי (מספרים-אמיתיים-מהאיברים) → דופק-שוק (נגזר-מהתנהגות-הספר) → מנהל-סיכון-מכני (פסק-קשיח). אתה ה-Director.

חוקי-המשמעת (מוטמעים, אין-להפר):
1. שני-הצדדים-תמיד: תזת-פרי ותזת-דוב בריגורות-שווה. תמיכה-בצד-אחד-בלבד היא-שיווק.
2. תזה-ניתנת-להפרכה: לכל-פסק — שוברי-תזה מדידים (מספרים/אירועים-שיהפכו-אותו).
3. כמת-את-החסרון: תרחיש-חסרון-עם-גודל-מדיד, לא-"אפשר-לרדת".
4. הנחות-לפני-מסקנות: הנחות-מפורשות + רשימת-נתונים-חסרים.
5. אין-דיוק-כוזב: אין-להמציא-מספרים-שלא-בראיות; אם-מקור-מת — אמור-זאת.
6. ייעוץ-בלבד: אינך-יורה-פקודות. הנחיותיך הן-ייעוץ-למפעיל-ולמנהל-המכני.
7. עברית-תמציתית-וברורה. אפס-קלישאות.

עליך-להשיב JSON תקין-בלבד, בלי-שום-טקסט-חוץ-מה-JSON, במבנה:
{"verdict": "משפט-עברי-קצר-של-פסק-הדין",
 "confidence": 0-1,
 "thesisBull": "תזת-הפרי — הראיות-שתומכות",
 "thesisBear": "תזת-הדוב — הראיות-שמנגדות באותה-ריגורות",
 "risk": "החסרון-הכמותי: מה-יכול-להישבר-ובאיזה-גודל",
 "directives": ["הנחיה-ייעודית-1", "הנחיה-ייעודית-2"],
 "thesisBreakers": ["שובר-תזה-מדיד-1", "שובר-תזה-מדיד-2"],
 "dataGaps": ["מה-חסר-לך-בראיות-ולמה-זה-משנה"]}`

function evidencePrompt(e: EvidenceBundle, r: GovernorRuling): string {
  const compact = {
    at: e.at,
    מקורות: e.sources,
    גריד: e.grid && {
      מחיר: e.grid.price,
      מצב: e.grid.mode,
      מושהה: e.grid.halted ? e.grid.haltReason : false,
      כשלים-רצופים: e.grid.consecutiveErrors,
      פקודות-קנייה: { מספר: e.grid.openBuys, שוויSBD: e.grid.openBuySbd },
      פקודות-מכירה: { מספר: e.grid.openSells, שוויSBD: e.grid.openSellValueSbd },
      מימושים: { קנייה: e.grid.fillsBuy, מכירה: e.grid.fillsSell },
      רווח-צל: e.grid.shadowPnlSbd,
    },
    ארב: e.arb,
    דקס: e.dex && { שווקים: e.dex.markets, שדות-חיים: e.dex.okFields },
    זרימה: e.flow,
    כמותי: e.quant,
    מנהל-הסיכון: { פסק: r.verdict, ממצאים: r.findings, ספים: r.thresholds },
  }
  return `ראיות-חיות-חתומות מאיברי-האורגניזם (JSON):\n${JSON.stringify(compact, null, 1)}\n\nהפק-את-כרטיס-המועצה-לפי-המבנה. זכור: שני-הצדדים, שוברי-תזה-מדידים, חסרון-כמותי, הנחות-מפורשות.`
}

export async function deliberate(e: EvidenceBundle, r: GovernorRuling): Promise<CouncilCard | { ok: false; error: string; llmMs: number }> {
  const t0 = Date.now()
  let lastErr = 'לא-נודע'
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const zai = await ZAI.create()
      const completion = await zai.chat.completions.create({
        messages: [
          { role: 'assistant', content: SYSTEM },
          { role: 'user', content: evidencePrompt(e, r) },
        ],
        thinking: { type: 'disabled' },
      })
      const raw = completion.choices[0]?.message?.content ?? ''
      if (!raw.trim()) throw new Error('תשובה-ריקה')
      const card = parseCard(raw, Date.now() - t0)
      return card
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      if (attempt < 2) await new Promise((res) => setTimeout(res, 1_500))
    }
  }
  return { ok: false, error: lastErr, llmMs: Date.now() - t0 }
}

function parseCard(raw: string, llmMs: number): CouncilCard {
  // חילוץ-הגנתי: ה-JSON הראשון-בטקסט (סובל-מרקע-קל)
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const jsonPart = start >= 0 && end > start ? raw.slice(start, end + 1) : '{}'
  let d: Record<string, unknown> = {}
  try {
    d = JSON.parse(jsonPart) as Record<string, unknown>
  } catch {
    /* כנות — כרטיס-גולמי */
  }
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 6) : []
  const conf = typeof d.confidence === 'number' && d.confidence >= 0 && d.confidence <= 1 ? Math.round(d.confidence * 100) / 100 : null
  return {
    id: 0,
    at: new Date().toISOString(),
    verdict: typeof d.verdict === 'string' ? d.verdict.slice(0, 200) : 'פסק-לא-נותח — כרטיס-גולמי-נשמר',
    confidence: conf,
    thesisBull: typeof d.thesisBull === 'string' ? d.thesisBull.slice(0, 1_200) : '',
    thesisBear: typeof d.thesisBear === 'string' ? d.thesisBear.slice(0, 1_200) : '',
    risk: typeof d.risk === 'string' ? d.risk.slice(0, 1_200) : '',
    directives: arr(d.directives),
    thesisBreakers: arr(d.thesisBreakers),
    dataGaps: arr(d.dataGaps),
    raw: raw.slice(0, 4_000),
    llmMs,
  }
}
