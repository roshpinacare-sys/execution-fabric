import { NextResponse } from 'next/server'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { audioFileAbs } from '@/lib/narration'

// הזרמת-אודיו (worklog Task 39): GET /api/sovereign/content/[id]/audio
// מקריא את קובץ-ה-mp3 שנולד במסילת-ההקראה. 404 כן אם-אין-קובץ — אפס-המצאה.

export const dynamic = 'force-dynamic'

export async function GET(
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
  const abs = audioFileAbs(numId)
  if (!existsSync(abs)) {
    return NextResponse.json(
      { ok: false, error: `no narration for improvement ${numId} — trigger POST narrate first`, errorClass: 'invalid' },
      { status: 404 }
    )
  }
  try {
    const size = statSync(abs).size
    const buffer = readFileSync(abs)
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(size),
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), errorClass: 'unknown' },
      { status: 500 }
    )
  }
}
