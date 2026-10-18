import { NextRequest, NextResponse } from 'next/server'
import { buildCensus, memoryDigest } from '@/lib/census'

// פקח-הריבונות (worklog Task 30) — נקודת-האינטליגנציה של הרשת.
// עקרונות (tobi/disktree): כל-מספר נגזר-מאמת בזמן-בקשה; הפקח מסמן-ולא-מוחק;
// סיווג-סוגים לפסיפס-האחזות; לא-נמדד = לא-נטען. אף-סוד לא עובר מכאן (נוכחות-שמות בלבד).
//
// GET /api/census           → הפקח המלא (שרשרת/משימות/שער/תקציב/גישה/לב/פסיפס/שווה-מבט/זיכרון)
// GET /api/census?view=memory → חומר-הזיכרון הנגזר בלבד (מה-נלמד/נוצר/נאסף/פתוח)

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view')
  if (view === 'memory') {
    return NextResponse.json({ ok: true, memory: await memoryDigest() })
  }
  return NextResponse.json({ ok: true, census: await buildCensus() })
}
