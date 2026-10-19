import { NextRequest, NextResponse } from 'next/server'
import { runRestoreDrill, lastRestoreDrill } from '@/lib/restore-drill'

// תרגיל-שחזור (Task 70) — הוכחה-חיה שהכפילות-הרחוקה (GitHub) מחזירה-מערכת-שלמה-מאומתת.
//
// GET  → עדות-התרגיל-האחרונה מהשרשרת (kind=DRILL, taskId=restore-drill) — אפס-רשת.
// POST → הרצה: clone-רדוד מ-github → אימות-שרשרת-עצמאי על עותק-ה-db המשוחזר
//        (prisma-חד-פעמי, אפס-נגיעה ב-db-הייצור) → הצלבת-ראש מול-הייצור → חתימת-DRILL.
//        הגינות: דילוג-אם-תרגיל-טרי-מ-30דק' + מנעול-ריצה-בודדת; עותקי-/tmp נמחקים-תמיד.
//        fail-honest: כשל = status:FAILED + errorClass בשרשרת, אף-המצאה.
//
// פעימה-אוטומטית כל-6שע' מ-fabric-heartbeat (עורק-ז).

export async function GET() {
  try {
    return NextResponse.json({ ok: true, drill: await lastRestoreDrill() })
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // ?force=1 — מניפולציית-בדיקה בלבד: מדלג-על-מגבלת-ה-30דק' (בשימוש-מסודר-נדיר)
  const force = req.nextUrl.searchParams.get('force') === '1'
  const drill = await runRestoreDrill(force)
  return NextResponse.json({ ok: drill.ok, drill })
}
