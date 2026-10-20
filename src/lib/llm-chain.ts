import ZAI from 'z-ai-web-dev-sdk'
import { z } from 'zod'
import { sha256Short } from '@/lib/ledger'
import { nvidiaChat, nvidiaConfigured } from '@/lib/providers'

// סולם-מועמדים כן (חוקי fcc-llm-chain, worklog Task 12):
// 1. candidate chain — פסילה (throw/429/timeout/ריק/duplicate/invalid) מעבירה למועמד הבא באותו-תור.
// 2. unique validation — פלט זהה למועמד קודם נפסל כ-duplicate.
// 3. honest exhaustion — כשהסולם נגמר: ok:false. הפלט אף-פעם לא מומצא.
// Task 17: המועמדים קריאים (callables) — רב-ספקי: zai → nvidia-nim → zai-compact-retry.
// ספק לא-מאומת (IPAI) לא נכנס לסולם — כנות מעל תקווה.

export const TASK_KINDS = ['CODE', 'AUDIT', 'PLAN'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export type ErrorClass =
  | 'rate-limit'
  | 'timeout'
  | 'empty-output'
  | 'duplicate'
  | 'invalid'
  | 'auth'
  | 'network'
  | 'provider'
  | 'repo-not-found'
  | 'unknown'

export const codeOutputSchema = z.object({
  language: z.string().min(1).max(40),
  code: z.string().min(10),
  explanation: z.string().min(10).max(4000),
})

export const auditOutputSchema = z.object({
  verdict: z.string().min(3).max(300),
  findings: z
    .array(
      z.object({
        severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
        title: z.string().min(3).max(200),
        detail: z.string().min(10).max(2000),
      })
    )
    .min(1)
    .max(20),
})

export const planOutputSchema = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        detail: z.string().min(10).max(2000),
      })
    )
    .min(3)
    .max(12),
})

const TIMEOUT_MS = 90_000

export type ChainResult =
  | {
      ok: true
      worker: string
      output: unknown
      attempts: number
      durationMs: number
      outputHash: string
      trail?: ChainTrailStep[]
    }
  | {
      ok: false
      worker: 'exhausted'
      error: string
      errorClass: ErrorClass
      attempts: number
      durationMs: number
      trail?: ChainTrailStep[]
    }

// מחזור-הרפואה-החיה: מסלול-אמת-לסולם — הכישלון-של-כל-מועמד נשמר (לפני-כן: רק-האחרון
// שרד — כישלון-nvidia היה-נמחק-על-ידי-rate-limit-של-zai-compact והאמת-אבדה).
export interface ChainTrailStep {
  name: string
  ok: boolean
  errorClass?: ErrorClass
  error?: string
}

// משפחות-ספק: מועמדים-מאותו-משפחה חולקים-מכסה — rate-limit-על-אחד ממית-את-כולם.
// זיכרון-המצערה (מודולי): מועמד-ממשפחה-מוצערת מדולג — אפס-שריפת-זמן-על-מת-וודאי.
// (לקח-חי: zai-primary נכשל-rate-limit → zai-compact-retry הוא-אותו-חשבון — ירי-שווא-מובטח.)
export type RailFamily = 'zai' | 'nvidia'
const THROTTLE_MS = 10 * 60_000
const throttleUntil = new Map<RailFamily, number>()

function markThrottled(family: RailFamily): void {
  throttleUntil.set(family, Date.now() + THROTTLE_MS)
}

export function familyThrottled(family: RailFamily): boolean {
  return (throttleUntil.get(family) ?? 0) > Date.now()
}

export function classify(e: unknown): ErrorClass {
  const msg = e instanceof Error ? e.message : String(e)
  const m = msg.toLowerCase()
  // קידומות-גיטהאב מ-github.ts (worklog Task 19) — לפני הכלליות
  if (m.includes('repo-not-found')) return 'repo-not-found'
  if (m.includes('github-auth')) return 'auth'
  if (m.includes('github-rate')) return 'rate-limit'
  if (m.includes('429') || m.includes('rate') || m.includes('too many'))
    return 'rate-limit'
  if (m.includes('timeout') || m.includes('abort')) return 'timeout'
  if (m.includes('empty-output')) return 'empty-output'
  if (m.startsWith('duplicate')) return 'duplicate'
  if (m.startsWith('invalid') || m.includes('no-json-object')) return 'invalid'
  if (
    m.includes('fetch') ||
    m.includes('network') ||
    m.includes('econnrefused') ||
    m.includes('enotfound')
  )
    return 'network'
  if (m.includes('auth') || m.includes('401') || m.includes('403'))
    return 'auth'
  return 'provider'
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`timeout: ${label} exceeded ${ms}ms`)),
      ms
    )
  })
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

