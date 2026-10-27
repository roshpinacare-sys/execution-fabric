// ═════════════════════════════════════════════════════════════════════════════
// saos-architect — דמון-הארכיטקט-הריבוני (:3086) — Task-135 §1/§4
// ═════════════════════════════════════════════════════════════════════════════
// "CHIEF SOVEREIGN ARCHITECT ENGINE" — מנוע-ההחלטות-המרכזי הילידי של הצי:
//
//   1. AUDIT   — כל-מחזור: מריץ את-כל-סוללות-הבדיקות-של-האיברים (bun test) + lint
//                האפליקציה + מדידת-גיט (HEAD מול origin/main) — אפס-טענות-בלי-מדידה.
//   2. DECIDE  — לוח-החלטות: אילו-אישיות-TDD פתוחות (GitHub, טוקן-הבעלים) ומה
//                צבע-הסוללות — התור-החי-של-הבנייה-העצמית.
//   3. HEAL    — סוללה-אדומה → Issue-כן-עם-ה-traceback-וקריטריוני-קבלה
//                (דדופ-מקומי, תקרה-אחד-למחזור) — לולאת-הריפוי-העצמי של §4.
//   4. SIGN    — כל-מחזור נחתם-קבלה-hash-linked-בשרשרת-מקומית (סמנטיקת
//                fleet-economy) והשרשרת-מאומתת-מה-Genesis-בכל-חתימה (fail-closed).
//
// אפס-TODO/stub/mock: כל-נתיב עובד-חי. כשל-כן-בכל-שכבה; אין-המצאת-מספרים.
// ═════════════════════════════════════════════════════════════════════════════
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ZAI from 'z-ai-web-dev-sdk'
import { buildVerdict, parseBuildContract, patchGuard, type BuildContract, type ProposedFile } from './build-lane'
import { GENESIS, buildExecutionState, buildQualityReport, parseBunTestOutput, receiptHash, verifyChain, type ChainLine, type SuiteRow } from './core'

