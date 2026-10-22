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
    // Task-121 audit fix (fingerprint api/mutations:private-net-xff-csrf-no-origin-binding):
    // כריכת-מקור למוטציות-רשת-פרטית: כתובת-ה-IP-היא-הוכחה-סביבתית-שהדפדפן נושא אותה בצלב-
    // אתר (CSRF). דפדפן-ראשון-משלח Sec-Fetch-Site: cross-site או Origin-זר → נדחה. סקריפטים/
    // curl בלי-כותרות-אלה ממשיכים-לעבוד; direct-local (לולאה-מקומית) נשאר-כפי-שהוא.
    if (verdict.via === 'private-net') {
      const secSite = (req.headers.get('sec-fetch-site') || '').toLowerCase()
      const origin = req.headers.get('origin') || ''
      const siteOrigin = req.nextUrl.origin
      const crossSite = secSite === 'cross-site' || (origin && origin !== siteOrigin)
      if (crossSite) {
        return NextResponse.json(
          {
            ok: false,
            error: 'cross-site-mutation-rejected',
            via: verdict.via,
            at: new Date().toISOString(),
            hint: 'מוטציה-ממקור-צולב נדחית (Task-121): יש-לקרוא מאותו-מקור או לצרף x-operator-key',
          },
          { status: 403 },
        )
      }
    }
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
