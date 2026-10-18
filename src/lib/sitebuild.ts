import { z } from 'zod'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db'
import { runContractChain, callLlm, type ErrorClass } from '@/lib/llm-chain'
import { nvidiaChat, nvidiaConfigured } from '@/lib/providers'
import { buildCensus } from '@/lib/census'
import { appendLedger } from '@/lib/ledger'

// עורק-הבנייה (worklog Task 32) — ההיפוך-הריבוני שהבעלים דרש:
// "למה האתר לא משתפר באמת? מה היא עושה — רק בודקת? אני רוצה בנייה ושיפור תמיד, לא רק בדיקות".
// הרשת כבר בודקת (AUDIT), לומדת (learning) ומציעה (evolution) — העורק הזה **בונה**:
// בכל-מחזור נולד שיפור-מוצר אמיתי: ארטיפקט בקובץ (sovereign/site/) + רשומה ב-Improvement
// + חתימה בשרשרת (SITEBUILD). הארטיפקטים נדחפים לגיט ע"י פעימת-הגיט הקיימת (עורק-ב) —
// כלומר: הריפו עצמו צומח ומשתפר אוטונומית, והצמיחה נראית-חיה בקונסולה.
//
// דיסציפלינה: מחזור = ירי-LLM אמיתי או כשל-כן (ok:false + errorClass). אין המצאות.
// כפילות = כותרת-זהה לשיפור/משימה מ-24h (כמו מועמד-כפול בסולם) — והכותרת-הנפסלת
// נכנסת לרשימת-האיסור של-המחזור-הבא (זיכרון-עדין במודול — אין-סכימה-חדשה).
// PROPOSAL לא מבוצע-אוטומטית — נשמר ומוצג; ביצוע-קוד עובר רק דרך התור/שער-ההעברה.

export const SITEBUILD_BUDGET_PER_HOUR = 6

export const siteBuildSchema = z.object({
  kind: z.enum(['CONTENT', 'DATA', 'PROPOSAL']),
  title: z.string().min(8).max(160),
  summary: z.string().min(10).max(600),
  body: z.string().min(50).max(12000),
  payload: z.unknown().optional(),
})

export type SiteBuildOutput = z.infer<typeof siteBuildSchema>

const BUILD_PRIMARY = [
  'אתה עורק-הבנייה של רשת-הביצוע — ריבונות אוטונומית חיה שמטרתה מוצר מתקדם, פורץ-דרך ומוחכם.',
  'הרשת כבר בודקת (ביקורות), לומדת (ממצאי-HIGH) ומציעה (הצעות-עצמיות) — אתה החלק ש**בונה**: בכל-מחזור אתה מייצר בדיוק שיפור אמיתי אחד למוצר עצמו.',
  'כללי-ברזל:',
  '1. kind=CONTENT — תוכן/תיעוד/מדריך/עדכון-חזון למוצר: body ב-markdown עצמאי, מעשי ומוכן-לשימוש (עברית).',
  '2. kind=DATA — נתוני-תצוגה לקונסולה (מדדים/יעדים/צ\'ק-ליסט/תצורות): שדה payload=אובייקט JSON; body מסביר מה-הנתונים-ואיך-להציגם.',
  '3. kind=PROPOSAL — הצעת-שינוי קונקרטית ל-UI/קוד המוצר: body כולל מה/למה/איך; ההצעה לא מבוצעת אוטומטית (זה טוב — כך שום-דבר לא נשבר).',
  '4. אל תחזור על כותרת מרשימות-האיסור (כשל-כפילות).',
  '5. מגוון-נושאים מחייב: אל תחזור על-נושא שכבר-טופל (גם-אם-הכותרת-שונה — נושא-זהה = כפילות). הישען על כיוון-גלגל-הכיוונים שיסופק לך בהקשר, ואל תיגע בנושאים-האסורים שיסופקו לך.',
  '6. body עצמאי לחלוטין: הקורא יראה רק אותו. אין סודות, אין מפתחות, אין נתיבים-מקומיים.',
  '7. איכות-מעל-כמות: שיפור אחד ששווה-משהו עדיף על רעיון-כללי. קונקרטי, מדיד, בר-שימוש.',
  'הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown-גדרות, בלי טקסט-עוטף.',
  'הסכימה המדויקת: {"kind":"CONTENT"|"DATA"|"PROPOSAL","title":"<כותרת ייחודית>","summary":"<שורה-תמציתית>","body":"<markdown מלא>","payload":{אובייקט — חובה רק ל-DATA}}',
].join(' ')

