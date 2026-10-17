import { NextResponse } from 'next/server'
import { KNOWN_REPOS, ORG } from '@/lib/github'

// רשימת-הצעות יעדי-ריפו ממטא-דאטת-הביקורת (40 ריפואים).
// רשימת-הארגון החיה חסומה ב-PAT (404 — אין הרשאת-ארגון) — כנות:
// זו רשימת-הצעות סטטית; האימות האמיתי חי מול ה-API בשיגור (verifyRepo ב-POST /api/tasks).
export async function GET() {
  return NextResponse.json({ ok: true, org: ORG, repos: KNOWN_REPOS })
}
