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
| `GET /api/metrics` | מדדי-הרשת מהדאטה בלבד: אימות-שרשרת + פילוחי-יעילות |
| `GET /api/providers` | מצב-סולם-הספקים (מטא-דאטה בלבד — אפס-סודות) |
| `GET/POST /api/evolution` | לופ-ההתפתחות-העצמית + לולאת-הלמידה (Task 28): POST עם גוף-רשותי `{"mode":"auto"\|"propose"\|"learn"}` — auto = ממצא-HIGH לא-מטופל מביקורת-עצמית → למידה, אחרת הצעה-עצמית (יעד-ריפו רשותי עם אימות-חי); learn בלי-ממצאים = 404 כן. תקציב-שעתי 6 משותף |

סוגי-משימה (`kind`): `CODE` / `AUDIT` / `PLAN` — כל אחד עם חוזה-JSON מאומת (zod).

### לקוח-ייחוס לצרכנים (`integration/fabric-client.ts`)

לקוח-אפס-תלות (fetch בלבד — bun/node/דפדפן) עם-טיפוסים מלאים, timeout-כן, ו-`waitForBatch`:

```ts
import { FabricClient, parseOutput } from './integration/fabric-client'
const fabric = new FabricClient('http://127.0.0.1:3000')
await fabric.health()
const { batchId } = await fabric.dispatchBatch({ title: 'כותרת', kind: 'PLAN', prompt: '...', count: 3 })
const done = await fabric.waitForBatch(batchId)          // סקר-עד-סוף-חיים (timeout = שקר-אסור)
const out = parseOutput<{ steps: { title: string; detail: string }[] }>(done.tasks[0])
const chain = await fabric.ledger()                       // { entries, verify: { ok, head, verified } }
```

חוזה-הפלט: `output` ב-`/api/tasks/:id` הוא **מחרוזת-JSON** לפי-חוזה-ה-kind —
למשל PLAN: `{"steps":[{"title":string,"detail":string}]}` (3-12 שלבים).

## הרצה מאפס (סנדבוקס-חדש — 3 צעדים)

```bash
git clone https://github.com/roshpinacare-sys/execution-fabric.git my-project && cd my-project
bun install && bun run db:push
# המפעיל מזריק-סמכות (gitignored): קובץ-הסמכות — שורה-אחת
.zscripts/dev.sh    # Next + mini-services (fabric-heartbeat: לולאת-tick + פעימת-גיט)
```

`fabric-heartbeat` מריץ ארבעה עורקים: **tick כל 5 שניות** (קליטת-משימות-QUEUED בלי דפדפן) +
**פעימת-גיט כל 15 דק'** (אם-יש-שינויים: leak-scan → commit → rebase → push — הקיום-נשמר-בגיט;
קונפליקט-db נפתר-עצמית עם-הוכחת-הכלה מהשרשרת — Task 27) + **פעימת-התפתחות כל 20 דק'**
(הרשת מציעה לעצמה עבודה — ירי-אמת, תקציב-כן) + **שומר-אפליקציה** (3 כשלים = הזנקה-עצמית).

## אחריות-טריטוריה

- worklog.md — append-only, כל-משימה מכריזת-היקף לפני-עבודה.
- רישום-אם בריפו `Sandbox` (רישום-טריטוריה + worklog של-האם).