const BUILD_COMPACT =
  'ענה ב-JSON תקף בלבד, ללא טקסט אחר: {"kind":"CONTENT"|"DATA"|"PROPOSAL","title":string,"summary":string,"body":string}. שיפור-מוצר אחד קונקרטי בעברית (body=markdown עצמאי). אל תחזור על כותרות-קיימות.'

// משטחי-המוצר הקיימים (מטא-דאטה כן — כדי-שהבנייה תהיה-צמודה-למציאות ולא באוויר)
const PRODUCT_SURFACES = [
  'קונסולה RTL בעברית',
  'לוח-משימות (Dispatch → Workers)',
  'שרשרת-אמת (Ledger hash-chain)',
  'מדדי-רשת (/api/metrics)',
  'התפתחות-עצמית ולמידה (/api/evolution)',
  'מפת-הריבונות (/api/census)',
  'שער-העברה לגיט (/api/handoffs)',
  'קיר-הצמיחה (Improvements)',
  'צי-הכלים (/api/arsenal)',
  'משמרת-לילה (עורקי-הלב)',
]

// זיכרון-עדין: כותרות-שנפסלו-כפילות — נכנסות לאיסור-של-המחזור-הבא (אפס-סכימה)
const bannedTitles: string[] = []
// זיכרון-עדין (Task 39): מילות-נושא-אסורות — הלקח מ-4 מדריכי-"ממצאי-HIGH" רצופים:
// כפילות-כותרת-מדויקת לא תופסת סחרור-נושא. עכשיו יש גם דדופ-נושאים (חפיפת-מילים-משמעותיות).
const bannedTopicWords: string[] = []

// גלגל-הכיוונים (Task 39) — רוטציה נגזרת (ספירת-השיפורים % גודל-הגלגל): הכיוון-המומלץ
// למחזור נקבע מראש, כך שמחזורים-רצופים אינם יכולים להסתחרר על-אותו-סוג-תוצר.
export const TOPIC_WHEEL = [
  'DATA — מדדים/צ\'ק-ליסט/תצורה שהקונסולה מציגה (payload JSON)',
  'PROPOSAL — שיפור-UX קונקרטי לכרטיס-קיים בקונסולה',
  'CONTENT — מדריך-תפעול מעשי למשטח-ספציפי מהמוצר (לא על ממצאי-ביקורת)',
  'CONTENT — שאלות-ותשובות / טעויות-נפוצות-ותיקונן ברשת',
  'DATA — יעדים-שבועיים ומדדי-הצלחה (payload JSON)',
  'PROPOSAL — אינטגרציית-כלי מהארסנל למוצר (שימוש-מוצדק בכלי)',
  'CONTENT — חזון/רפלקציה קצרה על צמיחת-הרשת (לא מדריך, לא כיצד)',
  'DATA — אינדיקטורי-בריאות ומשמרת-לילה (payload JSON)',
  'PROPOSAL — שיפור-נגישות/מובייל קונקרטי',
  'CONTENT — לקחים-וסיכום בפורמט רשימה-מעשית על נושא-חדש לגמרי',
]

function normalizeTitle(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ')
}

// מילים-משמעותיות-בעברית: השלכת-תחיליות (ש/מ/ב/ל/ה/ו) כשהשארית-ארוכה, השלכת-מילות-מדידה-כלליות.
// מטרה-אחת: ש-"מדריך לסגירת ממצאי-HIGH" ו-"מדריך להתמודדות עם ממצאי-HIGH" ייחשבו-אותו-נושא.
const TOPIC_STOPWORDS = new Set([
  'מדריך', 'מדריכים', 'פיתוח', 'ניהול', 'התמודדות', 'טיפול', 'סקירה', 'עדכון', 'שיפור', 'שיפורים',
  'ממצאי', 'ממצא', 'מצאי', 'פתוחים', 'פתוח', 'סגירת', 'סגירה', 'רשת', 'ביצוע', 'אתר', 'מוצר',
  'בצורה', 'בצורת', 'אפקטיבית', 'אפקטיבי', 'כיצד', 'איך', 'למה', 'מה', 'עם', 'של', 'על', 'אל',
  'high', 'low', 'med', 'finding', 'findings', 'guide', 'network', 'site', 'product', 'system',
])

