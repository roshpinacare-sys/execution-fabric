import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appendLedger, sha256Short } from '@/lib/ledger'
import { verifyRepo, putContents, readBackVerify, ghErrorClass, ghErrorMessage } from '@/lib/github'
import { scanSecrets } from '@/lib/secretscan'
import { extractArtifact } from '@/lib/handoff'

// הביצוע האמיתי של ההעברה (worklog Task 20):
// claim אטומי (APPROVED | FAILED-לניסיון-חוזר | RUNNING-תקוע>10דק') → אימות-ריפו חי
// → חילוץ-ארטיפקט + אכיפת-hash (artifact-changed כן) → סריקת-סודות חוזרת
// → PUT contents אמיתי → read-back (משיכת-התוכן חזרה + השוואת-בייטים)
// → DONE עם commitSha / FAILED כן — ובכל מצב-סופ: חתימת-שרשרת kind=HANDOFF.
// כשל-read-back מדווח בכנות: הקומיט יורד אבל לא אומת — נרשם FAILED עם ה-commitSha.

const STALE_RUNNING_MS = 10 * 60 * 1000

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const stale = new Date(Date.now() - STALE_RUNNING_MS)
  const claim = await db.handoff.updateMany({
    where: {
      id,
      OR: [
        { status: 'APPROVED' },
        { status: 'FAILED' },
        { status: 'RUNNING', updatedAt: { lt: stale } },
      ],
    },
    data: { status: 'RUNNING', error: null, errorClass: null },
  })
  if (claim.count === 0) {
    const existing = await db.handoff.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'העברה לא נמצאה' },
        { status: 404 }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        error:
          existing.status === 'PROPOSED'
            ? 'ההעברה ממתינה לאישור-בעלים (approve) — ביצוע בלי אישור נחסם'
            : `מצב ההעברה ${existing.status} — לא ניתן לבצע עכשיו`,
      },
      { status: 409 }
    )
  }

  const handoff = await db.handoff.findUnique({ where: { id } })
  const task = handoff
    ? await db.task.findUnique({ where: { id: handoff.taskId } })
    : null
  if (!handoff || !task) {
    await db.handoff.update({
      where: { id },
      data: { status: 'FAILED', error: 'task מקור נעלם', errorClass: 'invalid' },
    })
    return NextResponse.json(
      { ok: false, error: 'משימת-המקור לא נמצאה — FAILED כן' },
      { status: 404 }
    )
  }

  const t0 = Date.now()

  const fail = async (error: string, errorClass: string, commitSha?: string) => {
    const durationMs = Date.now() - t0
    const updated = await db.handoff.update({
      where: { id },
      data: {
        status: 'FAILED',
        error,
        errorClass,
        attempts: handoff.attempts + 1,
        durationMs,
        ...(commitSha ? { commitSha } : {}),
      },
    })
    await appendLedger({
      taskId: handoff.taskId,
      kind: 'HANDOFF',
      status: 'FAILED',
      worker: 'github-handoff',
      attempts: updated.attempts,
      durationMs,
      errorClass,
      outputHash: handoff.artifactHash ?? sha256Short(''),
    })
    return NextResponse.json({ ok: true, handoff: updated, executed: false })
  }

  // 1) אימות-ריפו חי
  try {
    await verifyRepo(handoff.repo)
  } catch (e) {
    return fail(
      ghErrorMessage(e),
      ghErrorClass(e) ?? 'provider'
    )
  }

  // 2) חילוץ-ארטיפקט + אכיפת-hash — התוצר לא השתנה מאז ההצעה
  const artifact = extractArtifact(task.output, handoff.field)
  if (artifact === null) {
    return fail('הארטיפקט לא ניתן לחילוץ מהתוצר (שינוי/שדה-נעלם)', 'artifact-changed')
  }
  if (sha256Short(artifact) !== handoff.artifactHash) {
    return fail('התוצר השתנה מאז ההצעה — hash לא תואם, ההעברה נחסמה', 'artifact-changed')
  }

  // 3) סריקת-סודות חוזרת (defense in depth — גם אם עברה בהצעה)
  const scan = scanSecrets(artifact)
  if (!scan.clean) {
    return fail(
      `סריקת-סודות בביצוע חסמה: ${scan.hits.map((h) => `${h.name}×${h.count}`).join(', ')}`,
      'secret-scan'
    )
  }

  // 4) PUT contents אמיתי
  let commitSha: string
  try {
    const put = await putContents({
      repo: handoff.repo,
      path: handoff.path,
      content: artifact,
      message: handoff.message,
      branch: handoff.branch,
    })
    commitSha = put.commitSha
  } catch (e) {
    return fail(ghErrorMessage(e), ghErrorClass(e) ?? 'provider')
  }

  // 5) read-back — משיכת-התוכן חזרה + השוואת-בייטים
  try {
    const rb = await readBackVerify(
      handoff.repo,
      handoff.path,
      handoff.branch,
      artifact
    )
    if (!rb.verified) {
      // הקומיט יורד בפועל אך האימות נכשל — כנות מלאה: FAILED עם ה-commitSha לתיעוד
      return fail(
        'read-back: התוכן שנשלף חזרה שונה מהארטיפקט — הקומיט קיים אך לא אומת',
        'read-back-mismatch',
        commitSha
      )
    }
  } catch (e) {
    return fail(
      `read-back נכשל: ${ghErrorMessage(e)} — הקומיט ${commitSha.slice(0, 10)} קיים אך לא אומת`,
      ghErrorClass(e) ?? 'provider',
      commitSha
    )
  }

  // 6) הצלחה — DONE + חתימת-שרשרת
  const durationMs = Date.now() - t0
  const done = await db.handoff.update({
    where: { id },
    data: {
      status: 'DONE',
      commitSha,
      verified: true,
      error: null,
      errorClass: null,
      attempts: handoff.attempts + 1,
      durationMs,
    },
  })
  await appendLedger({
    taskId: handoff.taskId,
    kind: 'HANDOFF',
    status: 'DONE',
    worker: 'github-handoff',
    attempts: done.attempts,
    durationMs,
    errorClass: null,
    outputHash: handoff.artifactHash ?? sha256Short(''),
  })

  return NextResponse.json({ ok: true, handoff: done, executed: true })
}
