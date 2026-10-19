import { NextRequest, NextResponse } from 'next/server'
import { runRestoreDrill, lastRestoreDrill, type DrillSource } from '@/lib/restore-drill'
// תרגיל-שחזור (Task 70) — הוכחה-חיה שהכפילות-הרחוקה (GitHub) מחזירה-מערכת-שלמה-מאומתת.
//
// GET  → עדות-התרגיל-האחרונה מהשרשרת (kind=DRILL) — אפס-רשת.
// POST → הרצה: עותק-עבודה מהמקור → אימות-שרשרת-עצמאי על העותק
//        (prisma-חד-פעמי, אפס-נגיעה ב-db-הייצור) → הצלבת-קידומת מול-הייצור → חתימת-DRILL.
//        הגינות: דילוג-אם-תרגיל-טרי-מ-30דק' + מנעול-ריצה-בודדת; עותקי-/tmp נמחקים-תמיד.
//        fail-honest: כשל = status:FAILED + errorClass בשרשרת, אף-המצאה.
//
// ?source=git       (ברירת-מחדל) — clone-רדוד מ-github. פעימה-אוטומטית כל-6שע' מהלב (עורק-ח).
// ?source=export    (מחזור-חדשנות #13, Task 80) — הייצוא-ה-JSONL-בגיט (טקסט-מחוץ-ל-SQLite):
//                    חישוב-מחדש-מלא של-השרשרת-מה-Genesis בזיכרון. פעימת-סנכרון כל-10דק'
//                    (עורק-ג) + פעימת-תרגיל כל-30דק' (עורק-ג-bis) מהלב.
// ?source=snapshot  (מחזור-חדשנות #11, Task 78) — התמונה-השעתית הטרייה ביותר (VACUUM INTO,
//                    מקור-בלתי-תלוי בגיט). פעימת-ניטור כל-5דק' מהלב (עורק-ח-bis, מחזור-#12) —
//                    הדילוג-אם-טרי-מ-30דק' קובע-את-הריצה-האמיתית; התרגיל בן-עשרות-מילישניות.

function parseSource(req: NextRequest): DrillSource {
  const s = req.nextUrl.searchParams.get('source')
  // מחזור-#13: 'export' — המקור-השלישי (הערה-ללקח-החי: בגרסה-הראשונה 'export' נפל-בחזרה
  // ל-'git' — הפעימה-בדקה-בשקט-מקור-אחר-מזה-שנשלח; התגלה-רק-בפורנזיקה-של-השרשרת.
  // הלקח: כל-מקור-חדש-חייב-להיכנס-לניתוח-כאן-וב-WORKERS-יחד — אין-ברירת-מחדל-שקטה-למקור-שלא-נבחן)
  return s === 'snapshot' ? 'snapshot' : s === 'export' ? 'export' : 'git'
}

export async function GET(req: NextRequest) {
  try {
    return NextResponse.json({ ok: true, drill: await lastRestoreDrill(parseSource(req)) })
  } catch (e) {
    return NextResponse.json({ ok: false, reason: (e as Error).message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // ?force=1 — מניפולציית-בדיקה בלבד: מדלג-על-מגבלת-ה-30דק' (בשימוש-מסודר-נדיר)
  const force = req.nextUrl.searchParams.get('force') === '1'
  const drill = await runRestoreDrill(force, parseSource(req))
  return NextResponse.json({ ok: drill.ok, drill })
}
