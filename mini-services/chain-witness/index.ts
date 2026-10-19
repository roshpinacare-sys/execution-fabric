// CHAIN-WITNESS (:3050) — Task 67 · עד-שרשרת עצמאי
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

export interface WitnessVerdict {
  ok: boolean
  total: number
  verified: number
  head: string
  brokenAt: number | null
  checkedInMs: number
  at: string
  reason?: string
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
      // התאמת-טיפוסים מ-sqlite (integers יכולים-להגיע-כ-bigint בהקשרים-מסוימים)
      const rec: Record<string, unknown> = {
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

// === append-only ledger-העדות ===
const recent: WitnessVerdict[] = []
function witness(v: WitnessVerdict) {
  recent.push(v)
  if (recent.length > 100) recent.splice(0, recent.length - 100)
  try { fs.appendFileSync(LOG, JSON.stringify(v) + '\n') } catch {}
}

// poll-קבוע: העד-אינו-מחכה-לבקשות — הוא-בודק-בעצמו, בקצב-קבוע
function tick() {
  const v = verifyAll()
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
        last: last ? { ok: last.ok, total: last.total, head: last.head, at: last.at } : null,
      })
    }
    if (u.pathname === '/witness') {
      const v = verifyAll() // תמיד-טרי — עדות-חיה, לא-מטמון
      witness(v)
      return Response.json(v)
    }
    if (u.pathname === '/events') {
      return Response.json({ ok: true, count: recent.length, events: recent.slice(-50) })
    }
    return Response.json({ ok: false, error: 'not-found', routes: ['/health', '/witness', '/events'] }, { status: 404 })
  },
})

console.log(`[chain-witness] up on :${PORT} — reading ${DB_PATH} every ${POLL_MS / 1000}s, log ${LOG}`)
