import { NextRequest, NextResponse } from 'next/server'
import { runDocsDrill, lastDocsDrill } from '@/lib/docs-drill'

// תרגיל-אטימות-המסמכים (מחזור-חדשנות #15, Task 82) — חיבור-פסיפס-המסמכים-אל-השרשרת.
// ארבעת-התרגילים-הקיימים מוכיחים-את-השרשרת; הזה-מוכיח-את-הארטיפקטים-שהרשת-בונה-בעצמה
// (sovereign/site/*.md): כל-שורה-חייבת-קובץ, כל-קובץ-חייב-frontMatter-תקין, והפסיפס-
// כולו נחתם-כ-digest-קנוני-ממוין בשרשרת. פגיעה-בקובץ = digest-שונה-בתרגיל-הבא = חתום.
//
// GET  → עדות-התרגיל-האחרונה מהשרשרת (kind=DRILL, worker=drill:docs) — אפס-רשת.
// POST → הרצה: row→file → file-parse → digest-קנוני → חתימת-DRILL.
//        הגינות: דילוג-אם-תרגיל-טרי-מ-30דק' (?force=1 מדלג-על-כך, בשימוש-מסודר-נדיר)
//        + מנעול-ריצה-בודדת. fail-honest: כשל = status:FAILED + errorClass בשרשרת.

export async function GET() {
  try {
    return NextResponse.json({ ok: true, drill: await lastDocsDrill() })
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1'
  const drill = await runDocsDrill(force)
  return NextResponse.json({ ok: drill.ok, drill })
}
