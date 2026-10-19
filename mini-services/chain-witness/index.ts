// CHAIN-WITNESS (:3050) — Task 67 · עד-שרשרת עצמאי · Task 73 — מחזור-חדשנות #6
//
// דפוס-נלמד-מהתאום (steem · state-witness R271 + SANDBOX-DISTRUST-LAW R241):
// "כל-טענת-אמת חייבת-הוכחה-חיה; הבקרה-המתמדת-היא-הכלל; מחיקה-שקטה-לעולם-לא-שוב-בלי-קבלה".
//
// הבעיה-המדודה-אצלנו: האימות-היחיד-של-השרשרת הוא-סקריפט-ידני (vc.ts) שרץ-רק-בסשנים
// פעילים. בין-סשנים, אם-ה-db-נפגע (מחיקת-סנדבוקס, קורופציה, כתיבה-תועה) — אין-מי-
// יתפוס-את-זה-עד-הסשן-הבא. העד-סוגר-את-החור: recompute-עצמאי-בקצב-קבוע.
//
// חוקי-העד:
// 1. מימוש-קנוניה-עצמאי (שיקוף-מדויק של src/lib/ledger.ts) — לא-ייבוא מהקוד-הראשי.
//    אם-ה-API-הראשי-ידווח-אמת-כוזבת (באג/שחיתות), העד-יחלוק-על-המימוש-שלו-עצמו.
// 2. קריאה-טהורה בלבד: bun:sqlite readonly + fileMustExist. אפס-כתיבה ל-db. אפס-סודות.
// 3. append-only: כל-עדות נרשמת ל-/tmp/chain-witness.log (never rewritten).
// 4. fail-honest: אם-ה-db-לא-קריאה — העד מדווח { ok:false, reason } ולא ממציא מספרים.
// 5. bounded memory: היסטוריית-עדויות בזיכרון — 100-אחרונות בלבד.
//
// מחזור-חדשנות #6 (Task 73) — אימות-מלא-בזרימה + הצלבה-דו-מימושית:
// - עד-Task-67 טען-את-כל-השרשרת-לזיכרון בכל-עדות (O(n)) — פרופיל-זיכרון-שגדל-לנצח
//   בשירות-חי-לנצח. התיקון: keyset pagination (WHERE id > ? LIMIT ?) — אותו-דגם-אמונים
//   (כל-רשומה מה-Genesis, בלי-דלתא, בלי-checkpoint — העד-נשאר-המפקח-המלא), זיכרון
//   O(מנת-אצווה) קבוע.
// - הצלבה-עצמית: כל-פעימה מריצה את שני-המימושים (זרימה + טעינה-מלאה) ומשווה
//   את-התוצאות ביט-ביט. כל-סתירה = self-divergence → ok:false גלוי. שני-מימושים
//   בלתי-תלויים-שחייבים-להסכים-כל-דקה — עד-שבודק-את-עצמו.
// - כנות-מדידה: המדידה-בין-המימושים חתומה-בכל-עדות (streamMs/loadInMs) וב-/bench.
//   אם-הזרימה-איטית-יותר-בקנה-מידה-הנוכחי — זה-נרשם-כפי-שהוא; הסיבה-לאימוץ
//   היא-חסימות-הזיכרון-בצמיחה, לא-מהירות.

import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'

// WITNESS_DB/WITNESS_PORT — override לתרגילי-אש בלבד (עותק-db-פגום ב-/tmp);
// בייצור, ברירת-המחדל נשארת קשיחה: הייצור-האמיתי.
// ברירת-המחדל נגזרת-ממיקום-הסקריפט (mini-services/chain-witness → שורש-המיזם) —
// אפס-נתיבי-מכונה-גולמיים בעץ (חוק-ה-workpath של leak-scan, Task 69-b).
const PORT = Number(process.env.WITNESS_PORT || 3050)
const DB_PATH = process.env.WITNESS_DB || `${import.meta.dir}/../../db/custom.db`
const LOG = '/tmp/chain-witness.log'
const POLL_MS = 60_000
const GENESIS = 'GENESIS'
const STREAM_BATCH = 500

// === הקנוניה — שיקוף-מדויק של ledgerRecordString (Task 12 / Task 61 mutex) ===
// hash = sha256(JSON.stringify({taskId,kind,status,worker,attempts,durationMs,
//        errorClass,outputHash,prev})).slice(0,32); genesis prev = "GENESIS".
// הסדר-קנוני-קבוע; JSON.stringify מכבד-את-סדר-המפתחות-במילולי.
function canonicalString(r: Record<string, unknown>): string {
  return JSON.stringify({
    taskId: r.taskId,
    kind: r.kind,
    status: r.status,
    worker: r.worker,
    attempts: r.attempts,
    durationMs: r.durationMs,
    errorClass: r.errorClass,
    outputHash: r.outputHash,
    prev: r.prev,
  })
}

function recordHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

// בונה-חיבור-קריאה-בכל-עדות מחדש (readonly connection — זול; מבטיח-מצב-דיסק-טרי)
function openReadonly(): Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true })
}

// התאמת-טיפוסים מ-sqlite (integers יכולים-להגיע-כ-bigint בהקשרים-מסוימים) —
// משותף-לשני-המימושים; ההבדל-ביניהם הוא-אך-ורק דפוס-הקריאה-מה-db.
function toRecord(r: Record<string, unknown>): Record<string, unknown> {
  return {
    taskId: r.taskId ?? null,
    kind: r.kind,
    status: r.status,
    worker: r.worker,
    attempts: typeof r.attempts === 'bigint' ? Number(r.attempts) : r.attempts,
    durationMs: typeof r.durationMs === 'bigint' ? Number(r.durationMs) : r.durationMs,
    errorClass: r.errorClass ?? null,
    outputHash: r.outputHash ?? '',
    prev: r.prev,
  }
}

export interface WitnessVerdict {
  ok: boolean
  total: number
  verified: number
  head: string
  brokenAt: number | null
  checkedInMs: number
  at: string
  reason?: string
  /** מחזור-#6: זמן-מימוש-הטעינה-המלאה באותה-פעימה (להצלבת-המדידה) */
  loadInMs?: number
}

function verifyAll(): WitnessVerdict {
  const t0 = performance.now()
  const at = new Date().toISOString()
  const base: WitnessVerdict = { ok: false, total: 0, verified: 0, head: GENESIS, brokenAt: null, checkedInMs: 0, at }
  let dbh: Database
  try {
    dbh = openReadonly()
  } catch (e) {
    return { ...base, reason: `db-unreadable: ${(e as Error).message}` }
  }
  try {
    const rows = dbh
      .prepare(
        'SELECT id, taskId, kind, status, worker, attempts, durationMs, errorClass, outputHash, prev, hash FROM LedgerEntry ORDER BY id ASC'
      )
      .all() as Array<Record<string, unknown> & { id: number; prev: string; hash: string }>
    let prev = GENESIS
    let brokenAt: number | null = null
    let verified = 0
    for (const r of rows) {
      const rec = toRecord(r)
      if (r.prev !== prev || r.hash !== recordHash(canonicalString(rec))) {
        brokenAt = r.id
        break
      }
      prev = r.hash
      verified++
    }
    const head = verified > 0 ? (rows[verified - 1].hash as string) : GENESIS
    return {
      ok: brokenAt === null,
      total: rows.length,
      verified,
      head,
      brokenAt,
      checkedInMs: Math.round((performance.now() - t0) * 1000) / 1000,
      at,
    }
  } catch (e) {
    return { ...base, reason: `verify-error: ${(e as Error).message}` }
  } finally {
    try { dbh.close() } catch {}
  }
}

// === מימוש-הזרימה (מחזור-חדשנות #6): keyset pagination, זיכרון-חסום ===
// אותם-סמנטיקה fail-closed של verifyAll: כל-רשומה נאותת מה-Genesis; total =
// ספירת-הטבלה-המלאה (כמו-בטעינה-מלאה); head = hash-הראש-המאומת (GENESIS אם-אפס).
function verifyStream(): WitnessVerdict {
  const t0 = performance.now()
  const at = new Date().toISOString()
  const base: WitnessVerdict = { ok: false, total: 0, verified: 0, head: GENESIS, brokenAt: null, checkedInMs: 0, at }
  let dbh: Database
  try {
    dbh = openReadonly()
  } catch (e) {
    return { ...base, reason: `db-unreadable: ${(e as Error).message}` }
  }
  try {
    const cnt = dbh.prepare('SELECT COUNT(*) AS c FROM LedgerEntry').get() as { c: number | bigint }
    const total = typeof cnt.c === 'bigint' ? Number(cnt.c) : cnt.c
    const stmt = dbh.prepare(
      'SELECT id, taskId, kind, status, worker, attempts, durationMs, errorClass, outputHash, prev, hash FROM LedgerEntry WHERE id > ? ORDER BY id ASC LIMIT ?'
    )
    let prev = GENESIS
    let brokenAt: number | null = null
    let verified = 0
    let lastId = 0
    while (brokenAt === null) {
      const rows = stmt.all(lastId, STREAM_BATCH) as Array<
        Record<string, unknown> & { id: number; prev: string; hash: string }
      >
      if (rows.length === 0) break
      for (const r of rows) {
        const rec = toRecord(r)
        if (r.prev !== prev || r.hash !== recordHash(canonicalString(rec))) {
          brokenAt = r.id
          break
        }
        prev = r.hash
        verified++
      }
      if (brokenAt !== null) break
      lastId = rows[rows.length - 1].id as number
      if (rows.length < STREAM_BATCH) break
    }
    return {
      ok: brokenAt === null,
      total,
      verified,
      head: verified > 0 ? prev : GENESIS,
      brokenAt,
      checkedInMs: Math.round((performance.now() - t0) * 1000) / 1000,
      at,
    }
  } catch (e) {
    return { ...base, reason: `verify-error: ${(e as Error).message}` }
  } finally {
    try { dbh.close() } catch {}
  }
}

