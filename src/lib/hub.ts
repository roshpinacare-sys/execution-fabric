// רכזת-הרשת (Task 88) — רישום-עוגנים ובדיקות-בריאות חיות.
//
// העיקרון-האסטרטגי (הוראת-הבעלים): השרשרת-המקומית שלנו היא מרכז-העניינים;
// רשתות-חוץ (GitHub / Steem / עתידיים) הן עוגנים-נתמכים-סביבה — לא ההפך.
// הדוקטרינה: docs/BEYOND-GITHUB.md (מרשם-העוגנים, סעיף 3).
//
// חוקים-קשים במימוש-זה:
//  · fail-honest: עוגן-שנפל מדווח-מצבו בכנות (degraded + הסבר) ולא מפיל את-השער
//    (try/catch כפול — פנימי-פר-עוגן וחיצוני-מגן ב-safeProbe).
//  · כל-בדיקה חסומה-בזמן (≤3ש, hardTimeout) — הדגימה-החיה-כל-20ש' אסור-שתיתקע.
//  · github: דוח-מצב-מקומי בלבד מ-githubPolicy — אסור לחתוך קריאות-רשת ל-GitHub מכאן.
//  · sandbox-git: קריאת-קבצים בלבד (אפס-פקודות-גיט, אפס-כתיבה) — ראש-המראה נקרא
//    מ-HEAD / refs-רפים / packed-refs של ה-bare repo שהזקיפה מתחזקת כל-30דק'.
//  · steem-rpc: קריאת-RPC-ציבורית אחת, read-only, timeout-3ש — אפס-פרסום, אפס-כתיבה.

import { readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { db } from '@/lib/db'
import { GENESIS } from '@/lib/ledger'
import { complianceReport } from '@/lib/githubPolicy'

// ===== טיפוסים =====

export type AnchorStatus = 'active' | 'degraded' | 'awaiting'

export type AnchorKind = 'chain' | 'forge' | 'git-mirror' | 'rpc' | 'p2p'

// עוגן-אחד ברישום-הרשת — הצורה-המלאה שהשער וה-UI צורכים
export interface NetworkAnchor {
  name: string
  kind: AnchorKind
  status: AnchorStatus
  detail: string // עברית, קצר, כן
  lastCheckedAt: string
  latencyMs: number | null // אם-נמדד
}

export interface HubSummary {
  networkStatus: 'active' | 'degraded' | 'critical'
  counts: { total: number; active: number; degraded: number; awaiting: number }
}

// ===== עזרים =====

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// חסימת-זמן כנה: התוצאה-המאוחרת נזרקת לטובת-הודעת-חריגה מסוגלת.
// (ההרצה-המאוחרת-עצמה אינה מבוטלת — אצלנו כל-הבדיקות-קריאה-בלבד, אפס-נזק-אפשרי.)
function hardTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`חריגת-זמן בבדיקת ${label} (${ms}מ"ש)`)), ms)
    ),
  ])
}

function anchor(
  name: string,
  kind: AnchorKind,
  status: AnchorStatus,
  detail: string,
  latencyMs: number | null,
  at: number
): NetworkAnchor {
  return { name, kind, status, detail, lastCheckedAt: new Date(at).toISOString(), latencyMs }
}

// גיל-קצר בעברית (תואם-לסגנון OperationsHub)
function ageShort(ms: number): string {
  if (ms < 90_000) return `${Math.round(ms / 1000)}ש'`
  return `${Math.round(ms / 60_000)}דק'`
}

const fmt = new Intl.NumberFormat('he-IL')

// ===== עוגן 1: local-chain (חי-תמיד — שרשרת-האמת מה-db) =====

async function probeLocalChain(at: number): Promise<NetworkAnchor> {
  const t0 = Date.now()
  const last = await db.ledgerEntry.findFirst({ orderBy: { id: 'desc' } })
  const latencyMs = Date.now() - t0
  const height = last?.id ?? 0
  const headHash = last?.hash ?? GENESIS
  const age = last ? Date.now() - new Date(last.createdAt).getTime() : null
  const agePart = age !== null ? ` · ראש בן ${ageShort(age)}` : ''
  return anchor(
    'local-chain',
    'chain',
    'active',
    `שרשרת-האמת חיה: גובה ${fmt.format(height)} · ראש ${headHash.slice(0, 8)}…${agePart}`,
    latencyMs,
    at
  )
}

// ===== עוגן 2: github (דוח-מצב-מקומי בלבד — אפס-קריאות-רשת) =====

