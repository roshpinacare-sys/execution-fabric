# execution-fabric — רשת-הביצוע הריבונית

> Dispatch → סולם-מועמדים-LLM → לדג'ר-שרשרת-האש. **הגיט-הוא-הקיום; הסנדבוקס-הוא-רק-זוג-ידיים.**

מערכת-ביצוע-משימות אוטונומית: משימות נשלחות דרך API, עובד-רקע-חי (לולאת-tick-שרת) קולט-ומבצע
ביריות-LLM אמיתיות (או כשל-כן חתום — אין סימולציה), וכל תוצאה נחתמת בשרשרת-האש.

## עקרונות (מ-RUNBOOK של ריפו-האם Sandbox)

1. **כנות מעל הכל** — כל ירי = LLM אמיתי; כשל = `ok:false` + `errorClass` חתום; אין תוצאה מדומה.
2. **אפס-סודות-בגיט** — הטוקן נקרא בזמן-ריצה מ-`קובץ-הסמכות` (gitignored); סריקת-דליפות
   (`node .zscripts/leak-scan.mjs --staged`) חסם-לפני-כל-push; אין-force-push.
3. **לדג'ר-שרשרת-האש** — `hash = sha256(...)` קנוני, fail-closed; כל רשומה נקשרת לקודמת.
4. **claim אטומי** — ריבוי-עובדים (דפדפן + שרת) בטוח; ריצה-תקועה >10 דק' נתבעת-מחדש.

## חוזה-הצריכה לארכיטקטורה ולריבונות (API יציב)

| נקודת-קצה | שימוש |
|---|---|
| `POST /api/batches` | שיגור-אצווה מקבילה. גוף: `{tasks:[{title,kind,prompt,repo?}]}` **או** `{title,kind,prompt,count:1..8,repo?}` → `201 {ok,batchId}` מיידי |
| `GET /api/batches/:id` | סקר-מצב: `{terminal,counts:{DONE,FAILED,RUNNING,QUEUED},tasks,receipt}` |
| `GET /api/batches` | אצוות-אחרונות + התקדמות חיה |
| `GET /api/tasks/:id` | תוצר-מלא של משימה (כולל `output` חתום) |
| `POST /api/tasks` | שיגור-משימה-בודדת (העובד-החי קולט לבד) |
| `POST /api/worker/tick` | פעימה-ידנית (אופציונלי — לולאת-השרת עושה-זאת לבד כל 5 שניות) |
| `GET /api/ledger` | השרשרת המלאה + אימות |
| `GET /api/health` | דופק: `{ok,db,time}` |
| `GET /api/drill` | בדיקת-חיות-סולם (ירי-אמת קטן) |

סוגי-משימה (`kind`): `CODE` / `AUDIT` / `PLAN` — כל אחד עם חוזה-JSON מאומת (zod).

## הרצה מאפס (סנדבוקס-חדש — 3 צעדים)

```bash
git clone https://github.com/roshpinacare-sys/execution-fabric.git my-project && cd my-project
bun install && bun run db:push
# המפעיל מזריק-סמכות (gitignored): קובץ-הסמכות — שורה-אחת
.zscripts/dev.sh    # Next + mini-services (fabric-heartbeat: לולאת-tick + פעימת-גיט)
```

`fabric-heartbeat` מריץ שני עורקים: **tick כל 5 שניות** (קליטת-משימות-QUEUED בלי דפדפן) +
**פעימת-גיט כל 15 דק'** (אם-יש-שינויים: leak-scan → commit → rebase → push — הקיום-נשמר-בגיט).

## אחריות-טריטוריה

- worklog.md — append-only, כל-משימה מכריזת-היקף לפני-עבודה.
- רישום-אם בריפו `Sandbox` (רישום-טריטוריה + worklog של-האם).
