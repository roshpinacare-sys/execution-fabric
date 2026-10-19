import { NextRequest, NextResponse } from 'next/server'
import { runDocsHistoryDrill, lastDocsHistoryDrill } from '@/lib/docs-history-drill'

// תרגיל-אטימות-היסטוריית-המסמכים (מחזור-חדשנות #16, Task 83) — המסמכים-מהעבר-מוכחים-
// שלא-נשכו. הפסיפס-append-only-ובלתי-ניתן-לשינוי (sitebuild.ts מעולם-לא-משנה-קובץ-קיים);
// התרגיל-מוכיח-זאת: המסמכים-מהקומיט-העתיק-ביותר-במראה-ה-bare מוצלבים-ביט-ביט-מול-הדיסק-החי.
// שכתוב-שקט-של-מסמך-ישן = docs-history-tampered-at-<path> = כשל-חתום.
//
// GET  → עדות-התרגיל-האחרונה מהשרשרת (kind=DRILL, worker=drill:docs-history) — אפס-רשת.
// POST → הרצה: קומיט-עתיק → ls-tree → git-show-לכל-מסמך → הצלבה-מול-הדיסק → חתימת-DRILL.
//        הגינות: דילוג-אם-תרגיל-טרי-מ-60דק' (?force=1 מדלג-על-כך, בשימוש-מסודר-נדיר)
//        + מנעול-ריצה-בודדת. fail-honest: כשל = status:FAILED + errorClass בשרשרת.

export async function GET() {
  try {
    return NextResponse.json({ ok: true, drill: await lastDocsHistoryDrill() })
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1'
  const drill = await runDocsHistoryDrill(force)
  return NextResponse.json({ ok: drill.ok, drill })
}