const PORT = 3086 // קבוע — חוזה-האיברים
const ROOT = resolve(import.meta.dir, '..', '..')
const STATE_DIR = join(import.meta.dir, 'state')
const CHAIN_PATH = join(STATE_DIR, 'architect-chain.jsonl')
// Task-142 (הדירקטיבה-המוחלטת §3): ארטיפקטי-מדינה-אמיתיים — נכתבים-בכל-מחזור-ממדידה-חיה
const EXECUTION_STATE_PATH = join(STATE_DIR, 'execution-state.json')
const QUALITY_REPORT_PATH = join(STATE_DIR, 'quality-report.json')
const HEALS_LOG = join(ROOT, 'upload', 'architect-heals.jsonl')
const CYCLE_MS = Number(process.env.SAOS_ARCHITECT_CYCLE_MS ?? 5 * 60_000)
const FIRST_MS = Number(process.env.SAOS_ARCHITECT_FIRST_MS ?? 45_000)

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [saos-architect] ${msg}`)
}

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })

// ── הסוללות-המבוקרות (כל-האיברים-עם-בדיקות-בעץ) ─────────────────────────────
const SUITES: Array<{ name: string; dir: string }> = [
  { name: 'saos-dex', dir: join(ROOT, 'mini-services', 'saos-dex') },
  { name: 'saos-wallet', dir: join(ROOT, 'mini-services', 'saos-wallet') },
  { name: 'saos-grid', dir: join(ROOT, 'mini-services', 'saos-grid') },
  { name: 'saos-arb', dir: join(ROOT, 'mini-services', 'saos-arb') },
  { name: 'saos-architect', dir: import.meta.dir },
  { name: 'fabric-heartbeat', dir: join(ROOT, 'mini-services', 'fabric-heartbeat') },
]

function runBunTest(dir: string): { pass: number; fail: number; tail: string; ok: boolean } {
  try {
    const p = Bun.spawnSync(['bun', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const out = `${p.stdout.toString()}\n${p.stderr.toString()}`
    const { pass, fail } = parseBunTestOutput(out)
    const tail = out.trim().split('\n').slice(-14).join('\n')
    return { pass, fail, tail, ok: p.exitCode === 0 && fail === 0 }
  } catch (e) {
    return { pass: 0, fail: 0, tail: `spawn-failed: ${e instanceof Error ? e.message : String(e)}`, ok: false }
  }
}

function runLint(): { ok: boolean; tail: string } {
  try {
    const p = Bun.spawnSync(['bun', 'run', 'lint'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const out = `${p.stdout.toString()}\n${p.stderr.toString()}`
    return { ok: p.exitCode === 0, tail: out.trim().split('\n').slice(-8).join('\n') }
  } catch (e) {
    return { ok: false, tail: `spawn-failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function gitHead(): string {
  try {
    const p = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    return p.stdout.toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

function originSynced(): boolean | null {
  try {
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
    const ls = Bun.spawnSync(['git', 'ls-remote', 'origin', 'refs/heads/main'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const remote = ls.stdout.toString().trim().split('\t')[0] ?? ''
    return head && remote ? head === remote : null
  } catch {
    return null
  }
}

function githubToken(): string | null {
  try {
    const p = process.env.GITHUB_TOKEN_PATH ?? '/home/z/.saos-secrets/github.token'
    if (existsSync(p)) {
      const t = readFileSync(p, 'utf8').trim()
      if (t.length > 20) return t
    }
  } catch { /* כנות-בהמשך */ }
  return process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.length > 20 ? process.env.GITHUB_TOKEN : null
}

function githubRepo(): string {
  try {
    const url = Bun.spawnSync(['git', 'config', '--get', 'remote.origin.url'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
    const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/)
    if (m?.[1]) return m[1]
  } catch { /* fallback */ }
  return process.env.GITHUB_REPO ?? 'roshpinacare-sys/execution-fabric'
}

async function auditIssues(): Promise<{ open: number; titles: string[]; error: string | null }> {
  const tok = githubToken()
  if (!tok) return { open: 0, titles: [], error: 'no-token' }
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo()}/issues?state=open&per_page=30`, {
      headers: { authorization: `token ${tok}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { open: 0, titles: [], error: `HTTP ${res.status}` }
    const list = (await res.json()) as Array<{ number: number; title: string; pull_request?: unknown }>
    const issues = list.filter((i) => !i.pull_request) // PRs אינם-אישיות
    return { open: issues.length, titles: issues.map((i) => `#${i.number} ${i.title}`), error: null }
  } catch (e) {
    return { open: 0, titles: [], error: e instanceof Error ? e.message : String(e) }
  }
}

function alreadyHealed(title: string): boolean {
  try {
    if (!existsSync(HEALS_LOG)) return false
    return readFileSync(HEALS_LOG, 'utf8').includes(title)
  } catch {
    return false
  }
}

function markHealed(title: string, issueNumber: number | null): void {
  try {
    appendFileSync(HEALS_LOG, JSON.stringify({ at: new Date().toISOString(), title, issueNumber }) + '\n')
  } catch { /* כנות: כשל-רישום לא מפיל את הריפוי */ }
}

async function fileHealIssue(suite: string, tail: string, fail: number): Promise<number | null> {
  const tok = githubToken()
  if (!tok) return null
  const title = `fix(${suite}): test suite red — ${fail} failures (architect self-heal ${new Date().toISOString().slice(0, 10)})`
  if (alreadyHealed(title)) return null // דדופ-יומי — אפס-ספאם
  const body = [
    '## לולאת-הריפוי-העצמית (saos-architect §4)',
    `סוללת-${suite} אדומה — ${fail} כישלונות, שנמדדו-חי-על-ידי הארכיטקט-הריבוני.`,
    '',
    '## ה-traceback (זנב-הפלט-המדוד)',
    '```',
    tail.slice(0, 2_000),
    '```',
    '',
    '## קריטריוני-קבלה (TDD-required)',
    '1. `bun test` בתיקיית-האיבר ירוק-מלא (0 fail).',
    '2. הסבר-שורש-מדוד (מה-נשבר ולמה) — לא עוקף-תיקון.',
    '3. אפס-TODO/stub/mock בתיקון.',
    '',
    'סמכות: אישור-הבעלים (24/10) — הארכיטקט-פותח, רשת-ה-swarm מוציאה-לפועל.',
  ].join('\n')
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo()}/issues`, {
      method: 'POST',
      headers: { authorization: `token ${tok}`, 'content-type': 'application/json', accept: 'application/vnd.github+json' },
      body: JSON.stringify({ title, body, labels: [suite, 'sovereign-audit', 'TDD-required', 'architect-heal'] }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 201) {
      const n = ((await res.json()) as { number: number }).number
      markHealed(title, n)
      return n
    }
    markHealed(title, null) // גם-דחייה-מתועדת — לא ננסה-שוב היום
    return null
  } catch {
    return null
  }
}

// ── שרשרת-הקבלות ─────────────────────────────────────────────────────────────
function readChain(): ChainLine[] {
  try {
    if (!existsSync(CHAIN_PATH)) return []
    return readFileSync(CHAIN_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as ChainLine)
  } catch {
    return []
  }
}

function appendReceipt(rec: Omit<ChainLine, 'hash' | 'prev'>): { ok: boolean; head: string | null; verified: number; brokenAt: number | null } {
  const chain = readChain()
  const prev = chain.length > 0 ? chain[chain.length - 1].hash : GENESIS
  const line: ChainLine = { ...rec, prev, hash: receiptHash({ ...rec, prev }) }
  try {
    appendFileSync(CHAIN_PATH, JSON.stringify(line) + '\n')
  } catch (e) {
    log(`כשל-חתימת-קבלה (כן): ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, head: prev, verified: chain.length, brokenAt: null }
  }
  const v = verifyChain(readChain())
  return { ok: v.ok, head: v.head, verified: v.verified, brokenAt: v.brokenAt }
}

