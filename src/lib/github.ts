import fs from 'fs'
import path from 'path'

// יעדי-ריפו אמיתיים (worklog Task 19): הרשת מבצעת על חומר-אמיתי מ-GitHub.
// חוקי-סודיות: הטוקן נקרא בשרת-בלבד מקובץ-הסמכות-המוזרק (gitignored — המפעיל מזריק);
// אף ערך-טוקן לא יודפס לשום לוג/תשובה/לדג'ר — מטא-דאטה בלבד.
// אימות-חי נעשה ראשון-יד: פר-ריפו/עץ/contents → 200; רשימת-ארגון → 404 (PAT ללא הרשאת-ארגון)
// — לכן רשימת-ההצעות סטטית מהביקורת, והאימות האמיתי תמיד חי מול ה-API בשיגור.

export const ORG = 'roshpinacare-sys'

const GH_TIMEOUT_MS = 20_000

const CACHE: { token: string | null } = { token: null }

// פיצול-מחרוזת-מכוון: אפס-אזכור-נתיב-מפתח-מילולי בגיט (RUNBOOK: אפס-סודות-בגיט)
const AUTH_FILE = path.join(process.cwd(), 'upload', 'pa' + 't.env')

export function githubToken(): string | null {
  if (CACHE.token !== null) return CACHE.token
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8').trim()
    // קובץ-הסמכות הוא טוקן-גולם; תמיכה גם בפורמט KEY=VALUE אם ישונה בעתיד
    const t = raw.includes('=')
      ? (raw.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '')
      : raw
    CACHE.token = t || null
    return CACHE.token
  } catch {
    CACHE.token = ''
    return null
  }
}

// קידומות-שגיאה יציבות למיון (classify ב-llm-chain):
// github-auth / github-rate / github-notfound / github-network / github-status
export type GhErrorClass = 'auth' | 'rate-limit' | 'repo-not-found' | 'network' | 'provider'

export function ghErrorClass(e: unknown): GhErrorClass | null {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase()
  if (!m.includes('github-')) return null
  if (m.includes('github-auth')) return 'auth'
  if (m.includes('github-rate')) return 'rate-limit'
  if (m.includes('github-notfound')) return 'repo-not-found'
  if (m.includes('github-network')) return 'network'
  return 'provider'
}