function significantWords(t: string): string[] {
  const words = t
    .toLowerCase()
    .replace(/[^\u0590-\u05FF0-9a-z\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[שמבלהו]+(?=.{3,})/, ''))
    .filter((w) => w.length >= 3 && !TOPIC_STOPWORDS.has(w))
  return [...new Set(words)].sort()
}

// חפיפת-נושא: יחס-המילים-המשותפות מתוך-הקטן-מבין-השניים. ≥0.6 = אותו-נושא-בלבוש-אחר.
function topicOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  const inter = a.filter((w) => setB.has(w)).length
  return inter / Math.min(a.length, b.length)
}

async function recentTitleSet(): Promise<Set<string>> {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)
  const [imps, tasks] = await Promise.all([
    db.improvement.findMany({ where: { createdAt: { gte: since24h } }, select: { title: true } }),
    db.task.findMany({ where: { createdAt: { gte: since24h } }, select: { title: true } }),
  ])
  return new Set([...imps, ...tasks].map((r) => normalizeTitle(r.title)))
}

// נושאי-24ש׳ האחרונים (Task 39): מערך-מערכי-מילים-משמעותיות של כותרות-השיפורים —
// הבסיס לדדופ-נושאים (חפיפה ≥0.6 = סחרור-נושא, כפילות-כן גם-אם-הכותרת-שונה).
async function recentTopicWordSets(): Promise<string[][]> {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)
  const imps = await db.improvement.findMany({
    where: { createdAt: { gte: since24h } },
    select: { title: true },
    orderBy: { id: 'desc' },
    take: 30,
  })
  return imps.map((r) => significantWords(r.title))
}

export interface SiteBuildContext {
  generatedAt: string
  product: { surfaces: string[] }
  improvements: { total: number; byKind: Record<string, number>; recentTitles: string[]; banned: string[] }
  rotation: { wheelHint: string; bannedTopicWords: string[] }
  network: {
    chain: { done: number; failed: number }
    tasksByStatus: Record<string, number>
    openHighs: number
    memory: { learned: number; produced: number; delivered: number; openLoops: number | null }
  }
  worthALook: { severity: string; kind: string; title: string; detail: string }[]
}

export async function gatherSiteBuildContext(): Promise<SiteBuildContext> {
  const since24h = new Date(Date.now() - 24 * 60 * 60_000)
  const census = await buildCensus()
  const recent = await db.improvement.findMany({
    where: { createdAt: { gte: since24h } },
    orderBy: { id: 'desc' },
    take: 12,
    select: { title: true },
  })
  const byKindGroups = await db.improvement.groupBy({ by: ['kind'], _count: { _all: true } })
  const improvementsTotal = await db.improvement.count()
  return {
    generatedAt: new Date().toISOString(),
    product: { surfaces: PRODUCT_SURFACES },
    improvements: {
      total: improvementsTotal,
      byKind: Object.fromEntries(byKindGroups.map((g) => [g.kind, g._count._all])),
      recentTitles: recent.map((r) => r.title),
      banned: [...bannedTitles],
    },
    // גלגל-הכיוונים (Task 39): רוטציה נגזרת-מהספירה — מחזור-רצוף לא יכול לסחרר
    rotation: {
      wheelHint: TOPIC_WHEEL[improvementsTotal % TOPIC_WHEEL.length],
      bannedTopicWords: [...bannedTopicWords],
    },
    network: {
      chain: { done: census.chain.done, failed: census.chain.failed },
      tasksByStatus: census.tasks.byStatus,
      openHighs: census.memory.openLoops.total ?? 0,
      memory: {
        learned: census.memory.learned.total,
        produced: census.memory.produced.total,
        delivered: census.memory.delivered.total,
        openLoops: census.memory.openLoops.total,
      },
    },
    worthALook: census.worthALook.slice(0, 4).map((f) => ({
      severity: f.severity,
      kind: f.kind,
      title: f.title,
      detail: f.detail,
    })),
  }
}

