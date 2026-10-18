import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// חיבור-מחדש-מודע-קובץ (Task 28): פעימת-הגיט-האוטונומית (עורק-ב בלב) מחליפה-את
// db/custom.db בכל pull-rebase-שמביא-שינויים-מהרחוק — קובץ-חדש, inode-חדש. בריכת-החיבורים
// של Prisma נשארת-קשורה-לinode-הישן: האפליקציה ממשיכה-לעבוד-אבל-קוראת-מצב-מיושן-בשקט
// (וכותבת-לקובץ-שכבר-לא-הנתיב-שלה). הלב מזהה-החלפת-inode (stat) וקורא-לכאן:
// ניתוק-חיבור-מחדש = יד-חדשה-על-קובץ-האמת-הנוכחי. בדיקת-עקביות-מיידית אחרי-החיבור.
// כשל-כן: אם-החיבור-מחדש-נכשל — 500 עם-השגיאה, הלב יראה-והמצב-גלוי.

export async function POST() {
  try {
    await db.$disconnect()
    await db.$connect()
    const [ledgerCount, taskCount] = await Promise.all([
      db.ledgerEntry.count(),
      db.task.count(),
    ])
    return NextResponse.json({ ok: true, reconnected: true, ledgerCount, taskCount })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}
