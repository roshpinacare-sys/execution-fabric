// מרכז-השערים (Task 91): חוק-אחד לכל-ה-API — לא-27-שערים-פזורים אלא נקודת-מצערת-אחת.
// פומבי = מה שהמכונה עושה-לעצמה בכל-מקרה (קריאה + תרגילים-תחת-מנעולי-טריות).
// בעלים = כל-שינוי-מצב: loopback (לב/זקיפה — אפס-שינוי-בהם) או x-operator-key.
import { NextResponse, type NextRequest } from 'next/server'
import { ensureOperatorKey, isMutatingRequest, resolveOperator } from '@/lib/operator'

export function proxy(req: NextRequest) {
  if (!isMutatingRequest(req.method, req.url)) return NextResponse.next()

  ensureOperatorKey()
  const verdict = resolveOperator(req.headers, req.headers.get('x-real-ip') || undefined)

  if (verdict.allowed) {
    const res = NextResponse.next()
    res.headers.set('x-operator-via', verdict.via)
    return res
  }

  // כנות-מלאה: גוף-אמת גם-כשה-HTTP-401 (לקח-אמת-הגוף)
  return NextResponse.json(
    {
      ok: false,
      error: 'operator-key-required',
      via: verdict.via,
      at: new Date().toISOString(),
      hint: 'כתיבה = לולאה-מקומית-בלבד, או כותרת x-operator-key (המפתח ב-upload/operator.env על-המכונה — gitignored)',
    },
    { status: 401 },
  )
}

export const config = {
  matcher: '/api/:path*',
}
