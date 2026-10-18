import { NextResponse } from 'next/server'
import { narrateImprovement } from '@/lib/narration'

// הקראת-תוכן (worklog Task 39) — השימוש-הראשון-המוצדק בכלי-SDK-TTS.
// POST /api/sovereign/content/[id]/narrate — הקראה אמיתית של שיפור-תוכן מיושם.
// כנות: אידימפוטנטי (already:true בלי-ירי-כפול); כל-כשל = {ok:false,error,errorClass}
// ונרשם NARRATE FAILED בשרשרת. אפס-המצאה.

export const dynamic = 'force-dynamic'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json(
      { ok: false, error: `invalid id: ${id}`, errorClass: 'invalid' },
      { status: 400 }
    )
  }
  try {
    const result = await narrateImprovement(numId)
    if (!result.ok) {
      const status = result.errorClass === 'invalid' ? 400 : 502
      return NextResponse.json(
        { ok: false, error: result.error, errorClass: result.errorClass, durationMs: result.durationMs },
        { status }
      )
    }
    return NextResponse.json(
      {
        ok: true,
        already: result.already,
        improvementId: result.improvementId,
        audioPath: result.audioPath,
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
        ledgerId: result.ledgerId,
        audioUrl: `/api/sovereign/content/${result.improvementId}/audio`,
      },
      { status: 200 }
    )
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), errorClass: 'unknown' },
      { status: 500 }
    )
  }
}