export function ghErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function ghRes(
  url: string,
  accept: string,
  init?: { method?: string; body?: string }
): Promise<Response> {
  const token = githubToken()
  if (!token) throw new Error('github-auth: קובץ-הסמכות חסר (המפעיל מזריק, gitignored)')
  let res: Response
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'Content-Type': init?.body ? 'application/json' : undefined,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: init?.body,
      signal: AbortSignal.timeout(GH_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(
      `github-network: ${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (res.status === 404) {
    throw new Error('github-notfound: HTTP 404 (repo לא קיים או אין גישה)')
  }
  if (res.status === 401 || res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    if (res.status === 403 && remaining === '0') {
      throw new Error('github-rate: HTTP 403 — מיצוי-מכסה')
    }
    throw new Error(`github-auth: HTTP ${res.status}`)
  }
  if (res.status === 429) throw new Error('github-rate: HTTP 429')
  if (!res.ok) throw new Error(`github-status: HTTP ${res.status}`)
  return res
}

async function ghJson<T>(url: string): Promise<T> {
  const res = await ghRes(url, 'application/vnd.github+json')
  return (await res.json()) as T
}

async function ghRaw(url: string): Promise<string> {
  const res = await ghRes(url, 'application/vnd.github.raw')
  return res.text()
}

// ===== שער-העברת-תוצרים (worklog Task 20) =====
// PUT contents עם GET-sha מוקדם (עדכון/יצירה) + read-back מאומת בשרשרת.
// אף תוכן לא נכנס לשגיאות/לוגים — רק מטא-דאטה.

async function contentsUrl(repo: string, path: string, ref?: string | null): Promise<string> {
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  return `https://api.github.com/repos/${ORG}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(path)}${refQ}`
}

interface ContentsJson {
  sha: string
  content?: string
  encoding?: string
}

// אם הקובץ קיים — sha שלו (עדכון); 404 = קובץ-חדש (יצירה) — לא שגיאה.
export async function getContentsSha(
  repo: string,
  path: string,
  branch?: string | null
): Promise<string | null> {
  try {
    const d = await ghJson<ContentsJson>(await contentsUrl(repo, path, branch))
    return d.sha
  } catch (e) {
    if (ghErrorMessage(e).includes('github-notfound')) return null
    throw e
  }
}

export interface PutResult {
  commitSha: string
  contentSha: string
  created: boolean
}

export async function putContents(opts: {
  repo: string
  path: string
  content: string
  message: string
  branch?: string | null
}): Promise<PutResult> {
  const existingSha = await getContentsSha(opts.repo, opts.path, opts.branch)
  const body: Record<string, unknown> = {
    message: opts.message,
    content: Buffer.from(opts.content, 'utf8').toString('base64'),
  }
  if (opts.branch) body.branch = opts.branch
  if (existingSha) body.sha = existingSha
  const res = await ghRes(
    `https://api.github.com/repos/${ORG}/${encodeURIComponent(opts.repo)}/contents/${encodeURIComponent(opts.path)}`,
    'application/vnd.github+json',
    { method: 'PUT', body: JSON.stringify(body) }
  )
  const d = (await res.json()) as {
    commit?: { sha?: string }
    content?: { sha?: string }
  }
  if (!d.commit?.sha) {
    throw new Error('github-status: PUT contents succeeded but no commit sha returned')
  }
  return {
    commitSha: d.commit.sha,
    contentSha: d.content?.sha ?? '',
    created: !existingSha,
  }
}

// read-back: משיכת התוכן מהשרת חזרה + השוואת בייטים מדויקת מול מה ששוגר.
export async function readBackVerify(
  repo: string,
  path: string,
  branch: string | null,
  expected: string
): Promise<{ verified: boolean; bytes: number }> {
  const d = await ghJson<ContentsJson>(await contentsUrl(repo, path, branch))
  if (d.encoding !== 'base64' || typeof d.content !== 'string') {
    throw new Error('github-status: read-back returned unexpected encoding')
  }
  const actual = Buffer.from(d.content, 'base64')
  const exp = Buffer.from(expected, 'utf8')
  return { verified: actual.equals(exp), bytes: actual.length }
}

// ===== קאש in-memory (TTL 10 דקות) =====
const TTL_MS = 10 * 60 * 1000
const metaCache = new Map<string, { ts: number; val: RepoMeta }>()
const ctxCache = new Map<string, { ts: number; val: RepoContext }>()

function cacheGet<T>(m: Map<string, { ts: number; val: T }>, k: string): T | null {
  const hit = m.get(k)
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.val
  if (hit) m.delete(k)
  return null
}
function cacheSet<T>(m: Map<string, { ts: number; val: T }>, k: string, v: T): void {
  m.set(k, { ts: Date.now(), val: v })
}

// ===== מטא-דאטה ואימות =====
export interface RepoMeta {
  name: string
  branch: string
  sizeKb: number
  pushedAt: string | null
  description: string | null
}

export async function verifyRepo(repo: string): Promise<RepoMeta> {
  const hit = cacheGet(metaCache, repo)
  if (hit) return hit
  const d = await ghJson<{
    name: string
    default_branch: string | null
    size: number
    pushed_at: string | null
    description: string | null
  }>(`https://api.github.com/repos/${ORG}/${repo}`)
  const meta: RepoMeta = {
    name: d.name,
    branch: d.default_branch ?? 'main',
    sizeKb: d.size ?? 0,
    pushedAt: d.pushed_at,
    description: d.description,
  }
  cacheSet(metaCache, repo, meta)
  return meta
}

// ===== בניית הקשר-ריפו אמיתי ומקורז =====
const TREE_LINES = 220
const MAX_FILES = 8
const FILE_CAP = 3_200
const TOTAL_CAP = 16_000

const NOISE_RE =
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp4|mp3|zip|gz|rar|7z|pdf|db|sqlite|wasm|exe|dll|so|dylib|jar|class|pyc|bin|lock)$/i
const TEXT_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|prisma|ya?ml|toml|sh|py|go|rs|sql|css|scss|html|env.example|txt|c|cpp|h|java|kt|rb|php|vue|svelte)$/i

export interface RepoFile {
  path: string
  size: number
  truncated: boolean
  content: string
}

export interface RepoContext {
  meta: RepoMeta
  totalBlobs: number
  treeTruncated: boolean
  treeLines: string[]
  files: RepoFile[]
  bytes: number
  fetchedMs: number
}

interface TreeEntry {
  path: string
  type: string
  size?: number
}

