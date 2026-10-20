import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { runTaskChain, type TaskKind } from '@/lib/llm-chain'
import { buildRepoContext, renderRepoContext, ghErrorClass, ghErrorMessage } from '@/lib/github'
import { autoProposeHandoffForTask } from '@/lib/autohandoff'

// המבצע-האמיתי (Task 23 — ריפקטור מ-run-route לשימוש-משותף):
// claim אטומי RUNNING → (יעד-ריפו? הקשר-חי מ-GitHub) → סולם-מועמדים חי
// → כתיבת תוצאה → חתימה בשרשרת. אין פלט מדומה: או תוצר מאומת או FAILED עם errorClass כן.
// משמש גם ידנית (כפתור-הרץ) וגם עובד-הרקע (tick).

// משימה-תקועה ב-RUNNING מעל 10 דקות (למשל הפסקת-שרת באמצע-ירי) ניתנת-לתביעה-מחדש — כמו-שער-ההעברה.
const STALE_RUNNING_MS = 10 * 60_000

// רסן-ביצוע (Task 104): לעולם לא משאירים-חריץ-RUNNING-חי-בלי-חוזה-זמן. השרשרת-עצמה חוסמת
// פר-קריאה (90ש') אך-סולם-מועמדים × פידבק-חוזה יכול-להצטבר-מעל-סף-התביעה-מחדש (10דק') —
// ואז-הסוואף-תובע-מחדש-בזמן-שהביצוע-המקורי-עוד-חי (כפל-ירי + כתיבה-התנגשות).
// החוק-החדש: תקרת-8.5דק' < סף-10דק' — בחריגה, המשימה-נכשלת-כן (class=timeout) ומשחררת-את-החריץ
// מוקדם. הירי-הנטוש-ממשיך-ברקע-בלי-כתיבה (race לא-כותב) — הכנות-שלמה: כשל-חתום, לא-תלייה.
const EXEC_CAP_MS = 8.5 * 60_000

export interface ExecuteResult {
  claimed: boolean
  executed: boolean
  status?: string
  errorClass?: string | null
  error?: string | null
  note?: string
}

export async function executeTaskOnce(id: string): Promise<ExecuteResult> {
  const task = await db.task.findUnique({ where: { id } })
  if (!task) {
    return { claimed: false, executed: false }
  }

  // claim אטומי — מונע הרצה כפולה; ריצה-תקועה מעל-10-דקות נחשבת-מתה ונתבעת-מחדש
  const claim = await db.task.updateMany({
    where: {
      id,
      OR: [
        { status: { not: 'RUNNING' } },
        { status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      ],
    },
    data: { status: 'RUNNING', error: null, errorClass: null },
  })
  if (claim.count === 0) {
    return { claimed: false, executed: false }
  }

  // יעד-ריפו: משיכת-הקשר חי אמיתית. כשל-גיטהאב = כשל-כן חתום-בשרשרת (בלי ירי-LLM שווא)
  let context: string | null = null
  if (task.repo) {
    try {
      const ctx = await buildRepoContext(task.repo)
      context = renderRepoContext(ctx)
    } catch (e) {
      const errorClass = ghErrorClass(e) ?? 'provider'
      const error = ghErrorMessage(e)
      await db.task.update({
        where: { id },
        data: {
          status: 'FAILED',
          worker: 'github-context',
          error,
          errorClass,
          attempts: 0,
          durationMs: 0,
        },
      })
      await appendLedger({
        taskId: id,
        kind: task.kind,
        status: 'FAILED',
        worker: 'github-context',
        attempts: 0,
        durationMs: 0,
        errorClass,
        outputHash: sha256Short(''),
      })
      return { claimed: true, executed: false, status: 'FAILED', errorClass, error, note: 'כשל-הקשר: לא ירה LLM בכנות' }
    }
  }

  const chainStart = Date.now()
  const result = await Promise.race([
    runTaskChain(task.kind as TaskKind, task.title, task.prompt, context ? { context } : undefined),
    new Promise<{ ok: false; worker: 'exhausted'; errorClass: 'timeout'; error: string; attempts: number; durationMs: number }>(
      (resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              worker: 'exhausted',
              errorClass: 'timeout',
              error: `חוזה-זמן: הביצוע-חרג-מ-${Math.round(EXEC_CAP_MS / 60_000)}דק' (רסן-ביצוע Task 104) — החריץ-משוחרר-לפני-סף-התביעה-מחדש`,
              attempts: task.attempts + 1,
              durationMs: Date.now() - chainStart,
            }),
          EXEC_CAP_MS,
        ),
    ),
  ])

  // הקשחה (Task 28): פעימת-הגיט-האוטונומית נוגעת בקובץ-ה-db (commit/push/pull-rebase) —
  // כתיבת-תוצאה יכולה-ליפול בחלון-חולף (readonly-רגעי / P2025 עקב-החלפת-inode תחת-הבריכה).
  // הירי-כבר-שולם — בזבוז-שלו-על-כשל-כתיבה הוא טיפשות-תפעולית. ניסיון-חוזר אחד אחרי-2s.
  // כשל-שני = זריקה-כנה → המשימה נשארת RUNNING-תקועה → ה-tick (Task 28) יתבוע-מחדש-תוך-10-דק'.
  const writeResult = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch {
      await new Promise((r) => setTimeout(r, 2_000))
      await fn()
    }
  }

  if (result.ok) {
    await writeResult(() =>
      db.task.update({
        where: { id },
        data: {
          status: 'DONE',
          worker: result.worker,
          output: JSON.stringify(result.output),
          attempts: result.attempts,
          durationMs: result.durationMs,
          error: null,
          errorClass: null,
        },
      })
    )
    // ה-append נבדל-מה-update — כשל-באחד-לא-מכפיל-את-השני (אין-רשומות-שרשרת-כפולות)
    await writeResult(() =>
      appendLedger({
        taskId: id,
        kind: task.kind,
        status: 'DONE',
        worker: result.worker,
        attempts: result.attempts,
        durationMs: result.durationMs,
        errorClass: null,
        outputHash: result.outputHash,
      })
    )
    // Task 29 — החוליה-החסרה: למידה/התפתחות CODE-DONE-עם-יעד-ריפו → הצעת-העברה-אוטומטית
    // לשער (PROPOSED). כשל-הצעה לא מפיל ביצוע — התוצאה החתומה בשרשרת קודמת; הכנות ב-note.
    let autoHandoffNote: string | undefined
    try {
      const hp = await autoProposeHandoffForTask(id)
      autoHandoffNote = hp.proposed
        ? `auto-handoff: PROPOSED → ${hp.path}`
        : `auto-handoff: skipped (${hp.reason ?? 'unknown'})`
    } catch {
      autoHandoffNote = 'auto-handoff: skipped (exception)'
    }
    return { claimed: true, executed: true, status: 'DONE', note: autoHandoffNote }
  }

  await writeResult(() =>
    db.task.update({
      where: { id },
      data: {
        status: 'FAILED',
        worker: 'exhausted',
        error: result.error,
        errorClass: result.errorClass,
        attempts: result.attempts,
        durationMs: result.durationMs,
      },
    })
  )
  await writeResult(() =>
    appendLedger({
      taskId: id,
      kind: task.kind,
      status: 'FAILED',
      worker: 'exhausted',
      attempts: result.attempts,
      durationMs: result.durationMs,
      errorClass: result.errorClass,
      outputHash: sha256Short(''),
    })
  )
  return { claimed: true, executed: false, status: 'FAILED', errorClass: result.errorClass, error: result.error }
}
