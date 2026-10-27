// ═════════════════════════════════════════════════════════════════════════════
// core.ts — הליבה-הטהורה של הארכיטקט-הריבוני (Chief Sovereign Architect, §1/§4)
// שרשרת-הקבלות שלו: אותה-סמנטיקת-hash-linked-שהוכחה-ב-fleet-economy
// (hash = sha256-קנוני.slice(0,32); genesis prev = "GENESIS") — אימות-מלא-בכל-מחזור.
// ═════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto'

export const GENESIS = 'GENESIS'

export interface SuiteRow {
  name: string
  ok: boolean
  pass: number
  fail: number
}

export interface ArchitectReceipt {
  at: string
  cycle: number
  suites: SuiteRow[]
  issues: { open: number; filed: number }
  gitHead: string
  originSynced: boolean | null
  prev: string
}

export interface ChainLine extends ArchitectReceipt {
  hash: string
}

/** השורה-הקנונית — סדר-מפתחות-קבוע, אפס-אמביגואליות (דפוס-שרשרת-האמת). */
function canonical(rec: ArchitectReceipt): string {
  return JSON.stringify({
    at: rec.at,
    cycle: rec.cycle,
    suites: rec.suites.map((s) => ({ name: s.name, ok: s.ok, pass: s.pass, fail: s.fail })),
    issues: { open: rec.issues.open, filed: rec.issues.filed },
    gitHead: rec.gitHead,
    originSynced: rec.originSynced,
    prev: rec.prev,
  })
}

export function receiptHash(rec: ArchitectReceipt): string {
  return createHash('sha256').update(canonical(rec)).digest('hex').slice(0, 32)
}

export interface ChainVerify {
  ok: boolean
  verified: number
  brokenAt: number | null
  head: string
}

/** אימות-מלא מה-Genesis: קישוריות-prev + חישוב-מחדש-של-כל-hash. fail-closed. */
export function verifyChain(lines: ChainLine[]): ChainVerify {
  let prev = GENESIS
  let brokenAt: number | null = null
  let verified = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.prev !== prev) {
      brokenAt = i + 1
      break
    }
    const { hash: _h, ...rec } = l
    void _h
    if (l.hash !== receiptHash(rec as ArchitectReceipt)) {
      brokenAt = i + 1
      break
    }
    prev = l.hash
    verified++
  }
  return { ok: brokenAt === null, verified, brokenAt, head: verified > 0 ? prev : GENESIS }
}

/** ניתוח-פלט-bun-test → מספרים-מדודים. פלט-לא-קריא = {0,0} (אפס-המצאה). */
export function parseBunTestOutput(out: string): { pass: number; fail: number } {
  const pass = /(\d+)\s+pass/.exec(out)
  const fail = /(\d+)\s+fail/.exec(out)
  return {
    pass: pass ? Number(pass[1]) : 0,
    fail: fail ? Number(fail[1]) : 0,
  }
}

// ═══ Task-142 (הדירקטיבה-המוחלטת §3): ארטיפקטי-מדינה-אמיתיים ═══
// execution-state.json + quality/report.json — נולדו-ממחזור-אמת-של-הארכיטקט.
// לפני-כן-לא-היו-קיימים-בשום-מקום (נמדד-26/10-Task-141-d — לא-הומצאו-שם).
// כל-שדה-מדידה-חיה-של-המחזור; אין-ברירת-מחדל-מזויפת; null-כנה-נשמר-כ-null.
export interface ExecutionStateInput {
  at: string
  cycle: number
  chain: { ok: boolean; verified: number; head: string }
  git: { head: string; originSynced: boolean | null }
  suites: SuiteRow[]
  lintOk: boolean | null
  issues: { open: number; filed: number }
  build: { attempts: number; merged: number; reverted: number; lastVerdict: string | null }
}

export interface QualityReportDoc {
  schema: 'saos-quality-report/1'
  at: string
  cycle: number
  totals: { pass: number; fail: number; suites: number }
  suites: SuiteRow[]
  lintOk: boolean | null
  allGreen: boolean
}

export interface ExecutionStateDoc extends QualityReportDoc {
  schema: 'saos-execution-state/1'
  chain: { ok: boolean; verified: number; head: string }
  git: { head: string; originSynced: boolean | null }
  issues: { open: number; filed: number }
  build: { attempts: number; merged: number; reverted: number; lastVerdict: string | null }
}

export function buildQualityReport(input: ExecutionStateInput): QualityReportDoc {
  const pass = input.suites.reduce((s, x) => s + x.pass, 0)
  const fail = input.suites.reduce((s, x) => s + x.fail, 0)
  return {
    schema: 'saos-quality-report/1',
    at: input.at,
    cycle: input.cycle,
    totals: { pass, fail, suites: input.suites.length },
    suites: input.suites.map((s) => ({ name: s.name, ok: s.ok, pass: s.pass, fail: s.fail })),
    lintOk: input.lintOk,
    allGreen: pass > 0 && fail === 0,
  }
}

export function buildExecutionState(input: ExecutionStateInput): ExecutionStateDoc {
  return {
    ...buildQualityReport(input),
    schema: 'saos-execution-state/1',
    chain: { ok: input.chain.ok, verified: input.chain.verified, head: input.chain.head },
    git: { head: input.git.head, originSynced: input.git.originSynced },
    issues: { open: input.issues.open, filed: input.issues.filed },
    build: { attempts: input.build.attempts, merged: input.build.merged, reverted: input.build.reverted, lastVerdict: input.build.lastVerdict },
  }
}