function contextUserPrompt(ctx: SiteBuildContext): string {
  return [
    'מצב-האמת של המוצר והרשת (מטא-דאטה בלבד):',
    JSON.stringify(ctx, null, 0),
    '',
    'בחר את השיפור הבעל-ערך ביותר עכשיו: מה שהמוצר צריך — לא מה שקל להמציא. אם שווה-מבט מציג כיוון — אפשר להישען עליו (בלי לחזור על כותרת-ממצא קיימת).',
    `כיוון-המחזור המומלץ מגלגל-הכיוונים: ${ctx.rotation.wheelHint} — הישען עליו אם-יש מה-לבנות בו.`,
    ctx.rotation.bannedTopicWords.length > 0
      ? `נושאים-אסורים (מילים-אלו/צירופיהם אסורים בכותרת ובנושא): ${ctx.rotation.bannedTopicWords.join(', ')}`
      : 'אין-נושאים-אסורים כרגע.',
  ].join('\n')
}

function slugify(t: string): string {
  const ascii = t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return ascii || 'improvement'
}

function q(s: string): string {
  return s.replace(/"/g, "'")
}

export type SiteBuildResult =
  | {
      ok: true
      applied: boolean
      improvementId: number
      kind: string
      title: string
      artifactPath: string
      worker: string
      attempts: number
      durationMs: number
      ledgerId: number
    }
  | {
      ok: false
      error: string
      errorClass: ErrorClass
      attempts: number
      durationMs: number
    }

// מחזור-בנייה אחד: מצב-אמת → ירי-LLM אמיתי → ולידציה + כפילות → ארטיפקט-קובץ + DB + שרשרת.
export async function runSiteBuildCycle(): Promise<SiteBuildResult> {
  const t0 = Date.now()

  // תקציב-כן — הגנה-כפולה (הלב מדלג לפני-הירי; כאן נאכף שרת-צד)
  const used = await siteBuildBudgetUsed()
  if (used >= SITEBUILD_BUDGET_PER_HOUR) {
    return {
      ok: false,
      error: `rate-limit: site-build budget exhausted (${used}/${SITEBUILD_BUDGET_PER_HOUR} per hour)`,
      errorClass: 'rate-limit',
      attempts: 0,
      durationMs: Date.now() - t0,
    }
  }

  const ctx = await gatherSiteBuildContext()
  const userMsg = contextUserPrompt(ctx)

  const candidates: { name: string; call: () => Promise<string> }[] = [
    { name: 'zai-primary', call: () => callLlm(BUILD_PRIMARY, userMsg) },
  ]
  if (nvidiaConfigured()) {
    candidates.push({ name: 'nvidia-nim', call: () => nvidiaChat(BUILD_PRIMARY, userMsg) })
  }
  candidates.push({ name: 'zai-compact-retry', call: () => callLlm(BUILD_COMPACT, userMsg) })

  const result = await runContractChain(userMsg, candidates, siteBuildSchema)
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      errorClass: result.errorClass,
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  const out = result.output as SiteBuildOutput

  // DATA ללא-payload = חוזה-לא-נשמר (invalid כן)
  if (out.kind === 'DATA' && (out.payload == null || typeof out.payload !== 'object')) {
    return {
      ok: false,
      error: 'invalid: kind=DATA requires a payload object',
      errorClass: 'invalid',
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  const titles = await recentTitleSet()
  if (titles.has(normalizeTitle(out.title))) {
    bannedTitles.push(out.title)
    if (bannedTitles.length > 50) bannedTitles.shift()
    return {
      ok: false,
      error: `duplicate: improvement title matches an existing item from the last 24h — "${out.title}"`,
      errorClass: 'duplicate',
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  // דדופ-נושאים (Task 39): חפיפת-מילים-משמעותיות ≥0.6 מול-כותרת-מ-24ש׳ = סחרור-נושא (כפילות-כן)
  const topicWords = significantWords(out.title)
  const recentTopics = await recentTopicWordSets()
  const colliding = recentTopics.find((rt) => rt.length > 0 && topicOverlap(topicWords, rt) >= 0.6)
  if (colliding) {
    // זיכרון-עדין: מילות-הנושא-האסורות נכנסות להקשר-של-המחזור-הבא
    for (const w of topicWords) {
      if (!bannedTopicWords.includes(w)) bannedTopicWords.push(w)
    }
    while (bannedTopicWords.length > 60) bannedTopicWords.shift()
    return {
      ok: false,
      error: `duplicate: topic spins an existing improvement from the last 24h (topic overlap) — "${out.title}"`,
      errorClass: 'duplicate',
      attempts: result.attempts,
      durationMs: Date.now() - t0,
    }
  }

  // ארטיפקט-אמת: קובץ-markdown תחת sovereign/site/ — נדחף-לגיט ע"י פעימת-הגיט (עורק-ב)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const relPath = `sovereign/site/${ts}-${slugify(out.title)}.md`
  const absPath = path.join(process.cwd(), relPath)
  const frontMatter = [
    '---',
    `title: "${q(out.title)}"`,
    `kind: ${out.kind}`,
    `status: ${out.kind === 'PROPOSAL' ? 'PROPOSED' : 'APPLIED'}`,
    `createdAt: ${new Date().toISOString()}`,
    `worker: ${result.worker}`,
    `summary: "${q(out.summary)}"`,
    '---',
    '',
    `# ${out.title}`,
    '',
    out.body,
    '',
  ].join('\n')
  mkdirSync(path.dirname(absPath), { recursive: true })
  writeFileSync(absPath, frontMatter, 'utf8')

  const row = await db.improvement.create({
    data: {
      kind: out.kind,
      title: out.title,
      summary: out.summary,
      body: out.body,
      payload: out.payload != null ? JSON.stringify(out.payload) : null,
      status: out.kind === 'PROPOSAL' ? 'PROPOSED' : 'APPLIED',
      artifactPath: relPath,
      worker: result.worker,
      attempts: result.attempts,
      durationMs: result.durationMs,
    },
  })

  const entry = await appendLedger({
    taskId: null,
    kind: 'SITEBUILD',
    status: 'DONE',
    worker: result.worker,
    attempts: result.attempts,
    durationMs: result.durationMs,
    errorClass: null,
    outputHash: result.outputHash,
  })

  return {
    ok: true,
    applied: row.status === 'APPLIED',
    improvementId: row.id,
    kind: out.kind,
    title: out.title,
    artifactPath: relPath,
    worker: result.worker,
    attempts: result.attempts,
    durationMs: Date.now() - t0,
    ledgerId: entry.id,
  }
}

// תקציב-כן: כמה שיפורים נולדו בשעה-האחרונה (גם PROPOSAL — כל-מחזור-מוצר כולל-ירי-אמת)
export async function siteBuildBudgetUsed(): Promise<number> {
  const since = new Date(Date.now() - 60 * 60_000)
  return db.improvement.count({ where: { createdAt: { gte: since } } })
}

export interface SiteBuildStatus {
  budget: { used: number; cap: number; remaining: number }
  total: number
  byKind: Record<string, number>
  proposedPending: number
  lastAt: string | null
  lastTitle: string | null
}

export async function siteBuildStatus(): Promise<SiteBuildStatus> {
  const [used, total, byKindGroups, proposed, last] = await Promise.all([
    siteBuildBudgetUsed(),
    db.improvement.count(),
    db.improvement.groupBy({ by: ['kind'], _count: { _all: true } }),
    db.improvement.count({ where: { status: 'PROPOSED' } }),
    db.improvement.findFirst({ orderBy: { id: 'desc' }, select: { title: true, createdAt: true } }),
  ])
  return {
    budget: {
      used,
      cap: SITEBUILD_BUDGET_PER_HOUR,
      remaining: Math.max(0, SITEBUILD_BUDGET_PER_HOUR - used),
    },
    total,
    byKind: Object.fromEntries(byKindGroups.map((g) => [g.kind, g._count._all])),
    proposedPending: proposed,
    lastAt: last?.createdAt.toISOString() ?? null,
    lastTitle: last?.title ?? null,
  }
}
