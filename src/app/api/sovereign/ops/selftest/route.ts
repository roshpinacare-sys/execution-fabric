import { NextRequest, NextResponse } from 'next/server'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { appendLedger, sha256Short } from '@/lib/ledger'

// בדיקת-סרט-כלים עצמית (Task 44): POST /api/sovereign/ops/selftest
// האוטונומיה מפעילה את **כל הכלים שלה** בקריאות אמיתיות ומדווחת בכנות —
// כלי שנכשל = רשום כנה, אין ירוק-שקר. זו ההוכחה ש"האוטונומיה יודעת להשתמש
// בכלים שנעשו" — לא הצהרה, אלא ירי חי וחתימת-שרשרת (AUDIT, worker=sovereignty-selftest).
//
// הכלים הנבדקים (מתוך machineContract של GET /api/sovereign/ops):
//   health · census · ops-snapshot · improvements · db-reconnect ·
//   worker-tick (עבודה אמיתית) · autonomy-tick (החוק בפעולה) · drill (LLM אמיתי דו-מסילתי)

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface ToolResult {
  tool: string
  endpoint: string
  ok: boolean
  ms: number
  detail: string
}

async function probe(
  tool: string,
  endpoint: string,
  url: string,
  method: 'GET' | 'POST',
  validate: (j: Record<string, unknown>, status: number) => string | null
): Promise<ToolResult> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(240_000) })
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const ms = Date.now() - t0
    const problem = validate(j, res.status)
    return problem
      ? { tool, endpoint, ok: false, ms, detail: problem }
      : { tool, endpoint, ok: true, ms, detail: `${method} ${res.status}` }
  } catch (e) {
    return {
      tool,
      endpoint,
      ok: false,
      ms: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  const origin = req.nextUrl.origin

  const results: ToolResult[] = []

  results.push(
    await probe('health', 'GET /api/health', `${origin}/api/health`, 'GET', (j) =>
      j.ok === true && j.db === true ? null : 'ok/db לא אמת'
    )
  )
  results.push(
    await probe('census', 'GET /api/census', `${origin}/api/census`, 'GET', (j) => {
      const census = j.census as { chain?: { verify?: { ok?: boolean } } } | undefined
      return census?.chain?.verify?.ok === true ? null : 'chain verify לא אמת'
    })
  )
  // Task 72 — הזקיפה (survival-keeper :3051): עדות-הישרדות חתומה-בשרשרת כל-סבב-selftest.
  // תקינות = הזקיפה חיה ושני-המוגנים (לב+עד) מדווחים-חיים-דרכה. fail-honest: כשל = רשום-כן.
  results.push(
    await probe('keeper', 'GET survival-keeper :3051/health', 'http://127.0.0.1:3051/health', 'GET', (j) => {
      const w = j.watches as
        | Record<string, { up?: boolean; restarts?: number }>
        | undefined
      if (j.ok !== true) return 'keeper לא ok'
      if (!w?.heartbeat?.up || !w?.witness?.up)
        return `מוגנים-לא-חיים דרך-הזקיפה (לב:${!!w?.heartbeat?.up}, עד:${!!w?.witness?.up})`
      return null // החייאות-מתועדות>0 הן-ראיה-טובה, לא-בעיה (הראיה-חיה גם ב-census/badge)
    })
  )
  results.push(
    await probe('ops-snapshot', 'GET /api/sovereign/ops', `${origin}/api/sovereign/ops`, 'GET', (j) =>
      j.ok === true ? null : 'ops לא ok'
    )
  )
  results.push(
    await probe('improvements', 'GET /api/sovereign/improvements', `${origin}/api/sovereign/improvements?limit=5`, 'GET', (j) =>
      j.ok === true ? null : 'improvements לא ok'
    )
  )
  results.push(
    await probe('db-reconnect', 'POST /api/admin/db-reconnect', `${origin}/api/admin/db-reconnect`, 'POST', (j) =>
      j.ok === true && j.reconnected === true ? null : 'חיבור-מחדש נכשל'
    )
  )
  results.push(
    await probe('worker-tick', 'POST /api/worker/tick', `${origin}/api/worker/tick`, 'POST', (j) =>
      j.ok === true ? null : 'worker-tick לא ok'
    )
  )
  results.push(
    await probe('autonomy-tick', 'POST /api/sovereign/ops/tick', `${origin}/api/sovereign/ops/tick`, 'POST', (j) =>
      j.ok === true ? null : 'tick לא ok'
    )
  )
  results.push(
    await probe('drill', 'POST /api/drill', `${origin}/api/drill`, 'POST', (j) => {
      const rails = (j.rails ?? []) as Array<{ rail: string; ok: boolean; errorClass: string | null }>
      return Array.isArray(rails) && rails.length > 0 && rails.every((r) => r.ok)
        ? null
        : `מסילות: ${rails.map((r) => `${r.rail}:${r.ok ? 'חי' : `נכשל(${r.errorClass ?? '?'})`}`).join(', ')}`
    })
  )

  const allOk = results.every((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  const report = {
    at: new Date().toISOString(),
    allOk,
    tools: results.length,
    passed: results.length - failed.length,
    durationMs: Date.now() - t0,
    failures: failed.map((f) => ({ tool: f.tool, detail: f.detail })),
  }

  // מחזור-הרפואה-החיה (2026-10-20): תיקון-ירוק-שקר — הלקח-החי:
  // הזקיפה מתה 03:40, סבב-ה-selftest של 04:20 חתם "AUDIT DONE" עם-errorClass=tool-failed —
  // כותרת-ירוקה, אמת-אדומה בהערת-שוליים. כל-צרכן-של-השרשרת (census, badges, ביקורות) קורא-סטטוס.
  // מעתה: כישלון = status FAILED בראש-הרשומה (הקנון-של-DRILL-FAILED/PLAN-FAILED באותה-שרשרת).
  // והדוח-המלא-נאטם-כארטיפקט-חי (sovereign/site — נכלל-באוטומט בחותמת-המסמכים) — הראיה
  // ניתנת-לשחזור-ולקריאה, לא-רק-גיבוב-אטום. דוחות-הצלחה-אינם-נאטמים (רעש = עלות-אמת).
  if (!allOk) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const failedList = failed
      .map((f) => `| ${f.tool} | ${f.endpoint} | ${f.detail} |`)
      .join('\n')
    const doc = [
      '---',
      `title: "דוח-selftest-כושל — ${report.passed}/${report.tools} כלים עברו"`,
      'kind: AUDIT',
      'status: CLOSED',
      `createdAt: ${report.at}`,
      'worker: sovereignty-selftest',
      `summary: "סבב-selftest נכשל: ${failed.length} כלים — ${failed.map((f) => f.tool).join(', ')}; הרשומה-בשרשרת חתומה FAILED."`,
      '---',
      '',
      '# דוח-selftest-כושל',
      '',
      `| כלי | שער | כשל |`,
      `|---|---|---|`,
      failedList,
      '',
      `durationMs: ${report.durationMs} · outputHash: ראו-רשומת-ה-AUDIT-החתומה.`,
      '',
    ].join('\n')
    try {
      writeFileSync(
        path.join(process.cwd(), 'sovereign', 'site', `${ts}-selftest-failure.md`),
        doc,
        'utf8'
      )
    } catch {
      // fail-honest: אם-אטימת-הדוח-נכשלת-החתימה-עדיין-יוצאת-FAILED — האמת-לא-נגרעת
    }
  }

  await appendLedger({
    taskId: null,
    kind: 'AUDIT',
    status: allOk ? 'DONE' : 'FAILED',
    worker: 'sovereignty-selftest',
    attempts: 1,
    durationMs: report.durationMs,
    errorClass: allOk ? null : 'tool-failed',
    outputHash: sha256Short(JSON.stringify({ report, results })),
  })

  return NextResponse.json({ ok: true, selftest: report, results })
}
