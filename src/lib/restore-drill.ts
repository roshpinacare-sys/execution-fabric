// תרגיל-שחזור (Task 70): הוכחה-קבועה שהכפילות-הרחוקה (GitHub) מחזירה-מערכת-שלמה-מאומתת.
//
// רקע: Task 69-b — תרגיל-ידני ראשון הוכיח שחזור-ביט-ביט (clone-טרי → העד-העצמאי אימת
// 610/610, head זהה-לייצור). כאן ההוכחה-הופכת-מבצורה-של-פעם-למכונה: clone-רדוד
// (--depth 1, חסכוני-ברשת) → אימות-שרשרת-עצמאי על עותק-ה-db-המשוחזר
// (prisma-חד-פעמי מעל file-URL נפרד + verifyChain הקנוני) → הצלבת-ראש מול-הייצור
// → חתימת-DRILL בשרשרת-האמת (status/errorClass/outputHash — fail-honest).
//
// היגיינה (חוק-ה-workpath של leak-scan): אפס-נתיבי-מכונה בעץ — ה-credential-helper
// נגזר-מ-process.cwd(); עותקי-העבודה-נולדים-ומתים ב-/tmp (mkdtemp, נמחקים-תמיד).
//
// הגינות-מול-GitHub (docs/BEYOND-GITHUB.md): clone-גיט אינו-נגד-מכסת-ה-REST,
// ובכל-זאת — מינוף-רדוד + דילוג-אם-תרגיל-טרי-מ-30דק' + מנעול-ריצה-בודדת.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { db } from '@/lib/db'
import { appendLedger, sha256Short, verifyChain, GENESIS } from '@/lib/ledger'

const REPO_URL = 'https://github.com/roshpinacare-sys/execution-fabric.git'
const DRILL_TASK = 'restore-drill' // זהות-לוגית בלבד — בשרשרת היא ב-worker (taskId = מפתח-זר ל-Task אמיתית, קונבנציית drill:*)
const DRILL_WORKER = 'drill:restore'
const MIN_INTERVAL_MS = 30 * 60_000
const CLONE_TIMEOUT_MS = 120_000

export interface RestoreDrillResult {
  ok: boolean
  ran: boolean
  reason?: string
  errorClass?: string | null
  verified?: number
  total?: number
  cloneHead?: string | null
  prodHead?: string | null
  prefixMatch?: boolean
  durationMs?: number
  at: string
  ledgerId?: number
}

export interface LastDrillBrief {
  at: string
  ok: boolean
  ledgerId: number
  durationMs: number
  errorClass: string | null
}

export async function lastRestoreDrill(): Promise<LastDrillBrief | null> {
  const rec = await db.ledgerEntry.findFirst({
    where: { kind: 'DRILL', worker: DRILL_WORKER },
    orderBy: { id: 'desc' },
  })
  if (!rec) return null
  return {
    at: rec.createdAt.toISOString(),
    ok: rec.status === 'DONE',
    ledgerId: rec.id,
    durationMs: rec.durationMs,
    errorClass: rec.errorClass,
  }
}

let running = false // מנעול-ריצה-בודדת — שני-POST מקבילים לא יריצו-שני-clone

