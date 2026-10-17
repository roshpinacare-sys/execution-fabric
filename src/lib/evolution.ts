import { z } from 'zod'
import { db } from '@/lib/db'
import { runContractChain, classify, callLlm, TASK_KINDS, type TaskKind } from '@/lib/llm-chain'
import { nvidiaChat, nvidiaConfigured } from '@/lib/providers'
import { KNOWN_REPOS } from '@/lib/github'

// לופ-התפתחות-עצמית (worklog Task 26) — הקפיצה מ"רשת-ריאקטיבית" ל"רשת-מציעה-לעצמה-עבודה":
// הרשת קוראת את מצב-האמת שלה (מטא-דאטה בלבד — כותרות/סוגים/משכים/מחלקות-שגיאה,
// לעולם לא תוכן-תוצרים ולעולם לא סודות), מציעה משימה אחת קונקרטית שמקדמת אותה,
// ומשגרת אותה לתור הרגיל — שם העובדים הקיימים מבצעים אותה בירי-אמת וחותמים בשרשרת.
//
// דיסציפלינה: הצעה = ירי-LLM אמיתי או כשל-כן (ok:false + errorClass). אין המצאות,
// אין סימולציה, והגנת-כפילות: כותרת-זהה למשימה מ-24h אחרונות נפסלת בדיוק כמו
// מועמד-כפול בסולם (duplicate).

export const EVOLUTION_BUDGET_PER_HOUR = 3

export const evolutionProposalSchema = z.object({
  kind: z.enum(['CODE', 'AUDIT', 'PLAN']),
  title: z.string().min(8).max(160),
  prompt: z.string().min(20).max(2000),
  rationale: z.string().min(10).max(600),
})

export type EvolutionProposal = z.infer<typeof evolutionProposalSchema>

const EVOLUTION_PRIMARY = [
  'אתה המציע-העצמי של רשת-ביצוע אוטונומית (Dispatch → Workers → Ledger) שמטרתה להיות ריבונות מתפתחת, מתקדמת ואינטליגנטית שמובילה בפער.',
  'קיבלת מצב-אמת מטא-דאטה בלבד על הרשת. תפקידך: להציע בדיוק משימה אחת קונקרטית וברת-ביצוע שמקדמת את הרשת עצמה — חיזוק מנוע, ביקורת על נקודת-תורפה, או תכנון הצעד-הבא.',
  'כללי-ברזל:',
  '1. אל תחזור על כותרת שנמצאת ברשימת-המשימות-האחרונות (זה כשל כפילות).',
  '2. ה-prompt חייב להיות עצמאי-לחלוטין: העובד שיבצע יראה רק כותרת+prompt (+הקשר-ריפו אם ציינת יעד). אין התייחסויות ל"המשימה הקודמת".',
  '3. אם המשימה נוגעת בריפו מסוים — ציין שם-ריפו מהרשימה המוכרת בלבד.',
  '4. אין סודות, אין מפתחות, אין נתיבים-מקומיים בפלט.',
  '5. משימה אחת בלבד — קונקרטית, מדידה, וברת-אימות.',
  'הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown, בלי טקסט-עוטף.',
  'הסכימה המדויקת: {"kind":"CODE"|"AUDIT"|"PLAN","title":"<כותרת ייחודית>","prompt":"<המשימה המלאה והעצמאית>","rationale":"<למה זה הצעד הבעל-ערך ביותר עכשיו>"}',
].join(' ')

const EVOLUTION_COMPACT =
  'ענה ב-JSON תקף בלבד, ללא טקסט אחר: {"kind":"CODE"|"AUDIT"|"PLAN","title":string,"prompt":string,"rationale":string}. הצע משימה אחת קונקרטית שמקדמת את רשת-הביצוע עצמה. אל תחזור על כותרות-קיימות.'

export interface EvolutionContext {
  generatedAt: string
  ledger: { total: number; done: number; failed: number; byKind: Record<string, number>; ladderActivations: number }
  queue: { queued: number; running: number }
  workers: { name: string; shots: number; avgMs: number }[]
  errorClasses: Record<string, number>
  recentTitles: string[]
  reposKnown: string[]
}

