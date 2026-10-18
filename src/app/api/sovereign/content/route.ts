import { NextRequest, NextResponse } from 'next/server'
import { existsSync } from 'node:fs'
import { db } from '@/lib/db'
import { readNarrationManifest, audioFileAbs } from '@/lib/narration'

// בית-התוכן (worklog Task 39) — התשובה-המוצרית לדרישת-הבעלים:
// "למה האתר לא משתפר ומתעדכן באמת?" — התוכן שנולד בעורק-הבנייה כבר לא רק
// קובץ בגיט: הוא נראה ונקרא באתר עצמו, וגם מוקרא (TTS).
// GET /api/sovereign/content?limit=12 — התוכן-המלא (body) של השיפורים-המיושמים
// + הצהרת-הקראה מהמניפסט (נגזר-אמת: הצהרה בלי-קובץ-חי = אין-הקראה).

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? '12')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50) : 12

    const [items, manifest] = await Promise.all([
      db.improvement.findMany({
        where: { kind: 'CONTENT', status: 'APPLIED' },
        orderBy: { id: 'desc' },
        take: limit,
        select: {
          id: true,
          kind: true,
          title: true,
          summary: true,
          body: true,
          artifactPath: true,
          worker: true,
          durationMs: true,
          createdAt: true,
        },
      }),
      Promise.resolve(readNarrationManifest()),
    ])

    return NextResponse.json({
      ok: true,
      items: items.map((i) => {
        const declared = manifest.items[String(i.id)]
        // נגזר-אמת: ההקראה קיימת רק אם גם הקובץ-חי על-הדיסק
        const narration =
          declared && existsSync(audioFileAbs(i.id))
            ? {
                ready: true as const,
                audioPath: declared.audioPath,
                sizeBytes: declared.sizeBytes,
                voice: declared.voice,
                narratedAt: declared.narratedAt,
                url: `/api/sovereign/content/${i.id}/audio`,
              }
            : null
        return { ...i, createdAt: i.createdAt.toISOString(), narration }
      }),
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), errorClass: 'unknown' },
      { status: 500 }
    )
  }
}
