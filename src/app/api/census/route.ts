import { NextRequest, NextResponse } from 'next/server'
import { buildCensus, memoryDigest } from '@/lib/census'

// פקח-הריבונות (worklog Task 30) — נקודת-האינטליגנציה של הרשת.
// עקרונות (tobi/disktree): כל-מספר נגזר-מאומת בזמן-בקשה; הפקח מסמן-ולא-מוחק;
// סיווג-סוגים לפסיפס-האחזות; לא-נמדד = לא-נטען. אף-סוד לא עובר מכאן (נוכחות-שמות בלבד).
//
// GET /api/census           → הפקח המלא (שרשרת/משימות/שער/תקציב/גישה/לב/פסיפס/שווה-מבט/זיכרון)
// GET /api/census?view=memory → חומר-הזיכרון הנגזר בלבד (מה-נלמד/נוצר/נאסף/פתוח)
//
// Task 67 — עד-השרשרת (chain-witness :3050): דפוס-נלמד-מהתאום
// (SANDBOX-DISTRUST-LAW: "הבקרה-המתמדת-היא-הכלל"). הפקח מצליב-את-הראש-שהוא
// מדווח מול-עדות-המימוש-העצמאי. fail-honest: עד-דמם = up:false, אף-המצאה.

async function probeWitness(): Promise<{
  up: boolean
  ok?: boolean
  total?: number
  head?: string
  agrees?: boolean
  reason?: string
}> {
  try {
    const res = await fetch('http://127.0.0.1:3050/witness', {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    })
    if (!res.ok) return { up: false, reason: `http-${res.status}` }
    const w = (await res.json()) as { ok: boolean; total: number; head: string; reason?: string }
    return { up: true, ok: w.ok, total: w.total, head: w.head }
  } catch (e) {
    return { up: false, reason: `unreachable: ${(e as Error).message}` }
  }
}

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view')
  if (view === 'memory') {
    return NextResponse.json({ ok: true, memory: await memoryDigest() })
  }
  const census = await buildCensus()
  const witness = await probeWitness()
  if (witness.up && witness.head !== undefined) {
    witness.agrees = witness.head === census.chain.verify.head
  }
  return NextResponse.json({ ok: true, census, witness })
}
