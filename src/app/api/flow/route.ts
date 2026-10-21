import { NextResponse } from 'next/server'
import { flowDiagnosis } from '@/lib/flow'

// מסלול-אבחון-הזרימה (Task 104): GET — "איפה-הזרימה-נחסמת-עכשיו" בתשובה-אחת-כנה.
// נצרך-על-ידי-פאנל-FlowGuard בדשבורד (ראייה-לבעלים) ועורק-האבחון בלב (פעולה-אוטומטית).
// fail-closed: כשל-אבחון = תשובת-כישלון-חתומה, לא-שקט-מזויף.

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const d = await flowDiagnosis()
    return NextResponse.json(d)
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        note: 'אבחון-הזרימה-נכשל — fail-closed: לא-מזייפים-בריאות',
      },
      { status: 502 },
    )
  }
}
