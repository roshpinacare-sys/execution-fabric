// ארסנל-הכלים (worklog Task 35) — שמישות-מלאה של כל-מה-שנאסף ונבנה:
// "יש לנו מלא כלים שאספנו מגיטים אחרים ועוד — צריך אימון, שימוש ופיתוח עם כל-הכלים".
// זהו הקטלוג-החי: כל-כלי עם נתיב-שימוש ממשי (endpoint/CLI/קוד), סיווג (disktree
// classify-by-kind), ומצב-כנה (חי/אטום/מוצע). הקונסולה מציגה אותו, והארכיטקטורה
// והריבונות קוראות אותו דרך החוזה (fabric-client.arsenal()).
//
// כנות: סטטוס הוא הצהרה-מנוהלת בקוד (git-first), והנתיבים מדויקים. מה שאטום —
// אטום בגלל סיבה-מתועדת (כמו IPAI), ומה שחי — חי בירי-אמת שאומת בשרשרת.

import { nvidiaConfigured } from '@/lib/providers'

export type ArsenalCategory =
  | 'execution'
  | 'truth'
  | 'evolution'
  | 'delivery'
  | 'access'
  | 'infra'
  | 'platform'

export interface ArsenalTool {
  id: string
  nameHe: string
  category: ArsenalCategory
  /** נתיב-השימוש הממשי: endpoint / CLI / קוד */
  usagePath: string
  status: 'LIVE' | 'SEALED' | 'PROPOSED'
  notesHe: string
}

