import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { FLEET_LENSES, LENS_LABEL, type FleetLens } from '@/lib/fleet'

// יצירת צי-ביקורת: משימת-שורש (מחזיקת-הסינתזה) + עדשת-עובד לכל עדשה נבחרת.
// העדשות נבראות QUEUED — הירי המקבילי קורה רק ב-/run.

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    title?: unknown
    target?: unknown
    lenses?: unknown
  } | null

  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const target = typeof body?.target === 'string' ? body.target.trim() : ''
  const rawLenses = Array.isArray(body?.lenses) ? body?.lenses : []

  if (title.length < 3 || title.length > 120) {
    return NextResponse.json(
      { ok: false, error: 'כותרת חייבת 3-120 תווים' },
      { status: 400 }
    )
  }
  if (target.length < 20 || target.length > 6000) {
    return NextResponse.json(
      { ok: false, error: 'יעד-הביקורת חייב 20-6000 תווים' },
      { status: 400 }
    )
  }

  const lenses: FleetLens[] = []
  for (const l of rawLenses) {
    if (typeof l !== 'string' || !(FLEET_LENSES as readonly string[]).includes(l)) {
      return NextResponse.json(
        { ok: false, error: `עדשה לא מוכרת: ${String(l)}` },
        { status: 400 }
      )
    }
    if (!lenses.includes(l as FleetLens)) lenses.push(l as FleetLens)
  }
  if (lenses.length < 2 || lenses.length > 4) {
    return NextResponse.json(
      { ok: false, error: 'צי חייב 2-4 עדשות ייחודיות' },
      { status: 400 }
    )
  }

  const root = await db.task.create({
    data: {
      title,
      kind: 'AUDIT',
      prompt: target,
      role: 'fleet-root',
    },
  })

  const children: Awaited<ReturnType<typeof db.task.create>>[] = []
  for (const lens of lenses) {
    children.push(
      await db.task.create({
        data: {
          title: `עדשת ${LENS_LABEL[lens]}: ${title}`,
          kind: 'AUDIT',
          prompt: target,
          role: 'worker',
          lens,
          parentId: root.id,
        },
      })
    )
  }

  return NextResponse.json({ ok: true, root, children }, { status: 201 })
}