// ── מסילת-הבנייה-העצמית (Task-136 §5): אישיות → חוזה → LLM → שערים → בדיקות → מיזוג ──
const buildState = {
  attempts: 0,
  merged: 0,
  reverted: 0,
  lastAt: null as string | null,
  lastIssue: null as number | null,
  lastVerdict: null as string | null,
  lastError: null as string | null,
}

interface GhIssue {
  number: number
  title: string
  body: string | null
  labels: Array<{ name: string }>
}

async function fetchBuildableIssue(): Promise<GhIssue | null> {
  const tok = githubToken()
  if (!tok) return null
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo()}/issues?state=open&labels=architect-build&per_page=20&sort=created&direction=asc`, {
      headers: { authorization: `token ${tok}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const list = (await res.json()) as GhIssue[]
    return (list ?? []).find((i) => !i.pull_request) ?? null
  } catch {
    return null
  }
}

async function llmPropose(issue: GhIssue, contract: BuildContract): Promise<ProposedFile[] | { error: string }> {
  try {
    const zai = await ZAI.create()
    const contexts = contract.files.slice(0, 4).map((f) => {
      const p = join(ROOT, f)
      const content = existsSync(p) ? readFileSync(p, 'utf8') : ''
      return `### ${f}\n\`\`\`\n${content.slice(0, 12_000)}\n\`\`\``
    }).join('\n\n')
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content: 'אתה-מהנדס-בכיר-במערכת-SAOS. אתה-מייצר-קבצי-קוד-מלאים-בלבד. אסור-TODO/FIXME/mock/stub/unimplemented. TypeScript-strict. בדיקות-bun:test. השב-JSON בלבד במבנה: {"files":[{"path":"...","content":"..."}]}. אף-טקסט-אחר.',
        },
        {
          role: 'user',
          content: `אישיות #${issue.number}: ${issue.title}\n\n${(issue.body ?? '').slice(0, 4_000)}\n\n## קבצי-החוזה-הנוכחיים:\n${contexts}\n\nבצע: כתוב/עדכן את קבצי-החוזה כך-שהקבלה תתמלא. השב-JSON בלבד.`,
        },
      ],
      thinking: { type: 'disabled' },
    })
    const raw = completion.choices[0]?.message?.content ?? ''
    const jsonM = /\{[\s\S]*\}/.exec(raw)
    if (!jsonM) return { error: 'llm-no-json-in-response' }
    const parsed = JSON.parse(jsonM[0]) as { files?: ProposedFile[] }
    if (!Array.isArray(parsed.files)) return { error: 'llm-no-files-array' }
    return parsed.files.map((f) => ({ path: String(f.path ?? ''), content: String(f.content ?? '') }))
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function closeIssueWithComment(n: number, comment: string, done: boolean): Promise<void> {
  const tok = githubToken()
  if (!tok) return
  try {
    await fetch(`https://api.github.com/repos/${githubRepo()}/issues/${n}/comments`, {
      method: 'POST',
      headers: { authorization: `token ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: comment.slice(0, 6_000) }),
      signal: AbortSignal.timeout(20_000),
    })
    if (done) {
      await fetch(`https://api.github.com/repos/${githubRepo()}/issues/${n}`, {
        method: 'PATCH',
        headers: { authorization: `token ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
        signal: AbortSignal.timeout(20_000),
      })
    }
  } catch { /* כנות: כשל-סגירה לא מפיל את המסילה */ }
}

function gitCommitAndPush(files: string[], msg: string): { ok: boolean; tail: string } {
  try {
    const add = Bun.spawnSync(['git', 'add', ...files], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    if (add.exitCode !== 0) return { ok: false, tail: add.stderr.toString().slice(0, 300) }
    const commit = Bun.spawnSync(['git', 'commit', '-m', msg], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    if (commit.exitCode !== 0) return { ok: false, tail: commit.stderr.toString().slice(0, 300) }
    const push = Bun.spawnSync(['git', 'push', 'origin', 'HEAD:main'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    return { ok: push.exitCode === 0, tail: push.stderr.toString().slice(0, 300) }
  } catch (e) {
    return { ok: false, tail: e instanceof Error ? e.message : String(e) }
  }
}

async function buildLane(): Promise<void> {
  const issue = await fetchBuildableIssue()
  if (!issue) {
    buildState.lastVerdict = 'no-buildable-issue (תור-ריק — כנות)'
    return
  }
  buildState.attempts++
  buildState.lastAt = new Date().toISOString()
  buildState.lastIssue = issue.number
  const contract = parseBuildContract(issue.body ?? '')
  if (!contract) {
    buildState.lastVerdict = `issue-${issue.number}: ללא-חוזה-בנייה-תקין — מדולג-כנות`
    await closeIssueWithComment(issue.number, 'מסילת-הבנייה: האישיות-חסרה-חוזה ```build-contract``` תקין — לא-נבנית (אפס-בנייה-עיוורת).', false)
    return
  }
  const proposed = await llmPropose(issue, contract)
  if ('error' in proposed) {
    buildState.lastVerdict = `issue-${issue.number}: llm-error — ${proposed.error}`
    buildState.lastError = proposed.error
    await closeIssueWithComment(issue.number, `מסילת-הבנייה: כשל-LLM כן — ${proposed.error}. האישיות-נשארת-פתוחה.`, false)
    return
  }
  const guard = patchGuard(proposed, contract)
  if (!guard.ok) {
    buildState.lastVerdict = `issue-${issue.number}: patch-guard-דחה — ${guard.reason}`
    await closeIssueWithComment(issue.number, `מסילת-הבנייה: שער-התיקונים דחה — ${guard.reason}. אפס-החלה.`, false)
    return
  }
  // גיבוי-מקור → החלה → בדיקות-האיבר → שחזור-בכשל
  const organDir = join(ROOT, 'mini-services', contract.organ)
  const backups = new Map<string, string | null>()
  for (const f of proposed) {
    const p = join(ROOT, f.path)
    backups.set(p, existsSync(p) ? readFileSync(p, 'utf8') : null)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, f.content)
  }
  try {
    const t = runBunTest(organDir)
    const verdict = buildVerdict(t.tail, t.pass, t.fail, t.ok ? 0 : 1)
    if (!verdict.ok) {
      for (const [p, orig] of backups) {
        if (orig === null) {
          Bun.spawnSync(['rm', '-f', p])
        } else {
          writeFileSync(p, orig)
        }
      }
      buildState.reverted++
      buildState.lastVerdict = `issue-${issue.number}: כשל-בדיקות (${verdict.reason}) — שוחזר-מלא`
      await closeIssueWithComment(issue.number, `מסילת-הבנייה: התיקון-נדד-והסוללה-אדומה (${verdict.reason}) — שוחזר-מלא-וכנה. זנב:\n\`\`\`\n${t.tail.slice(0, 2_000)}\n\`\`\``, false)
      return
    }
    const msg = `feat(${contract.organ}): architect build lane — issue #${issue.number} (auto-TDD, tests ${t.pass} pass)`
    const g = gitCommitAndPush(proposed.map((f) => f.path), msg)
    if (!g.ok) {
      buildState.lastVerdict = `issue-${issue.number}: בדיקות-ירוקות-אך-הדחיפה-נכשלה — ${g.tail.slice(0, 120)}`
      buildState.lastError = g.tail.slice(0, 300)
      await closeIssueWithComment(issue.number, `מסילת-הבנייה: הסוללה-ירוקה (${verdict.reason}) אך-הדחיפה-נכשלה — ${g.tail.slice(0, 500)}`, false)
      return
    }
    buildState.merged++
    buildState.lastVerdict = `issue-${issue.number}: מוזג-ל-main (${verdict.reason}, ${proposed.length} קבצים)`
    await closeIssueWithComment(issue.number, `מסילת-הבנייה: ירוק-וממוזג ✅ — ${verdict.reason}; קבצים: ${proposed.map((f) => f.path).join(', ')}.`, true)
  } finally {
    // ניקוי-ביטחון: אם-נשארו-קבצים-שלא-נכללו-בקומיט (שום-דבר-לא-נשאר-זר-בעץ)
    for (const f of proposed) {
      const st = Bun.spawnSync(['git', 'status', '--porcelain', '--', f.path], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
      if (st.stdout.toString().trim()) {
        const orig = backups.get(join(ROOT, f.path))
        if (orig !== null && orig !== undefined) writeFileSync(join(ROOT, f.path), orig)
      }
    }
  }
}
const state = {
  cycles: 0,
  startedAt: new Date().toISOString(),
  lastCycleAt: null as string | null,
  lastSuites: [] as SuiteRow[],
  lastLintOk: null as boolean | null,
  lastIssues: null as { open: number; titles: string[]; error: string | null } | null,
  lastChain: null as { ok: boolean; verified: number; head: string | null; brokenAt: number | null } | null,
  healsFiled: 0,
  lastError: null as string | null,
  busy: false,
}

async function architectCycle(): Promise<void> {
  if (state.busy) return // אפס-חפיפה
  state.busy = true
  const t0 = Date.now()
  try {
    // 1. AUDIT — מדידה-חיה-של-הכל
    const suites: SuiteRow[] = []
    const tails: Record<string, string> = {}
    for (const s of SUITES) {
      const r = runBunTest(s.dir)
      suites.push({ name: s.name, ok: r.ok, pass: r.pass, fail: r.fail })
      tails[s.name] = r.tail
    }
    const lint = runLint()
    const head = gitHead()
    const synced = originSynced()
    const issues = await auditIssues()
    // 2. HEAL — סוללה-אדומה → Issue-כן (תקרה-אחד-למחזור)
    let filed = 0
    for (const s of suites) {
      if (!s.ok && s.fail > 0 && filed === 0) {
        const n = await fileHealIssue(s.name, tails[s.name], s.fail)
        if (n) {
          filed++
          state.healsFiled++
          log(`🩹 ריפוי: Issue-${n} נפתח על ${s.name} (${s.fail} כישלונות — ה-traceback על-האישו)`)
        }
      }
    }
    // 2.5 BUILD (Task-136 §5) — מסילת-הבנייה-העצמית (שערים-מלאים)
    try {
      await buildLane()
    } catch (e) {
      buildState.lastError = e instanceof Error ? e.message : String(e)
      log(`מסילת-בנייה כשלה כן: ${buildState.lastError}`)
    }
    // 3. SIGN — קבלה-hash-linked + אימות-מלא
    const rec = {
      at: new Date().toISOString(),
      cycle: state.cycles + 1,
      suites: suites.map((s) => ({ name: s.name, ok: s.ok, pass: s.pass, fail: s.fail })),
      issues: { open: issues.open, filed },
      gitHead: head,
      originSynced: synced,
    }
    const chainRes = appendReceipt(rec)
    state.cycles++
    state.lastCycleAt = rec.at
    state.lastSuites = suites
    state.lastLintOk = lint.ok
    state.lastIssues = issues
    state.lastChain = chainRes
    state.lastError = null
    // 3.5 PUBLISH (Task-142 §3): execution-state.json + quality/report.json —
    // ארטיפקטים-אמיתיים-מהמדידה-החיה-של-המחזור-הזה (לא-דור-אחד-מוקדם, אין-המצאה).
    try {
      const stateInput = {
        at: rec.at,
        cycle: rec.cycle,
        chain: { ok: chainRes.ok, verified: chainRes.verified, head: chainRes.head },
        git: { head, originSynced: synced },
        suites,
        lintOk: lint.ok,
        issues: { open: issues.open, filed },
        build: { attempts: buildState.attempts, merged: buildState.merged, reverted: buildState.reverted, lastVerdict: buildState.lastVerdict },
      }
      writeFileSync(EXECUTION_STATE_PATH, JSON.stringify(buildExecutionState(stateInput), null, 2) + '\n')
      writeFileSync(QUALITY_REPORT_PATH, JSON.stringify(buildQualityReport(stateInput), null, 2) + '\n')
    } catch (e) {
      log(`הפצת-ארטיפקטי-מדינה-נכשלה-כן: ${e instanceof Error ? e.message : String(e)}`)
    }
    const red = suites.filter((s) => !s.ok).map((s) => s.name)
    log(
      `מחזור-${state.cycles} (${Date.now() - t0}ms): סוללות ${suites.filter((s) => s.ok).length}/${suites.length} ירוקות` +
      `${red.length ? ` (אדומות: ${red.join(',')})` : ''} · lint=${lint.ok ? 'ירוק' : 'אדום'} · issues=${issues.open}פתוחות` +
      ` · git=${head}${synced === null ? '' : synced ? '==origin' : '≠origin'} · שרשרת=${chainRes.verified} מאומתות (ok:${chainRes.ok})`,
    )
  } catch (e) {
    state.lastError = e instanceof Error ? e.message : String(e)
    log(`כשל-מחזור (כן): ${state.lastError}`)
  } finally {
    state.busy = false
  }
}

void architectCycle()
setInterval(() => void architectCycle(), CYCLE_MS)

// ── HTTP ─────────────────────────────────────────────────────────────────────
const cors = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

async function handle(req: Request): Promise<Response> {
  const p = new URL(req.url).pathname
  // Task-142 (§3): ארטיפקטי-המדינה-נגישים-מיד — קריאה-טהורה מהקובץ-האחרון-שנכתב.
  // fail-closed: אין-קובץ (המחזור-הראשון-טרם-רץ) → 404-כן, אף-ירוק-מזויף.
  if (p === '/execution-state' || p === '/quality-report') {
    const path = p === '/execution-state' ? EXECUTION_STATE_PATH : QUALITY_REPORT_PATH
    try {
      if (!existsSync(path)) return new Response(JSON.stringify({ ok: false, error: 'not-yet-baked (first cycle pending)' }), { status: 404, headers: cors })
      return new Response(readFileSync(path, 'utf-8'), { headers: cors })
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: cors })
    }
  }
  if (p === '/health' || p === '/') {
    return new Response(JSON.stringify({
      ok: true,
      service: 'saos-architect',
      organ: 'Chief-Sovereign-Architect',
      port: PORT,
      startedAt: state.startedAt,
      cycles: state.cycles,
      lastCycleAt: state.lastCycleAt,
      suitesGreen: state.lastSuites.filter((s) => s.ok).length,
      suitesTotal: state.lastSuites.length,
      lintOk: state.lastLintOk,
      issuesOpen: state.lastIssues?.open ?? null,
      chainVerified: state.lastChain?.verified ?? 0,
      chainOk: state.lastChain?.ok ?? null,
      healsFiled: state.healsFiled,
      build: buildState,
      lastError: state.lastError,
    }), { headers: cors })
  }
  if (p === '/architect/state') {
    return new Response(JSON.stringify({
      ok: true,
      ...state,
      suites: state.lastSuites,
      issues: state.lastIssues,
      chain: state.lastChain,
      cycleMs: CYCLE_MS,
      note: 'הארכיטקט-הריבוני: ביקורת-מדודה → החלטה → ריפוי-עצמי → חתימה-hash-linked (אפס-תלות-במפעיל)',
    }), { headers: cors })
  }
  if (p === '/architect/chain') {
    const chain = readChain()
    const v = verifyChain(chain)
    return new Response(JSON.stringify({
      ok: true,
      verified: v.verified, chainOk: v.ok, head: v.head, brokenAt: v.brokenAt,
      recent: chain.slice(-10).reverse(),
    }), { headers: cors })
  }
  return new Response(JSON.stringify({ ok: false, error: 'not-found' }), { status: 404, headers: cors })
}

log(`הארכיטקט-הריבוני חי על :${PORT} — ביקורת-כל-5-דקות (${SUITES.length} סוללות + lint + גיט + אישיות), חתימה-hash-linked`)
writeFileSync(join(STATE_DIR, 'architect.boot'), new Date().toISOString())
Bun.serve({ port: PORT, fetch: handle })