// === הצלבה-דו-מימושית: העדות-המפורסמת היא-רק-עדות-ששני-המימושים מסכימים-עליה ===
function dualVerify(): WitnessVerdict {
  const a = verifyStream()
  const b = verifyAll()
  const agree =
    a.ok === b.ok && a.total === b.total && a.verified === b.verified && a.head === b.head && a.brokenAt === b.brokenAt
  if (agree) return { ...a, loadInMs: b.checkedInMs }
  return {
    ...a,
    ok: false,
    reason: `self-divergence: stream{ok:${a.ok},total:${a.total},verified:${a.verified},head:${a.head}} != load{ok:${b.ok},total:${b.total},verified:${b.verified},head:${b.head}}`,
    loadInMs: b.checkedInMs,
  }
}

// מדידת-השוואה-מרוכזת (GET /bench) — לא-כותבת-שרשרת, לא-נוגעת-בסודות; קריאה-טהורה.
function bench(runs: number) {
  const streamMs: number[] = []
  const loadMs: number[] = []
  let equivalence = true
  let last: WitnessVerdict | null = null
  for (let i = 0; i < runs; i++) {
    const a = verifyStream()
    const b = verifyAll()
    streamMs.push(a.checkedInMs)
    loadMs.push(b.checkedInMs)
    if (
      !(
        a.ok === b.ok &&
        a.total === b.total &&
        a.verified === b.verified &&
        a.head === b.head &&
        a.brokenAt === b.brokenAt
      )
    )
      equivalence = false
    last = a
  }
  const agg = (xs: number[]) => ({
    minMs: Math.min(...xs),
    avgMs: Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 1000) / 1000,
    maxMs: Math.max(...xs),
  })
  const s = agg(streamMs)
  const l = agg(loadMs)
  return {
    ok: true,
    runs,
    equivalence,
    total: last?.total ?? 0,
    verified: last?.verified ?? 0,
    head: last?.head ?? GENESIS,
    stream: s,
    load: l,
    streamOverLoad: Math.round((s.minMs / Math.max(l.minMs, 0.0001)) * 1000) / 1000,
    at: new Date().toISOString(),
  }
}

// === append-only ledger-העדות ===
const recent: WitnessVerdict[] = []
function witness(v: WitnessVerdict) {
  recent.push(v)
  if (recent.length > 100) recent.splice(0, recent.length - 100)
  try { fs.appendFileSync(LOG, JSON.stringify(v) + '\n') } catch {}
}

// poll-קבוע: העד-אינו-מחכה-לבקשות — הוא-בודק-בעצמו, בקצב-קבוע
function tick() {
  const v = dualVerify()
  witness(v)
  if (!v.ok) {
    console.error(`[chain-witness] DRIFT/שבירה: total=${v.total} verified=${v.verified} brokenAt=${v.brokenAt} reason=${v.reason ?? '-'}`)
  }
}
tick()
const timer = setInterval(tick, POLL_MS)
timer.unref()

// === שרת ===
Bun.serve({
  port: PORT,
  fetch(req) {
    const u = new URL(req.url)
    if (u.pathname === '/health') {
      const last = recent.at(-1) ?? null
      return Response.json({
        ok: true,
        service: 'chain-witness',
        at: new Date().toISOString(),
        dbPath: DB_PATH,
        pollMs: POLL_MS,
        last: last
          ? { ok: last.ok, total: last.total, head: last.head, at: last.at, streamMs: last.checkedInMs, loadInMs: last.loadInMs ?? null }
          : null,
      })
    }
    if (u.pathname === '/witness') {
      const v = dualVerify() // תמיד-טרי — עדות-חיה-מוצלבת, לא-מטמון
      witness(v)
      return Response.json(v)
    }
    if (u.pathname === '/events') {
      return Response.json({ ok: true, count: recent.length, events: recent.slice(-50) })
    }
    if (u.pathname === '/bench') {
      const q = Math.max(1, Math.min(60, Number(u.searchParams.get('runs') ?? 15) || 15))
      return Response.json(bench(q))
    }
    return Response.json({ ok: false, error: 'not-found', routes: ['/health', '/witness', '/events', '/bench'] }, { status: 404 })
  },
})

console.log(`[chain-witness] up on :${PORT} — reading ${DB_PATH} every ${POLL_MS / 1000}s (stream+load cross-checked), log ${LOG}`)