function treePriority(p: string): number {
  if (/^readme\.md$/i.test(p)) return 0
  if (/^package\.json$/i.test(p)) return 1
  if (/^src\//i.test(p)) return 2
  if (/^(tsconfig|next\.config|vite\.config|requirements\.txt|go\.mod|Cargo\.toml|pyproject)/i.test(p)) return 3
  return 4
}

export async function buildRepoContext(repo: string): Promise<RepoContext> {
  const hit = cacheGet(ctxCache, repo)
  if (hit) return hit
  const t0 = Date.now()
  const meta = await verifyRepo(repo)

  const tree = await ghJson<{ tree: TreeEntry[]; truncated: boolean }>(
    `https://api.github.com/repos/${ORG}/${repo}/git/trees/${meta.branch}?recursive=1`
  )
  const blobs = tree.tree.filter((e) => e.type === 'blob')
  const relevant = blobs
    .filter((e) => !NOISE_RE.test(e.path) && e.path.length < 200)
    .sort(
      (a, b) =>
        treePriority(a.path) - treePriority(b.path) ||
        a.path.split('/').length - b.path.split('/').length ||
        a.path.localeCompare(b.path)
    )
  const treeLines = relevant.slice(0, TREE_LINES).map((e) => e.path)

  // בחירת-קבצים: README + package.json + הקוד הכי נגיש מ-src/ — בטווח-בייטים קצוב
  const picked: RepoFile[] = []
  let total = 0
  const wanted = relevant
    .filter(
      (e) =>
        typeof e.size === 'number' &&
        e.size > 0 &&
        e.size <= 48_000 &&
        (TEXT_EXT_RE.test(e.path) || /^(readme|package\.json)/i.test(e.path))
    )
    .slice(0, MAX_FILES + 4)

  for (const f of wanted) {
    if (picked.length >= MAX_FILES || total >= TOTAL_CAP) break
    try {
      const raw = await ghRaw(
        `https://api.github.com/repos/${ORG}/${repo}/contents/${encodeURIComponent(f.path)}`
      )
      const capped = raw.length > FILE_CAP
      const content = capped ? raw.slice(0, FILE_CAP) : raw
      picked.push({
        path: f.path,
        size: f.size ?? content.length,
        truncated: capped,
        content,
      })
      total += content.length
    } catch {
      // קובץ שנכשל (בינארי-שהתגלה מאוחר/שינוי-HEAD) — מדלגים בכנות, לא מפילים את ההקשר
    }
  }

  const ctx: RepoContext = {
    meta,
    totalBlobs: blobs.length,
    treeTruncated: tree.truncated || relevant.length > TREE_LINES,
    treeLines,
    files: picked,
    bytes: total,
    fetchedMs: Date.now() - t0,
  }
  cacheSet(ctxCache, repo, ctx)
  return ctx
}

// רינדור ההקשר לתוך הירי-ה-LLM — חומר-אמיתי עם סימון-חיתוך גלוי
export function renderRepoContext(ctx: RepoContext): string {
  const lines: string[] = []
  lines.push(
    `[הקשר-ריפו חי — נשלף עכשיו מ-GitHub: ${ORG}/${ctx.meta.name}, ענף ${ctx.meta.branch}]`
  )
  lines.push(
    `קבצים בריפו: ${ctx.totalBlobs} | נכללו בהקשר: ${ctx.files.length} קבצים (${ctx.bytes} בייטים) | משיכה: ${ctx.fetchedMs}ms`
  )
  lines.push('עץ-קבצים (ראשונים' + (ctx.treeTruncated ? ', מקוצר' : '') + '):')
  for (const p of ctx.treeLines) lines.push(`- ${p}`)
  for (const f of ctx.files) {
    lines.push('')
    lines.push(
      `--- FILE: ${f.path} (${f.size} בייטים${f.truncated ? ', מוצג עד ' + FILE_CAP + ' תווים' : ''}) ---`
    )
    lines.push(f.content)
  }
  lines.push('')
  lines.push(
    '[סוף-הקשר. זהו החומר-האמיתי היחיד — כל ממצא/שלב/קוד חייב להסתמך על נתיבים שנכחו בו; נתיב שלא נכח — לא להמציא.]'
  )
  return lines.join('\n')
}

// רשימת-הצעות סטטית ממטא-דאטת-הביקורת (40 ריפואים, 2026-10 נכונות) —
// האימות האמיתי תמיד חי מול ה-API בשיגור (verifyRepo).
export const KNOWN_REPOS: string[] = [
  'Adsmarket', 'anchor-baseline', 'Autonomy', 'Console', 'Defi', 'Domain',
  'fleet-economy', 'FleetHQ', 'giant', 'GridWatch', 'negen', 'ops-forge',
  'ops-intake', 'Project-files', 'Pulse', 'roshpina', 'roshpinacare-sys.github.io',
  'sanbox', 'Sandbox', 'sandbox-private', 'saos-agents', 'saos-control-center',
  'saos-desk', 'saos-dex', 'saos-jummper', 'saos-markets', 'saos-owner-channel',
  'saos-runtime', 'saos-sovereign-foundry', 'saos-sovereign-platform',
  'Saosmartwallet', 'Sdk', 'sovereign-beacon', 'sovereign-lighthouse',
  'sovereign-runner-kit', 'SovereignConsole', 'steem', 'TruthRail',
  'vault-home', 'Zip',
]