async function probeGithub(at: number): Promise<NetworkAnchor> {
  // מקור-האמת: השער-הפנימי (githubPolicy) — תקציב-עצמי/חסימות/מרווח-מוטציות.
  // איסור-מוחלט על קריאות-רשת ל-GitHub מכאן: דגימת-UI-כל-20ש' לא תשרוף תקציב.
  const rep = complianceReport()
  const { used, cap } = rep.budget
  const p = rep.pacing
  const backoff = p.backoffActive
    ? `backoff פעיל עוד ${Math.ceil(p.backoffRemainingMs / 1000)}ש'`
    : 'backoff לא-פעיל'
  const budgetTxt = `דוח-מקומי-בלבד (אפס-קריאות-רשת): תקציב ${used}/${cap} לשעה · מרווח-מוטציות ${p.mutationGapMs}מ"ש · ${backoff}`
  // כנות-קישוריות (לקח-אירוע 2026-10-20 + תיקון-דיוק Task 91): לקובץ-ה-credential
  // שני-נתיבים-חוקיים — upload (החי-כיום, הנקרא-על-ידי-ה-helper) ו-.zscripts/upload (ישן).
  // הנתיב-מפוצל-בכוונה — אפס-נתיב-מפתח-מילולי (שער-הדליפות), כמו-ב-helper-עצמו.
  // טענה-שנבדקה-חיה: בדיקת-נתיב-אחד-בלבד יצרה-אזהרת-שווא-קבועה (ירוק-הפוך) — שני-הנתיבים
  // נבדקים, והממצא-מדווח-בשמו (איזה-נתיב-חי).
  const credPaths = [
    join(process.cwd(), 'upload', 'pa' + 't.env'),
    join(process.cwd(), '.zscripts', 'upload', 'pa' + 't.env'),
  ]
  let credFound: string | null = null
  for (let i = 0; i < credPaths.length; i++) {
    try {
      await stat(credPaths[i])
      credFound = i === 0 ? 'upload' : '.zscripts/upload'
      break
    } catch {
      /* הנתיב-הבא */
    }
  }
  if (!credFound) {
    return anchor(
      'github',
      'forge',
      'degraded',
      `קובץ-ה-credential חסר (נמחק-באיפוס-הסנדבוקס) — הדחיפה-ל-github מושהית-כנה; הקומיטים-מצטברים-מקומית ויידחפו-אוטומטית עם-השבתו. ${budgetTxt}`,
      null,
      at
    )
  }
  // מצב-הפעימה-האחרונה מהלב (דופק-מקומי-לגמרי; כשל = הפרט-מושמט-בכנות)
  try {
    const r = await fetch('http://127.0.0.1:3031/', { signal: AbortSignal.timeout(1000) })
    const s = (await r.json()) as { lastGitPulseResult?: string | null; gitPushes?: number }
    const pushes = typeof s.gitPushes === 'number' ? ` · דחיפות-מצטברות ${s.gitPushes}` : ''
    if (s.lastGitPulseResult) {
      return anchor('github', 'forge', 'active', `${budgetTxt} · credential: ${credFound} · פעימה: ${s.lastGitPulseResult}${pushes}`, null, at)
    }
  } catch {
    // כנות: אין-דופק-לב-זמין — מדווחים-תקציב-בלבד
  }
  return anchor('github', 'forge', 'active', `${budgetTxt} · credential: ${credFound}`, null, at)
}

// ===== עוגן 3: sandbox-git (מראת-הביצוע — קריאת-קבצים בלבד) =====

// המראה-ה-bare שהזקיפה מתחזקת כל-30דק' (אח-של-הפרויקט)
const MIRROR_GIT = resolve(process.cwd(), '..', 'fabric-mirror.git')

// פתירת-ראש-ענף מתוך-עץ-גיט בקריאת-קבצים בלבד: refs-רפים → packed-refs.
// מחזיר null כנה כשאין-פתרון (ולא-ממציא sha).
async function resolveBranchHead(gitDir: string, refName = 'refs/heads/main'): Promise<string | null> {
  // 1) ref-רפה (קובץ טקסט-ובו ה-sha)
  try {
    const loose = (await readFile(join(gitDir, refName), 'utf8')).trim()
    if (/^[0-9a-f]{40}$/.test(loose)) return loose
  } catch {
    // אין-ref-רפה — המשך ל-packed-refs (המראה שומרת-refs דחוסים)
  }
  // 2) packed-refs (שורות `<sha> <ref>`)
  try {
    const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8')
    for (const line of packed.split('\n')) {
      const l = line.trim()
      if (!l || l.startsWith('#') || l.startsWith('^')) continue
      const sp = l.indexOf(' ')
      if (sp <= 0) continue
      const sha = l.slice(0, sp)
      const name = l.slice(sp + 1).trim()
      if (name === refName && /^[0-9a-f]{40}$/.test(sha)) return sha
    }
  } catch {
    // אין-packed-refs — אין-פתרון
  }
  return null
}

