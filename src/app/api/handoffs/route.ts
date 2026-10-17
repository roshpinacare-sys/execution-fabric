import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sha256Short } from '@/lib/ledger'
import { verifyRepo, ghErrorClass, ORG } from '@/lib/github'
import { scanSecrets } from '@/lib/secretscan'
import {
  extractArtifact,
  validateHandoffPath,
  HANDOFF_MAX_BYTES,
} from '@/lib/handoff'

// שער-העברת-תוצרים (worklog Task 20): יצירת-הצעה + רשימה.
// ההצעה בלבד נוצרת כאן — ביצוע דורש אישור-בעלים מפורש (approve → execute).

export async function GET() {
  const handoffs = await db.handoff.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { task: { select: { title: true, kind: true, repo: true } } },
  })
  return NextResponse.json({ ok: true, handoffs })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    taskId?: unknown
    repo?: unknown
    path?: unknown
    message?: unknown
    branch?: unknown
    field?: unknown
  } | null

  const taskId = typeof body?.taskId === 'string' ? body.taskId : ''
  const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
  const path = typeof body?.path === 'string' ? body.path.trim() : ''
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  const branch =
    typeof body?.branch === 'string' && body.branch.trim()
      ? body.branch.trim()
      : null
  const field =
    typeof body?.field === 'string' && body.field.trim()
      ? body.field.trim()
      : null

  if (!taskId) {
    return NextResponse.json({ ok: false, error: 'taskId חובה' }, { status: 400 })
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    return NextResponse.json(
      { ok: false, error: 'שם-ריפו לא תקין (אותיות/ספרות/./_/- בלבד)' },
      { status: 400 }
    )
  }
  if (message.length < 5 || message.length > 400) {
    return NextResponse.json(
      { ok: false, error: 'הודעת-הקומיט חייבת 5-400 תווים' },
      { status: 400 }
    )
  }
  const pathErr = validateHandoffPath(path)
  if (pathErr) {
    return NextResponse.json({ ok: false, error: pathErr }, { status: 400 })
  }

  const task = await db.task.findUnique({ where: { id: taskId } })
  if (!task) {
    return NextResponse.json(
      { ok: false, error: 'משימת-המקור לא נמצאה' },
      { status: 404 }
    )
  }
  if (task.status !== 'DONE' || !task.output) {
    return NextResponse.json(
      {
        ok: false,
        error: 'רק משימה שהושלמה עם תוצר מאומת ניתנת להעברה (status=DONE)',
      },
      { status: 400 }
    )
  }

  const artifact = extractArtifact(task.output, field)
  if (artifact === null) {
    return NextResponse.json(
      {
        ok: false,
        error: field
          ? `השדה "${field}" לא נמצא בתוצר או שאינו מחרוזת`
          : 'התוצר ריק',
      },
      { status: 400 }
    )
  }
  const size = Buffer.byteLength(artifact, 'utf8')
  if (size > HANDOFF_MAX_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: `הארטיפקט גדול מדי (${size} בייטים, המגבלה ${HANDOFF_MAX_BYTES})`,
      },
      { status: 400 }
    )
  }

  // סריקת-סודות — פגיעה = סירוב כן עם שמות-התבניות בלבד (אף ערך לא נחשף)
  const scan = scanSecrets(artifact)
  if (!scan.clean) {
    return NextResponse.json(
      {
        ok: false,
        error: `סריקת-הסודות חסמה את ההעברה — נמצאו תבניות: ${scan.hits
          .map((h) => `${h.name}×${h.count}`)
          .join(', ')}`,
      },
      { status: 400 }
    )
  }

  // אימות-חי של הריפו — אותה דיסציפלינה של שיגור-משימה (Task 19)
  try {
    await verifyRepo(repo)
  } catch (e) {
    const cls = ghErrorClass(e)
    if (cls === 'repo-not-found') {
      return NextResponse.json(
        {
          ok: false,
          error: `הריפו ${repo} לא נמצא בארגון (אימות-חי מול GitHub: 404)`,
        },
        { status: 400 }
      )
    }
    return NextResponse.json(
      {
        ok: false,
        error: `אימות-הריפו מול GitHub נכשל (${cls ?? 'provider'}) — ההצעה לא נוצרה בכנות`,
      },
      { status: 502 }
    )
  }

  const handoff = await db.handoff.create({
    data: {
      taskId,
      repo,
      path,
      branch,
      message,
      field,
      status: 'PROPOSED',
      artifactHash: sha256Short(artifact),
      artifactSize: size,
    },
  })
  return NextResponse.json(
    { ok: true, handoff, org: ORG },
    { status: 201 }
  )
}
