import { NextResponse } from 'next/server'
import { runSiteBuildCycle, siteBuildStatus, SITEBUILD_BUDGET_PER_HOUR } from '@/lib/sitebuild'

// עורק-הבנייה — REST (worklog Task 32):
//   POST /api/sovereign/build — מחזור-בנייה אחד (ירי-LLM אמיתי → שיפור-מוצר אמיתי)
//   GET  /api/sovereign/build — סטטוס-עורק (תקציב/ספירות/אחרון)
// כנות: 429 = תקציב-שעתי מוצה; כל-כשל אחר = {ok:false,error,errorClass} מהשטח.

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const status = await siteBuildStatus()
    return NextResponse.json({ ok: true, ...status })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), errorClass: 'unknown' },
      { status: 500 }
    )
  }
}

export async function POST() {
  try {
    const result = await runSiteBuildCycle()
    if (!result.ok) {
      const status =
        result.errorClass === 'rate-limit'
          ? 429
          : result.errorClass === 'invalid' || result.errorClass === 'duplicate'
            ? 400
            : 502
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          errorClass: result.errorClass,
          attempts: result.attempts,
          durationMs: result.durationMs,
        },
        { status }
      )
    }
    return NextResponse.json(
      {
        ok: true,
        improvement: {
          id: result.improvementId,
          kind: result.kind,
          title: result.title,
          status: result.applied ? 'APPLIED' : 'PROPOSED',
          artifactPath: result.artifactPath,
        },
        worker: result.worker,
        attempts: result.attempts,
        durationMs: result.durationMs,
        ledgerId: result.ledgerId,
        budget: { cap: SITEBUILD_BUDGET_PER_HOUR },
      },
      { status: 201 }
    )
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), errorClass: 'unknown' },
      { status: 500 }
    )
  }
}