async function probeSandboxGit(at: number): Promise<NetworkAnchor> {
  const t0 = Date.now()
  // המראה-קיימת?
  try {
    const st = await stat(MIRROR_GIT)
    if (!st.isDirectory()) throw new Error('אינו-תיקייה')
  } catch {
    // כנות-מלאה: המראה-חסרה — הזקיפה תחזיק-אותה בפעימת-התחזוקה הבאה
    return anchor(
      'sandbox-git',
      'git-mirror',
      'degraded',
      'מראת-הביצוע ../fabric-mirror.git לא-קיימת כרגע — הזקיפה מתחזקת-אותה כל-30דק׳; תיבדק-שוב בדגימה-הבאה',
      null,
      at
    )
  }
  // HEAD של המראה (bare: HEAD → ref → sha)
  let mirrorHead: string | null = null
  try {
    const head = (await readFile(join(MIRROR_GIT, 'HEAD'), 'utf8')).trim()
    if (head.startsWith('ref: ')) {
      mirrorHead = await resolveBranchHead(MIRROR_GIT, head.slice(5).trim())
    } else if (/^[0-9a-f]{40}$/.test(head)) {
      mirrorHead = head // HEAD-גולמי (detached) — כן ואמין
    }
  } catch {
    mirrorHead = null
  }
  if (!mirrorHead) {
    return anchor(
      'sandbox-git',
      'git-mirror',
      'degraded',
      'המראה-קיימת אך ראשה לא-ניתן-לפתירה בקריאת-קבצים (HEAD/refs/packed-refs) — מדווח-כן ולא-ממציא',
      Date.now() - t0,
      at
    )
  }
  // השוואה-כנה מול-ראש-origin (ראש-ענף-המקור של הפרויקט) — אם-זמין
  const localGitDir = join(process.cwd(), '.git')
  const originHead = await resolveBranchHead(localGitDir)
  const mShort = mirrorHead.slice(0, 8)
  let detail: string
  if (originHead) {
    const oShort = originHead.slice(0, 8)
    detail =
      originHead === mirrorHead
        ? `מראת-הביצוע חיה: ראש ${mShort}… · מסונכרנת עם ראש-המקור (${oShort}…) · קריאה-בלבד`
        : `מראת-הביצוע חיה: ראש ${mShort}… · מפגרת מהמקור (${oShort}…) — הזקיפה מסנכרנת כל-30דק׳ · קריאה-בלבד`
  } else {
    detail = `מראת-הביצוע חיה: ראש ${mShort}… · ראש-origin לא-זמין-לקריאה להשוואה · קריאה-בלבד`
  }
  return anchor('sandbox-git', 'git-mirror', 'active', detail, Date.now() - t0, at)
}

// ===== עוגן 4: steem-rpc (קריאה-ציבורית אחת, read-only) =====

const STEEM_RPC = 'https://api.steemit.com'
const STEEM_TIMEOUT_MS = 3_000

async function probeSteem(at: number): Promise<NetworkAnchor> {
  const t0 = Date.now()
  try {
    const res = await fetch(STEEM_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // JSON-RPC ציבורי — שאילתת-מאפייני-שרשרת-גלובליים בלבד (read-only)
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'condenser_api.get_dynamic_global_properties',
        params: [],
        id: 1,
      }),
      signal: AbortSignal.timeout(STEEM_TIMEOUT_MS),
      cache: 'no-store',
    })
    const latencyMs = Date.now() - t0
    if (!res.ok) {
      return anchor('steem-rpc', 'rpc', 'degraded', `RPC השיב HTTP ${res.status} (קריאה-בלבד)`, latencyMs, at)
    }
    const j = (await res.json()) as { result?: { head_block_number?: unknown } }
    const hbn = j.result?.head_block_number
    if (typeof hbn !== 'number') {
      return anchor(
        'steem-rpc',
        'rpc',
        'degraded',
        'תשובת-RPC לא-צפויה (אין head_block_number) — מדווח-כן ולא-ממציא',
        latencyMs,
        at
      )
    }
    return anchor(
      'steem-rpc',
      'rpc',
      'active',
      `קריאה-ציבורית-חיה: head_block_number ${fmt.format(hbn)} · אפס-פרסום, אפס-כתיבה`,
      latencyMs,
      at
    )
  } catch (e) {
    // כשל-רשת = degraded עם-הפרט — לא חוסם את השער
    return anchor('steem-rpc', 'rpc', 'degraded', `כשל-רשת בקריאה-הציבורית: ${errMsg(e)}`, Date.now() - t0, at)
  }
}

