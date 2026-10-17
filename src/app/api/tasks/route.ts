import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { TASK_KINDS } from '@/lib/llm-chain'
import { verifyRepo, ghErrorClass } from '@/lib/github'

export async function GET() {
  const tasks = await db.task.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return NextResponse.json({ ok: true, tasks })
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    title?: unknown
    prompt?: unknown
    kind?: unknown
    repo?: unknown
  } | null

  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  const kind = typeof body?.kind === 'string' ? body.kind : ''
  const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''

  if (title.length < 3 || title.length > 120) {
    return NextResponse.json(
      { ok: false, error: 'כותרת חייבת 3-120 תווים' },
      { status: 400 }
    )
  }
  if (prompt.length < 10 || prompt.length > 4000) {
    return NextResponse.json(
      { ok: false, error: 'תיאור-המשימה חייב 10-4000 תווים' },
      { status: 400 }
    )
  }
  if (!(TASK_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { ok: false, error: `kind חייב להיות אחד מ: ${TASK_KINDS.join(', ')}` },
      { status: 400 }
    )
  }
  if (repo) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      return NextResponse.json(
        { ok: false, error: 'שם-ריפו לא תקין (אותיות/ספרות/./_/- בלבד)' },
        { status: 400 }
      )
    }
    // אימות-חי מול GitHub עוד לפני השיגור — כשל כן, בלי תקוות-שווא
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
          error: `אימות-הריפו מול GitHub נכשל (${cls ?? 'provider'}) — המשימה לא נשלחה בכנות`,
        },
        { status: 502 }
      )
    }
  }

  const task = await db.task.create({
    data: { title, prompt, kind, repo: repo || null },
  })
  return NextResponse.json({ ok: true, task }, { status: 201 })
}
