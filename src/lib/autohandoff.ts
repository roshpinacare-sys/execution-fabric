import { db } from '@/lib/db'
import { sha256Short } from '@/lib/ledger'
import { verifyRepo, ghErrorClass } from '@/lib/github'
import { scanSecrets } from '@/lib/secretscan'
import {
  extractArtifact,
  validateHandoffPath,
  HANDOFF_MAX_BYTES,
} from '@/lib/handoff'

// ===== החוליה-החסרה (worklog Task 29) — לולאת-הלמידה → שער-ההעברה =====
// משימת-למידה/התפתחות שהניבה תוצר-CODE-מאומת-עם-יעד-ריפו נכנסת-אוטומטית לשער-ההעברה
// כהצעה PROPOSED — פריסה-מאושרת: הרשת מציעה, הבעלים מאשר (אף-דחיפה בלי-אישור).
// דיסציפלינה: קובץ-חדש-בלבד (fabric/<taskId8>/… — אף-דריסה של קובץ-קיים בריפו),
// סריקת-סודות מחייבת, נגד-כפילות (הצעה-אוטומטית-אחת למשימה), וכשל-הצעה לעולם
// לא מפיל ביצוע — הירי-כבר-שולם, כשל-הצעה = כנות בלבד.

const AUTO_SOURCES = ['evolution', 'learning']

// חוזה-CODE (llm-chain): {"language","code","explanation"} — הארטיפקט = "code"
const AUTO_FIELD = 'code'

const LANG_EXT: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  javascript: 'js', js: 'js', jsx: 'jsx',
  python: 'py', py: 'py',
  rust: 'rs', go: 'go', java: 'java', kotlin: 'kt', ruby: 'rb', php: 'php',
  bash: 'sh', shell: 'sh', sh: 'sh', powershell: 'ps1',
  json: 'json', sql: 'sql', yaml: 'yaml', yml: 'yml',
  markdown: 'md', md: 'md', html: 'html', css: 'css', scss: 'scss',
  prisma: 'prisma', graphql: 'graphql', solidity: 'sol',
}

export function extForLanguage(lang: string | null | undefined): string {
  if (!lang) return 'txt'
  return LANG_EXT[lang.trim().toLowerCase()] ?? 'txt'
}

// slug-ASCII לנתיב — עברית נשארת בהודעת-הקומיט; הנתיב דטרמיניסטי ונקי
function asciiSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return s || 'snippet'
}

export interface AutoProposeResult {
  proposed: boolean
  handoffId?: string
  path?: string
  reason?: string // סיבת-דילוג כנה (מטא-דאטה בלבד — אף תוכן/סוד)
  errorClass?: string | null
}

export async function autoProposeHandoffForTask(taskId: string): Promise<AutoProposeResult> {
  try {
    const task = await db.task.findUnique({ where: { id: taskId } })
    if (!task) return { proposed: false, reason: 'task-not-found' }
    if (!AUTO_SOURCES.includes(task.source ?? '')) return { proposed: false, reason: 'source-not-self' }
    if (task.kind !== 'CODE') return { proposed: false, reason: 'kind-not-code' }
    if (task.status !== 'DONE' || !task.output) return { proposed: false, reason: 'not-done-verified' }
    if (!task.repo) return { proposed: false, reason: 'no-repo-target' }

    // נגד-כפילות: הצעה-אוטומטית-אחת למשימה (בכל-סטטוס) — אין-נדנוד, כשל-חיובי-שווא בטוח
    const existing = await db.handoff.findFirst({ where: { taskId, auto: true } })
    if (existing) return { proposed: false, reason: `already-proposed:${existing.status}` }

    const artifact = extractArtifact(task.output, AUTO_FIELD)
    if (artifact === null) return { proposed: false, reason: `no-${AUTO_FIELD}-field` }

    const size = Buffer.byteLength(artifact, 'utf8')
    if (size > HANDOFF_MAX_BYTES) return { proposed: false, reason: `too-big:${size}` }

    // סריקת-סודות — פגיעה = אין-הצעה בכלל (שמות-תבניות בלבד, אף ערך לא נחשף)
    const scan = scanSecrets(artifact)
    if (!scan.clean) {
      return {
        proposed: false,
        reason: `secret-scan:${scan.hits.map((h) => h.name).join(',')}`,
        errorClass: 'invalid',
      }
    }

    // נתיב-חדש-בלבד — מכיל-מזהה-משימה: התנגשות-בריפו-היעד אינה-מעשית; אף-דריסה
    let language: string | null = null
    try {
      language = (JSON.parse(task.output as string) as { language?: string }).language ?? null
    } catch {
      language = null
    }
    const path = `fabric/${taskId.slice(0, 8)}/${asciiSlug(task.title)}.${extForLanguage(language)}`
    const pathErr = validateHandoffPath(path)
    if (pathErr) return { proposed: false, reason: 'invalid-path' }

    // אימות-ריפו-חי (קאש-10דק' — בד"כ חם מהשיגור-עצמו)
    try {
      await verifyRepo(task.repo)
    } catch (e) {
      return {
        proposed: false,
        reason: `repo-verify-failed:${ghErrorClass(e) ?? 'provider'}`,
        errorClass: ghErrorClass(e),
      }
    }

    const message = `fabric: ${task.title} — הצעת-למידה-אוטונומית (ממתין לאישור-בעלים)`.slice(0, 400)

    const handoff = await db.handoff.create({
      data: {
        taskId,
        repo: task.repo,
        path,
        branch: null,
        message,
        field: AUTO_FIELD,
        status: 'PROPOSED',
        artifactHash: sha256Short(artifact),
        artifactSize: size,
        auto: true,
      },
    })
    return { proposed: true, handoffId: handoff.id, path }
  } catch (e) {
    // כשל-הצעה לעולם לא מפיל את הביצוע — כנות-מטא-דאטה בלבד
    return { proposed: false, reason: 'exception', errorClass: ghErrorClass(e) ?? 'provider' }
  }
}
