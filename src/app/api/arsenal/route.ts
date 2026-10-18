import { NextResponse } from 'next/server'
import { arsenalReport } from '@/lib/arsenal'

// ארסנל-הכלים — GET /api/arsenal (worklog Task 35): קטלוג-השמישות המלא.
// הקונסולה מרנדרת אותו; הארכיטקטורה והריבונות קוראות דרך fabric-client.arsenal().

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(arsenalReport())
}