export async function callLlm(system: string, user: string): Promise<string> {
  const zai = await ZAI.create()
  const completion = await withTimeout(
    zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: system },
        { role: 'user', content: user },
      ],
      thinking: { type: 'disabled' },
    }),
    TIMEOUT_MS,
    'llm-call'
  )
  const content = completion?.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) {
    throw new Error('empty-output: provider returned empty content')
  }
  return content
}

// חילוץ JSON: מסיר גדרות-markdown, לוקח מה-{ הראשון עד ה-} האחרון
export function extractJson(text: string): unknown {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/```\s*$/, '')
  }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('no-json-object: no JSON object found in output')
  }
  return JSON.parse(t.slice(start, end + 1))
}

function validateWith(
  schema: z.ZodTypeAny,
  data: unknown
): unknown {
  const r = schema.safeParse(data)
  if (!r.success) {
    const issues = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new Error(`invalid: ${issues}`)
  }
  return r.data
}

const CONTRACTS: Record<TaskKind, { schema: z.ZodTypeAny; primary: string; compact: string }> = {
  CODE: {
    schema: codeOutputSchema,
    primary:
      'אתה מהנדס-תוכנה בכיר ברשת-ביצוע. הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown, בלי טקסט-עוטף. הסכימה המדויקת: {"language":"<שם-השפה>","code":"<קוד מלא ועובד>","explanation":"<הסבר הנדסי קצר>"}. אין המצאות: אם המשימה לא ברורה מספיק, החזר JSON תקין שבו explanation מציין במדויק מה חסר.',
    compact:
      'ענה ב-JSON תקף בלבד, ללא טקסט אחר: {"language":string,"code":string,"explanation":string}. הקוד חייב להיות מלא ורץ.',
  },
  AUDIT: {
    schema: auditOutputSchema,
    primary:
      'אתה בודק-קוד/אבטחה בכיר ברשת-ביצוע. הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown, בלי טקסט-עוטף. הסכימה המדויקת: {"verdict":"<מסקנה כוללת קצרה>","findings":[{"severity":"HIGH"|"MEDIUM"|"LOW","title":"<כותרת>","detail":"<הסבר>"}]}. אין המצאות: ממצא בלי בסיס בקלט — לא נכתב.',
    compact:
      'ענה ב-JSON תקף בלבד, ללא טקסט אחר: {"verdict":string,"findings":[{"severity":"HIGH"|"MEDIUM"|"LOW","title":string,"detail":string}]}. ממצאים מבוססים-קלט בלבד.',
  },
  PLAN: {
    schema: planOutputSchema,
    primary:
      'אתה ארכיטקט-מערכות ברשת-ביצוע. הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown, בלי טקסט-עוטף. הסכימה המדויקת: {"steps":[{"title":"<שלב>","detail":"<מה עושים ולמה>"}]} עם 3-12 שלבים קונקרטיים וברי-ביצוע.',
    compact:
      'ענה ב-JSON תקף בלבד, ללא טקסט אחר: {"steps":[{"title":string,"detail":string}]} — 3 עד 12 שלבים.',
  },
}

// הסולם הגנרי: candidates קריאים בטור, חוזה-zod אחד, honest exhaustion.
// runTaskChain הוא עטיפה דקה מעליו; סינתזת-הצי משתמשת בו ישירות.
export interface ChainCandidate {
  name: string
  call: () => Promise<string>
  family?: RailFamily
}

export async function runContractChain(
  userMsg: string,
  candidates: ChainCandidate[],
  schema: z.ZodTypeAny
): Promise<ChainResult> {
  const t0 = Date.now()
  const seenOutputs: string[] = []
  let lastError = 'unknown'
  let lastErrorClass: ErrorClass = 'unknown'
  let attempt = 0
  const trail: ChainTrailStep[] = []

  for (const c of candidates) {
    // דילוג-כן: משפחה-מוצערת (בריצה-זו או-בקודמת) — מת-וודאי; הכנות-נרשמת-במסלול.
    if (c.family && familyThrottled(c.family)) {
      trail.push({ name: `${c.name} (skipped: family throttled)`, ok: false, errorClass: 'rate-limit' })
      continue
    }
    attempt++
    try {
      const raw = await c.call()
      if (seenOutputs.includes(raw.trim())) {
        throw new Error(
          'duplicate: identical to an earlier candidate output in this chain'
        )
      }
      const parsed = extractJson(raw)
      const validated = validateWith(schema, parsed)
      seenOutputs.push(raw.trim())
      const outputStr = JSON.stringify(validated)
      console.error(`saos.llm_chain.selected candidate=${c.name}`)
      trail.push({ name: c.name, ok: true })
      return {
        ok: true,
        worker: c.name,
        output: validated,
        attempts: attempt,
        durationMs: Date.now() - t0,
        outputHash: sha256Short(outputStr),
        trail,
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      lastErrorClass = classify(e)
      trail.push({ name: c.name, ok: false, errorClass: lastErrorClass, error: lastError.slice(0, 300) })
      // המצערה-המשפחתית: rate-limit על-משפחה = כל-אחיה-מתים-ל-10 דק׳ — כולל-הבאים-בתור.
      if (lastErrorClass === 'rate-limit' && c.family) markThrottled(c.family)
      console.error(
        `saos.llm_chain.candidate_failed name=${c.name} class=${lastErrorClass}`
      )
    }
  }

  console.error('saos.llm_chain.exhausted')
  return {
    ok: false,
    worker: 'exhausted',
    error: lastError,
    errorClass: lastErrorClass,
    attempts: attempt,
    durationMs: Date.now() - t0,
    trail,
  }
}

export async function runTaskChain(
  kind: TaskKind,
  title: string,
  prompt: string,
  opts?: { primarySystem?: string; context?: string }
): Promise<ChainResult> {
  const contract = CONTRACTS[kind]
  const context = opts?.context?.trim() || null
  const userMsg = context
    ? `${context}\n\n---\nכותרת המשימה: ${title}\n\nהמשימה:\n${prompt}`
    : `כותרת המשימה: ${title}\n\nהמשימה:\n${prompt}`
  const primarySystem = opts?.primarySystem?.trim()
    ? opts.primarySystem
    : contract.primary
  // סולם רב-ספקי באותו-תור: zai → nvidia-nim → zai-compact-retry.
  // כל מועמד מקבל את אותו חוזה-מערכת (או עדשה) — הספק משתנה, החוזה קבוע.
  // מחזור-הרפואה-החיה: משפחות-מוצהרות (מצערה-משפחתית) + סידור-מודע-מצערה —
  // משפחה-חיה-ראשונה; מוצערת-אחרונה (ואם-היא-עוד-מוצערת-בריצה — מדולגת-בכנות).
  const base: ChainCandidate[] = [
    { name: 'zai-primary', family: 'zai', call: () => callLlm(primarySystem, userMsg) },
  ]
  if (nvidiaConfigured()) {
    base.push({
      name: 'nvidia-nim',
      family: 'nvidia',
      call: () => nvidiaChat(primarySystem, userMsg),
    })
  }
  base.push({
    name: 'zai-compact-retry',
    family: 'zai',
    call: () => callLlm(contract.compact, userMsg),
  })
  const candidates = [...base.filter((c) => !c.family || !familyThrottled(c.family)), ...base.filter((c) => c.family && familyThrottled(c.family))]
  return runContractChain(userMsg, candidates, contract.schema)
}

// בדיקת-חיות: ירי אמיתי אחד, ולידציה מחמירה (DRILL-OK), כשל כן אם לא חוזר.
export async function runDrill(): Promise<{
  ok: boolean
  ms: number
  attempts: number
  errorClass?: ErrorClass
  error?: string
}> {
  const t0 = Date.now()
  try {
    const raw = await callLlm(
      'מבחן-חיות. ענה בדיוק מילה אחת: DRILL-OK',
      'ענה בדיוק: DRILL-OK'
    )
    if (!raw.trim().includes('DRILL-OK')) {
      return {
        ok: false,
        ms: Date.now() - t0,
        attempts: 1,
        errorClass: 'invalid',
        error: `expected DRILL-OK, got: ${raw.trim().slice(0, 80)}`,
      }
    }
    return { ok: true, ms: Date.now() - t0, attempts: 1 }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      attempts: 1,
      errorClass: classify(e),
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