// מטא-דאטה בלבד — בלי תוכן-תוצרים, בלי סודות, בלי נתיבים-מקומיים.
export async function gatherEvolutionContext(): Promise<EvolutionContext> {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)

  const [total, done, failed, byKindGroups, ladder, queued, running, workerGroups, errGroups, recent] =
    await Promise.all([
      db.ledgerEntry.count(),
      db.ledgerEntry.count({ where: { status: 'DONE' } }),
      db.ledgerEntry.count({ where: { status: 'FAILED' } }),
      db.ledgerEntry.groupBy({ by: ['kind'], _count: { _all: true } }),
      db.ledgerEntry.count({ where: { attempts: { gt: 1 } } }),
      db.task.count({ where: { status: 'QUEUED' } }),
      db.task.count({ where: { status: 'RUNNING' } }),
      db.ledgerEntry.groupBy({
        by: ['worker'],
        where: { status: 'DONE' },
        _count: { _all: true },
        _avg: { durationMs: true },
      }),
      db.ledgerEntry.groupBy({
        by: ['errorClass'],
        where: { errorClass: { not: null } },
        _count: { _all: true },
      }),
      db.task.findMany({
        where: { createdAt: { gte: since24h } },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: { title: true },
      }),
    ])

  return {
    generatedAt: new Date().toISOString(),
    ledger: {
      total,
      done,
      failed,
      byKind: Object.fromEntries(byKindGroups.map((g) => [g.kind, g._count._all])),
      ladderActivations: ladder,
    },
    queue: { queued, running },
    workers: workerGroups
      .map((g) => ({
        name: g.worker,
        shots: g._count._all,
        avgMs: Math.round(g._avg.durationMs ?? 0),
      }))
      .sort((a, b) => b.shots - a.shots)
      .slice(0, 6),
    errorClasses: Object.fromEntries(errGroups.map((g) => [g.errorClass ?? 'unknown', g._count._all])),
    recentTitles: recent.map((t) => t.title),
    reposKnown: KNOWN_REPOS.slice(0, 40),
  }
}

function contextUserPrompt(ctx: EvolutionContext): string {
  return [
    'מצב-האמת הנוכחי של הרשת (מטא-דאטה בלבד):',
    JSON.stringify(
      {
        ...ctx,
        reposKnown: undefined, // נשלח בנפרד לקריאות
        recentTitlesCount: ctx.recentTitles.length,
      },
      null,
      0
    ),
    '',
    `ריפואים-מוכרים (יעדים-חוקיים בלבד): ${ctx.reposKnown.join(', ')}`,
    '',
    'כותרות-אחרונות (חל איסור-חזרה עליהן):',
    ctx.recentTitles.length ? ctx.recentTitles.map((t) => `- ${t}`).join('\n') : '(אין)',
  ].join('\n')
}

// הגנת-כפילות: כותרת-מנורמלת שנכחה ב-24h האחרונות = duplicate (כמו מועמד-כפול בסולם)
function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function recentTitleSet(): Promise<Set<string>> {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)
  const rows = await db.task.findMany({
    where: { createdAt: { gte: since24h } },
    select: { title: true },
  })
  return new Set(rows.map((r) => normalizeTitle(r.title)))
}

export type EvolutionResult =
  | {
      ok: true
      proposal: EvolutionProposal
      taskId: string
      worker: string
      attempts: number
      durationMs: number
    }
  | {
      ok: false
      error: string
      errorClass: string
      attempts: number
      durationMs: number
    }

// מחזור-הצעה אחד: מצב-אמת → ירי-LLM אמיתי → ולידציה + הגנת-כפילות → שיגור לתור.
// אין שיגור בלי הצעה-תקפה — כשל הסולם חוזר כן למתקשר.
export async function proposeAndQueueEvolutionTask(): Promise<EvolutionResult> {
  const t0 = Date.now()
  const ctx = await gatherEvolutionContext()
  const userMsg = contextUserPrompt(ctx)

  const candidates: { name: string; call: () => Promise<string> }[] = [
    { name: 'zai-primary', call: () => callLlm(EVOLUTION_PRIMARY, userMsg) },
  ]
  if (nvidiaConfigured()) {
    candidates.push({ name: 'nvidia-nim', call: () => nvidiaChat(EVOLUTION_PRIMARY, userMsg) })
  }
  candidates.push({ name: 'zai-compact-retry', call: () => callLlm(EVOLUTION_COMPACT, userMsg) })

  const result = await runContractChain(userMsg, candidates, evolutionProposalSchema)

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      errorClass: result.errorClass,
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  const proposal = result.output as EvolutionProposal

  // גם סוג-המשימה חייב להיות מהמנוע-הקיים (TASK_KINDS) — הגנה-כפולה מעל ה-zod
  if (!TASK_KINDS.includes(proposal.kind as TaskKind)) {
    return {
      ok: false,
      error: `invalid: kind=${proposal.kind} outside TASK_KINDS`,
      errorClass: 'invalid',
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  const titles = await recentTitleSet()
  if (titles.has(normalizeTitle(proposal.title))) {
    return {
      ok: false,
      error: `duplicate: proposed title matches a task from the last 24h — "${proposal.title}"`,
      errorClass: 'duplicate',
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  const task = await db.task.create({
    data: {
      title: proposal.title,
      kind: proposal.kind,
      prompt: proposal.prompt,
      repo: null, // יעד-ריפו לא נדרש להצעה-עצמית; הצעה עם-ריפו תוגש-כהצעה-מאומתת בעתיד
      source: 'evolution',
    },
  })

  return {
    ok: true,
    proposal,
    taskId: task.id,
    worker: result.worker,
    attempts: result.attempts,
    durationMs: Date.now() - t0,
  }
}

// תקציב-כן: כמה הצעות-עצמי נשלחו בשעה-האחרונה (נאכף ב-POST /api/evolution)
export async function evolutionBudgetUsed(): Promise<number> {
  const since = new Date(Date.now() - 60 * 60_000)
  return db.task.count({ where: { source: 'evolution', createdAt: { gte: since } } })
}

export { classify }
