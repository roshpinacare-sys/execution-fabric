# Task 88 — full-stack-developer — רכזת-הרשת (Network Hub)

Agent: full-stack-developer
Task ID: 88
Date: 2026-10-20

## מה-נבנה

רכזת-הרשת: רישום-עוגנים-חי של-הריבונות — השרשרת-המקומית מרכז-העניינים, עוגני-חוץ נתמכים-סביבה. שער + לוח-UI + חתימת-AUDIT מכוונת.

## קבצים

| קובץ | פעולה | תוכן |
|---|---|---|
| `src/lib/hub.ts` | חדש | collectAnchors/summarize — 4-עוגנים-חיים (local-chain מה-db; github מ-githubPolicy-מקומי-בלבד; sandbox-git בקריאת-קבצים-בלבד מ-../fabric-mirror.git; steem-rpc-קריאה-ציבורית-אחת-read-only) + 4-ממתינים לפי-הדוקטרינה; safeProbe (try/catch-כפול) + hardTimeout-3ש |
| `src/app/api/hub/route.ts` | חדש | GET=דגימה-בלבד (אין-חתימה); POST ?subject=hub-check=דוח+חתימת-AUDIT (worker='network-hub'); force-dynamic |
| `src/components/NetworkHub.tsx` | חדש | כרטיס-חי: דגימה-20ש', badge-מצב, עוגנים-עם-נקודת-צבע, כפתור "בדוק-עכשיו"+toast, RTL/a11y/responsive, max-h-96-גלילה |
| `src/app/page.tsx` | עריכה-מינימלית | +ייבוא-NetworkHub, +הצבה-אחרי-OperationsHub (2-שורות) |
| `worklog.md` | צירוף-סוף | סעיף-Task-88 (מבלי-לגעת-בקיים — כולל-סימני-המיזוג-התלויים-מ-Task-87) |

## אימות-חי

- `GET /api/hub` → ok:true, networkStatus:active, counts {total:8, active:4, degraded:0, awaiting:4}
  - local-chain: גובה 1,378 · ראש 41ae9c42… · 3מ"ש
  - github: תקציב 0/300 · מרווח-מוטציות 1,200מ"ש · backoff לא-פעיל (אפס-קריאות-רשת)
  - sandbox-git: ראש-מראה 2535057b… · מפגר-בכנות-מהמקור (5bb266a6…) · קריאה-בלבד
  - steem-rpc: head_block_number 110,590,819 · 213מ"ש · אפס-פרסום/כתיבה
- `POST /api/hub?subject=hub-check` → signed: id=1379, hash=9bf1c05c25d5ee126684eedfb159a5df, kind=AUDIT, worker=network-hub
- העד (/api/operations chain): total=1379, verified=1379, ok:true, brokenAt:null — הראש-הוא-בדיוק-הרשומה-החתומה
- `bun run lint` — נקי (אפס-שגיאות)
- הדף `/` — 200 (הכרטיס-החדש-רנדר)

## החלטות-מפתח

1. **חתימה-רק-ב-POST-המכוון** — דגימת-ה-UI (GET-כל-20ש') לעולם-לא-חותמת: ניפוח-השרשרת-נמנע-בארכיטקטורה.
2. **errorClass-כן-בחתימה** — כשהרשת-אינה-פעילה: `network-degraded`/`network-critical` נשמר-ברשומת-ה-AUDIT.
3. **sandbox-git-בלי-גיט-בכלל** — HEAD→refs-רפים→packed-refs בקריאת-קבצים; null-כנה-כשאין-פתרון (לא-ממציאים-sha).
4. **critical-קודם-ל-degraded** — אם-local-chain-נפל: critical גם-אם-שאר-העוגנים-חיים (מרכז-העניינים-הוא-הקובע).
5. **worklog-UU-לא-נוגע** — הקובץ-נמצא-במצב-מיזוג-תלוי-מתרגיל-Task-87; צירוף-בסוף-בלבד, אפס-קומיטים (חוק-המשימה).

## הערות-כנות

- שער-/api/operations-דיווח-degraded-בשעת-האימות (מדידת-איברים-חוץ שלו) — מחוץ-להיקף; לא-נגעתי.
- ה-POST-היחיד-שביצעתי-הוא-זה-שנבדק (רשומה-#1379); אין-חתימות-מיותרות.