export async function runRestoreDrill(force = false): Promise<RestoreDrillResult> {
  if (running) {
    return { ok: false, ran: false, reason: 'skipped: drill already running', at: new Date().toISOString() }
  }
  running = true
  const started = Date.now()
  try {
    const last = await lastRestoreDrill()
    if (!force && last && Date.now() - new Date(last.at).getTime() < MIN_INTERVAL_MS) {
      return {
        ok: last.ok,
        ran: false,
        reason: 'skipped: recent drill within 30min',
        at: last.at,
        ledgerId: last.ledgerId,
      }
    }

    const helper = path.join(process.cwd(), '.zscripts', 'git-credential-pat.sh')
    const dir = mkdtempSync(path.join(tmpdir(), 'fabric-drill-'))
    try {
      execFileSync(
        'git',
        ['clone', '--depth', '1', '--single-branch', '--branch', 'main', '-c', `credential.helper=${helper}`, REPO_URL, dir],
        { timeout: CLONE_TIMEOUT_MS, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      )
      const cloneDb = path.join(dir, 'db', 'custom.db')
      if (!existsSync(cloneDb)) throw new Error('clone-db-missing')

      const prodRec = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
      const prodHead = prodRec?.hash ?? GENESIS
      const prodTotal = prodRec?.id ?? 0

      // קורא-חד-פעמי על-עותק-השחזור — ה-db-הייצור-שלי לא נוגע-כלל
      const reader = new PrismaClient({ datasources: { db: { url: `file:${cloneDb}` } } })
      let verified: number
      let total: number
      let cloneHead: string
      try {
        const entries = await reader.ledgerEntry.findMany({ orderBy: { id: 'asc' } })
        total = entries.length
        const v = verifyChain(entries)
        if (!v.ok) throw new Error(`clone-chain-broken-at-${v.brokenAt}`)
        verified = v.verified
        cloneHead = v.head
      } finally {
        await reader.$disconnect()
      }

      // הצלבה-נכונה למערכת-חיה (לקח-הרצה-ראשונה, Task 70): הייצור גדל-בין-דחיפות —
      // שוויון-ראש-מלא אינו-הקריטריון. קריטריון-האמת: העותק-המשוחזר = קידומת-מאומתת
      // של השרשרת-החיה — hash-העותק בגובה-סדר-העותק זהה-ביט-ביט ל-hash-הייצור-שם.
      // הזנב-שנולד-אחרי-הדחיפה-האחרונה מכוסה-על-ידי-פעימת-הדופק (כל-15דק').
      if (total > prodTotal) {
        throw new Error(`clone-ahead-of-production clone=${total} prod=${prodTotal}`)
      }
      const anchor = await db.ledgerEntry.findFirst({ where: { id: total } })
      if (!anchor || anchor.hash !== cloneHead) {
        throw new Error(`clone-not-a-prefix seq=${total} clone=${cloneHead.slice(0, 8)} prod=${anchor?.hash.slice(0, 8) ?? 'missing'}`)
      }
      const durationMs = Date.now() - started
      const entry = await appendLedger({
        taskId: null,
        kind: 'DRILL',
        status: 'DONE',
        worker: DRILL_WORKER,
        attempts: 1,
        durationMs,
        errorClass: null,
        outputHash: sha256Short(`restore:${verified}/${total}:${cloneHead}`),
      })
      return {
        ok: true,
        ran: true,
        verified,
        total,
        cloneHead,
        prodHead,
        prefixMatch: true,
        durationMs,
        at: entry.createdAt.toISOString(),
        ledgerId: entry.id,
      }
    } finally {
      rmSync(dir, { recursive: true, force: true }) // העותק-נולד-ומת — לעולם-לא-מצטבר
    }
  } catch (e) {
    const durationMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    const errorClass = msg.startsWith('clone-chain-broken')
      ? 'clone-chain-broken'
      : msg.startsWith('clone-')
        ? 'clone-not-prefix'
        : 'clone-failed'
    try {
      const entry = await appendLedger({
        taskId: null,
        kind: 'DRILL',
        status: 'FAILED',
        worker: DRILL_WORKER,
        attempts: 1,
        durationMs,
        errorClass,
        outputHash: sha256Short(''),
      })
      return {
        ok: false,
        ran: true,
        reason: msg,
        errorClass,
        durationMs,
        at: entry.createdAt.toISOString(),
        ledgerId: entry.id,
      }
    } catch {
      // אם-גם-החתימה-נכשלה (שרשרת-לא-כתיבה) — מדווחים-בכנות-בלי-רישום
      return { ok: false, ran: true, reason: msg, errorClass, durationMs, at: new Date().toISOString() }
    }
  } finally {
    running = false
  }
}
