import { NextRequest, NextResponse } from 'next/server'
import { runHistoryDrill, lastHistoryDrill } from '@/lib/history-drill'

// תרגיל-אטימות-ההיסטוריה (מחזור-חדשנות #14, Task 81) — הוכחה-קבועה שההיסטוריה-החתומה-
// בגיט (הייצוא-מהקומיט-העתיק-ביותר-במראה-ה-bare) עדיין-תקפה-במלואה-והיא-קידומת-ביט-ביט-
// של-הייצור-החי. ההווה-מוכח-שחזור (תרגילי-#8/#11/#13); העבר-מוכח-מעתה-שלא-נשכתה.
//
// GET  → עדות-התרגיל-האחרונה מהשרשרת (kind=DRILL, worker=drill:history) — אפס-רשת.
// POST → הרצה: קומיט-עתיק → git-show-כזרימה → חישוב-מחדש-מה-Genesis (מאמת-הקנון) →
//        הצלבת-קידומת-מול-הייצור → חתימת-DRILL.
//        הגינות: דילוג-אם-תרגיל-טרי-מ-30דק' (?force=1 מדלג-על-כך, בשימוש-מסודר-נדיר)
//        + מנעול-ריצה-בודדת. fail-honest: כשל = status:FAILED + errorClass בשרשרת.

export async function GET() {
  try {
    return NextResponse.json({ ok: true, drill: await lastHistoryDrill() })
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1'
  const drill = await runHistoryDrill(force)
  return NextResponse.json({ ok: drill.ok, drill })
}