export const ARSENAL: ArsenalTool[] = [
  // ===== ביצוע =====
  {
    id: 'dispatch-task',
    nameHe: 'שיגור-משימה בודדת',
    category: 'execution',
    usagePath: 'POST /api/tasks',
    status: 'LIVE',
    notesHe: 'CODE/AUDIT/PLAN — נאכף-חוזה-zod; יעד-ריפו נאמת-חי לפני-קבלה',
  },
  {
    id: 'dispatch-batch',
    nameHe: 'שיגור-אצווה מקבילה (צי)',
    category: 'execution',
    usagePath: 'POST /api/batches',
    status: 'LIVE',
    notesHe: '201 + batchId מיידי; ביצוע-רקע; parallel מרוסן; waitForBatch בלקוח',
  },
  {
    id: 'task-run',
    nameHe: 'הרצת-משימה ידנית',
    category: 'execution',
    usagePath: 'POST /api/tasks/:id/run',
    status: 'LIVE',
    notesHe: 'קליטה אטומית — עובד-אחר שקלט קודם גובר (409)',
  },
  {
    id: 'worker-tick',
    nameHe: 'עובד-הרשת (עורק-א)',
    category: 'execution',
    usagePath: 'POST /api/worker/tick',
    status: 'LIVE',
    notesHe: 'קליטה-וביצוע-עצמיים כל 5 שניות מהלב; מרפא-תקועות-RUNNING',
  },
  {
    id: 'fabric-client',
    nameHe: 'לקוח-אינטגרציה לארכיטקטורה',
    category: 'execution',
    usagePath: 'integration/fabric-client.ts',
    status: 'LIVE',
    notesHe: 'אפס-תלות (fetch) — הארכיטקטורה והריבונות שוגרות/סוקרות/ממתינות/חותמות',
  },
  // ===== אמת =====
  {
    id: 'ledger',
    nameHe: 'שרשרת-האמת',
    category: 'truth',
    usagePath: 'GET /api/ledger',
    status: 'LIVE',
    notesHe: 'hash-chain fail-closed; אימות-מקצה-לקצה בכל-קריאה; מטא-דאטה בלבד',
  },
  {
    id: 'metrics',
    nameHe: 'מדדי-הרשת',
    category: 'truth',
    usagePath: 'GET /api/metrics',
    status: 'LIVE',
    notesHe: 'פילוחי-יעילות נגזרים-מהדאטה בלבד — לא-נמדד=לא-נטען (disktree)',
  },
  {
    id: 'census',
    nameHe: 'פקח-הריבונות',
    category: 'truth',
    usagePath: 'GET /api/census',
    status: 'LIVE',
    notesHe: 'אינטליגנציית-אחזות מלאה + פסיפס-סוגים + שווה-מבט; ?view=memory לזיכרון',
  },
  {
    id: 'drill',
    nameHe: 'בדיקת-חיות',
    category: 'truth',
    usagePath: 'GET /api/drill',
    status: 'LIVE',
    notesHe: 'ירי-אמת אחד — DRILL-OK או כשל-כן עם errorClass',
  },
  // ===== התפתחות =====
  {
    id: 'evolution',
    nameHe: 'לולאת-ההתפתחות-העצמית',
    category: 'evolution',
    usagePath: 'POST /api/evolution {mode:auto|propose|learn}',
    status: 'LIVE',
    notesHe: 'הרשת מציעה לעצמה עבודה ולומדת מממצאי-הביקורת; תקציב 12/שעה',
  },
  {
    id: 'sitebuild',
    nameHe: 'עורק-הבנייה (קיר-הצמיחה)',
    category: 'evolution',
    usagePath: 'POST /api/sovereign/build',
    status: 'LIVE',
    notesHe: 'הרשת בונה את המוצר עצמו: תוכן/נתונים/הצעות — ארטיפקטים ב-sovereign/site/; תקציב 6/שעה',
  },
  {
    id: 'improvements',
    nameHe: 'רשימת-השיפורים',
    category: 'evolution',
    usagePath: 'GET /api/sovereign/improvements',
    status: 'LIVE',
    notesHe: 'קיר-הצמיחה — מטא-דאטה ותקצירים; תוכן-מלא בארטיפקטים בגיט',
  },
  // ===== העברה =====
  {
    id: 'handoff-gate',
    nameHe: 'שער-ההעברה לגיט',
    category: 'delivery',
    usagePath: 'GET|POST /api/handoffs · approve · execute',
    status: 'LIVE',
    notesHe: 'פריסה-מאושרת-בעלים בלבד: סריקת-סודות → putContents → read-back מאומת',
  },
  {
    id: 'handoff-auto',
    nameHe: 'הצעות-העברה אוטומטיות',
    category: 'delivery',
    usagePath: 'lib/autohandoff.ts',
    status: 'LIVE',
    notesHe: 'תוצר-CODE של למידה/התפתחות עם יעד-ריפו נכנס לשער כ-PROPOSED (auto:true)',
  },
  {
    id: 'leak-scan',
    nameHe: 'סורק-הדליפות',
    category: 'delivery',
    usagePath: 'node .zscripts/leak-scan.mjs --staged',
    status: 'LIVE',
    notesHe: 'חסם-כן לפני-כל-push: אפס-התאמות-סודות או-אין-דחיפה',
  },
  // ===== גישה =====
  {
    id: 'rail-zai',
    nameHe: 'מסילת-z.ai (ראשית)',
    category: 'access',
    usagePath: 'callLlm() — z-ai-web-dev-sdk',
    status: 'LIVE',
    notesHe: 'המועמד-הראשי בכל-סולם; רק בקצה-האחורי',
  },
  {
    id: 'rail-nvidia',
    nameHe: 'מסילת-NVIDIA NIM',
    category: 'access',
    usagePath: 'nvidiaChat() — integrate.api.nvidia.com',
    status: nvidiaConfigured() ? 'LIVE' : 'SEALED',
    notesHe: 'מועמד-שני בסולם (נמוטרון-סופר 120B); מצב-חי נגזר-מהתצורה',
  },
  {
    id: 'rail-ipai',
    nameHe: 'מסילת-IPAI',
    category: 'access',
    usagePath: '—',
    status: 'SEALED',
    notesHe: 'מפתח-בכספת; ספק-לא-זוהה (401) — אטום-כן עד-זיהוי, מחוץ-לסולם',
  },
  {
    id: 'vault',
    nameHe: 'כספת-המפתחות',
    category: 'access',
    usagePath: 'env-load בזמן-ריצה (אפס-ערכים בקוד/לוג)',
    status: 'LIVE',
    notesHe: 'ערכים-לעולם לא נדפסים; הפקח סוקר נוכחות-שמות בלבד',
  },
  {
    id: 'git-cred',
    nameHe: 'הסמכת-גיט',
    category: 'access',
    usagePath: '.zscripts/git-credential-pat.sh (credential-helper)',
    status: 'LIVE',
    notesHe: 'קורא-סמכות בזמן-ריצה בלבד — אף-ערך לא עובר ללוג/קוד',
  },
  // ===== תשתית =====
  {
    id: 'heart-a',
    nameHe: 'עורק-א · עובד-הרשת',
    category: 'infra',
    usagePath: 'mini-services/fabric-heartbeat (:3031/status)',
    status: 'LIVE',
    notesHe: 'tick כל 5 שניות — הרשת מבצעת גם-בלי דפדפן',
  },
  {
    id: 'heart-b',
    nameHe: 'עורק-ב · פעימת-גיט',
    category: 'infra',
    usagePath: 'mini-services/fabric-heartbeat (:3031/status)',
    status: 'LIVE',
    notesHe: 'כל 15 דק׳: pull-rebase → leak-scan → commit → push; פתרון-קונפליקט-db עצמי',
  },
  {
    id: 'heart-c',
    nameHe: 'עורק-ג · פעימת-התפתחות',
    category: 'infra',
    usagePath: 'mini-services/fabric-heartbeat (:3031/status)',
    status: 'LIVE',
    notesHe: 'כל 5 דק׳ → POST /api/evolution (auto) — תקציב-כן 12/שעה',
  },
  {
    id: 'heart-d',
    nameHe: 'עורק-ד · פעימת-בנייה',
    category: 'infra',
    usagePath: 'mini-services/fabric-heartbeat (:3031/status)',
    status: 'LIVE',
    notesHe: 'כל 10 דק׳ → POST /api/sovereign/build — המוצר צומח בלי-יד-אנושית',
  },
  {
    id: 'heart-0',
    nameHe: 'עורק-0 · שומר-האפליקציה',
    category: 'infra',
    usagePath: 'mini-services/fabric-heartbeat (:3031/status)',
    status: 'LIVE',
    notesHe: 'בריאות כל 15 שניות; 3-כשלים = הזנקה-עצמית — הרשת מרפאת-את-עצמה',
  },
  {
    id: 'db-reconnect',
    nameHe: 'ריפוי-שכבת-אחסון',
    category: 'infra',
    usagePath: 'POST /api/admin/db-reconnect',
    status: 'LIVE',
    notesHe: 'אחרי-החלפת-קובץ-db (pull) — חיבור-מחדש לקובץ-האמת; הלב מזהה-inode לבד',
  },
  // ===== פלטפורמה =====
  {
    id: 'sdk-llm',
    nameHe: 'SDK · יצירת-טקסט (LLM)',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — chat.completions',
    status: 'LIVE',
    notesHe: 'בקצה-האחורי בלבד; המנוע-שמאחורי-כל-הסולמות',
  },
  {
    id: 'sdk-vlm',
    nameHe: 'SDK · הבנת-תמונות (VLM)',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — backend',
    status: 'LIVE',
    notesHe: 'זמין-לעורקים-עתידיים: ניתוח-צילומי-מסך של הקונסולה',
  },
  {
    id: 'sdk-image',
    nameHe: 'SDK · יצירת-תמונות',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — backend',
    status: 'LIVE',
    notesHe: 'נכסים-גרפיים למוצר — דרך עורק-הבנייה (PROPOSAL/ארטיפקט)',
  },
  {
    id: 'sdk-video',
    nameHe: 'SDK · יצירת-וידאו',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — backend',
    status: 'PROPOSED',
    notesHe: 'ממתין-שימוש-ראשון-מוצדק במוצר (לא-נמדד=לא-נטען)',
  },
  {
    id: 'sdk-tts',
    nameHe: 'SDK · טקסט-לדיבור (TTS)',
    category: 'platform',
    usagePath: 'POST /api/sovereign/content/[id]/narrate — zai.audio.tts (wav, tongtong)',
    status: 'LIVE',
    notesHe: 'חי מ-Task 39: הקראת-תוכן-עברית לקונסולה — ירי-אמת מוכח (323KB wav/2.6s, חתימת-NARRATE בשרשרת)',
  },
  {
    id: 'sdk-asr',
    nameHe: 'SDK · דיבור-לטקסט (ASR)',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — backend',
    status: 'PROPOSED',
    notesHe: 'ממתין-שימוש-ראשון-מוצדק במוצר',
  },
  {
    id: 'sdk-web-search',
    nameHe: 'SDK · חיפוש-רשת',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — backend',
    status: 'LIVE',
    notesHe: 'מחקר-חי (disktree נחקר-בו) — זמין-לעורקי-מחקר',
  },
  {
    id: 'sdk-web-reader',
    nameHe: 'SDK · קריאת-דפים',
    category: 'platform',
    usagePath: 'z-ai-web-dev-sdk — backend',
    status: 'LIVE',
    notesHe: 'חילוץ-תוכן-חי — זמין-לעורקי-מחקר',
  },
]

export interface ArsenalReport {
  ok: true
  tools: ArsenalTool[]
  meta: { total: number; live: number; sealed: number; proposed: number }
}

export function arsenalReport(): ArsenalReport {
  const tools = ARSENAL
  return {
    ok: true,
    tools,
    meta: {
      total: tools.length,
      live: tools.filter((t) => t.status === 'LIVE').length,
      sealed: tools.filter((t) => t.status === 'SEALED').length,
      proposed: tools.filter((t) => t.status === 'PROPOSED').length,
    },
  }
}