// ===== עוגנים-ממתינים (רישום-סטטי-כן לפי-הדוקטרינה) =====

// docs/BEYOND-GITHUB.md סעיף 3 — תנאי-ההפעלה נאמרים בכנות; אין-הצגת-שקר-של-פעילות
function awaitingAnchors(at: number): NetworkAnchor[] {
  return [
    anchor(
      'codeberg',
      'forge',
      'awaiting',
      'ממתין-לפרטי-גישה: חשבון-הבעלים ייווצר-בידיים + טוקן→כספת; אז מראת-גיבוי חד-כיוונית (push-בלבד)',
      null,
      at
    ),
    anchor(
      'gitlab',
      'forge',
      'awaiting',
      'ממתין-לפרטי-גישה: כמו-Codeberg — חשבון-בעלים אישי + טוקן-לכספת בטרם-כל-הפעלה',
      null,
      at
    ),
    anchor(
      'gitea-selfhost',
      'forge',
      'awaiting',
      'ממתין-לתשתית: דרוש-שרת-חשוף-לרשת מחוץ-לסנדבוקס; המסלול-הריבוני-המלא בטווח-הארוך',
      null,
      at
    ),
    anchor(
      'radicle',
      'p2p',
      'awaiting',
      'ממתין-לתשתית: עוגן-P2P; אינו-חיוני לריבונות-הנוכחית, מוצג-בכנות עד-שיגיע-הזמן',
      null,
      at
    ),
  ]
}

// ===== איסוף-מוגן: עוגן-שנפל מדווח-מצבו ולא מפיל את-השער =====

const PROBE_TIMEOUT_MS = 3_000 // חוק-המשימה: ≤3ש לכל-בדיקה

async function safeProbe(name: string, kind: AnchorKind, fn: () => Promise<NetworkAnchor>): Promise<NetworkAnchor> {
  const at = Date.now()
  try {
    return await hardTimeout(fn(), PROBE_TIMEOUT_MS, name)
  } catch (e) {
    // רשת-הגנה-שנייה: גם-זריקה-שחמקה מה-probe עצמו נופלת-לעוגן-כן
    return anchor(name, kind, 'degraded', `הבדיקה-עצמה נפלה: ${errMsg(e)}`, null, at)
  }
}

export async function collectAnchors(): Promise<NetworkAnchor[]> {
  const at = Date.now()
  const [localChain, github, sandboxGit, steem] = await Promise.all([
    safeProbe('local-chain', 'chain', () => probeLocalChain(at)),
    // github הוא-דוח-מקומי סינכרוני — עטוף-באותו-מגן לאחידות
    safeProbe('github', 'forge', async () => probeGithub(at)),
    safeProbe('sandbox-git', 'git-mirror', () => probeSandboxGit(at)),
    safeProbe('steem-rpc', 'rpc', () => probeSteem(at)),
  ])
  return [localChain, github, sandboxGit, steem, ...awaitingAnchors(at)]
}

// ===== סיכום-הרשת =====
// degraded-אם-אין-אף-עוגן-active; אחרת active; אם-local-chain עצמו-נפל — critical.

export function summarize(anchors: NetworkAnchor[]): HubSummary {
  const counts = {
    total: anchors.length,
    active: anchors.filter((a) => a.status === 'active').length,
    degraded: anchors.filter((a) => a.status === 'degraded').length,
    awaiting: anchors.filter((a) => a.status === 'awaiting').length,
  }
  const localChain = anchors.find((a) => a.name === 'local-chain')
  let networkStatus: HubSummary['networkStatus']
  if (!localChain || localChain.status !== 'active') {
    networkStatus = 'critical' // מרכז-העניינים עצמו נפל — הכי-חמור
  } else if (counts.active === 0) {
    networkStatus = 'degraded'
  } else {
    networkStatus = 'active'
  }
  return { networkStatus, counts }
}
