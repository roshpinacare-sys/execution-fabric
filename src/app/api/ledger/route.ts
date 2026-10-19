import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyChainStreamed } from '@/lib/ledger'

// הפלט תמיד כולל אימות-מחדש של השרשרת על כל-קריאה — לא סטטוס שמור, חישוב חי.
//
// Task 76 (מחזור-חדשנות #9): ההיסטוריה — המסלול-טען-את-כל-השורות (findMany מלא) בכל-קריאה.
// מעתה: אימות-מלא-מה-Genesis-בקריאה-בדפים (verifyChainStreamed — בלי-דלתא, בלי-checkpoint,
// דגם-האמונים-שלם) + recent-בשאילתה-נפרדת-של-8-שורות בלבד. total מגיע-מה-count-של-הזרימה.
export async function GET() {
  const [verify, recent] = await Promise.all([
    verifyChainStreamed(),
    db.ledgerEntry.findMany({ orderBy: { id: 'desc' }, take: 8 }),
  ])
  return NextResponse.json({
    ok: true,
    total: verify.total,
    verify,
    recent,
  })
}
