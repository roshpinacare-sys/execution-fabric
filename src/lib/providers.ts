import fs from 'fs'
import path from 'path'
import { sha256Short } from '@/lib/ledger'

// מסילות-ספק (worklog Task 17): מפתחות מהכספת, מאוחסנים ב-upload/llm.env (0600).
// חוקים: קריאת-ערכים בשרת-בלבד; אף ערך לא נכנס ללוג/תשובה/לדג'ר (מטא-דאטה בלבד);
// ספק לא-מאומת לא נכנס לסולם (IPAI — מזוהה-חלקית, 401 חי — מוצג ככזה בכנות).

const CACHE: { env: Record<string, string> | null } = { env: null }

export function loadLlmEnv(): Record<string, string> {
  if (CACHE.env) return CACHE.env
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'upload', 'llm.env'), 'utf8')
    const env: Record<string, string> = {}
    for (const m of raw.matchAll(/^([A-Za-z0-9_]+)=(.*)$/gm)) {
      env[m[1]] = m[2].trim()
    }
    CACHE.env = env
    return env
  } catch {
    CACHE.env = {}
    return CACHE.env
  }
}

export function nvidiaConfigured(): boolean {
  const env = loadLlmEnv()
  return Boolean(env.NVIDIA_API_KEY && env.NVIDIA_BASE_URL)
}

export function nvidiaPreferredModel(): string | null {
  const env = loadLlmEnv()
  const models = (env.NVIDIA_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // עדיף-המודל-שאומת-חי (Task 94): ultra-550b אומת-200-חי-אחרי-ש-super-120b נמחק-אצל-הספק.
  // הקריאות-עצמן-רצות-על-סולם-המודלים-המרפא-עצמו — כאן-תצוגה-בלבד.
  return models.find((m) => m.includes('ultra-550b')) ?? models[0] ?? null
}

const NVIDIA_TIMEOUT_MS = 90_000

// סולם-מודלים-מרפא-עצמו (Task 94): האמת-אצל-הספק משתנה — מודל-שמחזיר-404 "Function Not Found"
// נחתם-מת-לשעה-בזיכרון והקריאה עוברת-אוטומטית למודל-הבא-ב-NVIDIA_MODELS. אין-עוד-העדפה-קשיחה
// שמצהירה-חיים-על-מודל-מת (השקר-שנתפס-חי: super-120b נמחק-אצל-הספק-בעוד-המדריך-העדיף-אותו).
const NVIDIA_DEAD_MODEL_MS = 60 * 60_000
const nvidiaDeadModels = new Map<string, number>()

function nvidiaModelLadder(): string[] {
  const env = loadLlmEnv()
  return (env.NVIDIA_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ירי NVIDIA NIM אמיתי (OpenAI-compatible). זריקות נושאות סטטוס ל-classify.
// סולם-מרפא-עצמו: מודל-404 → מסומן-מת-שעה → הבא-בתור. הכול-מת → כשל-כן-בשמות-המודלים.
export async function nvidiaChat(system: string, user: string): Promise<string> {
  const env = loadLlmEnv()
  const key = env.NVIDIA_API_KEY
  const base = (env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
  if (!key) {
    throw new Error('provider-error: nvidia rail not configured')
  }
  const ladder = nvidiaModelLadder()
  if (ladder.length === 0) {
    throw new Error('provider-error: nvidia ladder empty (NVIDIA_MODELS)')
  }
  const now = Date.now()
  const alive = ladder.filter((m) => (nvidiaDeadModels.get(m) ?? 0) < now)
  const models = alive.length > 0 ? alive : [ladder[0]] // הכול-חתום-מת? מנסים-את-הראשון-בכנות — הכשל-ידווח-בשמו
  const failures: string[] = []
  for (const model of models) {
    try {
      return await nvidiaChatOnce(model, base, key, system, user)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/HTTP 404|Function .*Not found/i.test(msg)) {
        nvidiaDeadModels.set(model, now + NVIDIA_DEAD_MODEL_MS)
      }
      failures.push(`${model}: ${msg.slice(0, 110)}`)
    }
  }
  throw new Error(`provider-error: nvidia ladder exhausted — ${failures.join(' | ')}`)
}

async function nvidiaChatOnce(
  model: string,
  base: string,
  key: string,
  system: string,
  user: string,
): Promise<string> {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 4096,
    temperature: 0.2,
    // מודלי-nemotron הם מודלי-הסקה: הפלט-הממשי ב-content רק כש-thinking כבוי
    chat_template_kwargs: { enable_thinking: false },
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(NVIDIA_TIMEOUT_MS),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`provider-error: HTTP ${res.status}: ${t.slice(0, 160)}`)
  }
  const d = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[]
  }
  const content = d?.choices?.[0]?.message?.content
  if (!content || !String(content).trim()) {
    throw new Error('empty-output: nvidia returned empty content')
  }
  return String(content)
}

// בדיקת-חיות פר-מסילה: ירי אמיתי + ולידציה מחמירה. מטא-דאטה בלבד בתשובה.
export interface RailDrill {
  rail: 'zai' | 'nvidia'
  ok: boolean
  ms: number
  errorClass?: string
  error?: string
}

export async function nvidiaDrill(): Promise<RailDrill> {
  const t0 = Date.now()
  try {
    const raw = await nvidiaChat(
      'מבחן-חיות. ענה בדיוק מילה אחת: DRILL-OK',
      'ענה בדיוק: DRILL-OK'
    )
    if (!raw.trim().includes('DRILL-OK')) {
      return {
        rail: 'nvidia',
        ok: false,
        ms: Date.now() - t0,
        errorClass: 'invalid',
        error: `expected DRILL-OK, got: ${raw.trim().slice(0, 80)}`,
      }
    }
    return { rail: 'nvidia', ok: true, ms: Date.now() - t0 }
  } catch (e) {
    return {
      rail: 'nvidia',
      ok: false,
      ms: Date.now() - t0,
      errorClass: classifyProviderError(e),
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export function classifyProviderError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const m = msg.toLowerCase()
  if (m.includes('429') || m.includes('rate') || m.includes('too many'))
    return 'rate-limit'
  if (m.includes('timeout') || m.includes('abort')) return 'timeout'
  if (m.includes('empty-output')) return 'empty-output'
  if (m.includes('401') || m.includes('403') || m.includes('auth')) return 'auth'
  if (m.includes('fetch') || m.includes('network') || m.includes('econnrefused'))
    return 'network'
  return 'provider'
}

// דוח-נוכחות מסילות — בוליאנים ושמות-מודל בלבד. אף מפתח לא חוזר מכאן.
export interface RailsReport {
  zai: boolean
  nvidia: {
    present: boolean
    baseUrl: string | null
    preferredModel: string | null
    documented: string[]
  }
  ipai: { present: boolean; verified: false; note: string }
}

export function railsReport(): RailsReport {
  const env = loadLlmEnv()
  return {
    zai: true,
    nvidia: {
      present: nvidiaConfigured(),
      baseUrl: nvidiaConfigured()
        ? (env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
        : null,
      preferredModel: nvidiaConfigured() ? nvidiaPreferredModel() : null,
      documented: (env.NVIDIA_MODELS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    ipai: {
      present: Boolean(env.IPAI_API_KEY),
      verified: false,
      note: 'מפתח קיים בכספת; ספק לא זוהה סופית (401 מול bigmodel) — לא חובר לסולם עד זיהוי',
    },
  }
}

// hash-מטא ללדג'ר עבור drill מוצלח (תוכן קבוע DRILL-OK)
export function drillOkHash(): string {
  return sha256Short('DRILL-OK')
}
