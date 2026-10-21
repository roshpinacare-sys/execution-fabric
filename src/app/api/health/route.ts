import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ensureOrganGuardian, guardianStatus } from '@/lib/organ-guardian'

export async function GET() {
  // שומר-האיברים (Task 106): מוצת-על-כל-דופק-בריאות — הלב דופק כל-5ש', אפס-תלות-באתחול
  try {
    ensureOrganGuardian()
  } catch {
    /* השומר-אינו-מפיל-את-בריאות-האפליקציה */
  }
  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true, db: true, time: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json({
      ok: false,
      db: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

export async function POST() {
  // תצפית-השומר (לדשבורד/לסוכנים): קריאה-בלבד
  return NextResponse.json(guardianStatus())
}
