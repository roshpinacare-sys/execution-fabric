import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// קיר-הצמיחה — רשימת-השיפורים שנולדו בעורק-הבנייה (worklog Task 32).
// GET /api/sovereign/improvements?limit=30 — מטא-דאטה + תקציר בלבד; התוכן-המלא
// חי בארטיפקטים עצמם (sovereign/site/*.md — בגיט).

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? '30')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 30
    const items = await db.improvement.findMany({
      orderBy: { id: 'desc' },
      take: limit,
      select: {
        id: true,
        kind: true,
        title: true,
        summary: true,
        status: true,
        artifactPath: true,
        createdAt: true,
      },
    })
    return NextResponse.json({
      ok: true,
      items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })),
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), errorClass: 'unknown' },
      { status: 500 }
    )
  }
}
