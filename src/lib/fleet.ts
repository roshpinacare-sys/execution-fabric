import { z } from 'zod'
import { auditOutputSchema } from '@/lib/llm-chain'

// צי-ביקורת מקבילי (worklog Task 15) — טופולוגיית Review Panel מ-swarm-discipline:
// עדשות = עובדים פשוטים שמעולם לא ממזגות את עצמן; המיזוג = קריאת-סינתזה נפרדת
// שמקבלת רק תוצרי-עובדים מאומתים. אין המצאות: סינתזה בלי חומר = כשל כן.

export const FLEET_LENSES = ['CORRECTNESS', 'SECURITY', 'PERFORMANCE', 'STYLE'] as const
export type FleetLens = (typeof FLEET_LENSES)[number]

export const LENS_LABEL: Record<FleetLens, string> = {
  CORRECTNESS: 'נכונות',
  SECURITY: 'אבטחה',
  PERFORMANCE: 'ביצועים',
  STYLE: 'תחזוקה',
}

const LENS_BRIEF: Record<FleetLens, string> = {
  CORRECTNESS:
    'בדוק נכונות לוגית בלבד: תרחישי-קצה, טיפול-שגיאות, מצבים לא-מוגדרים, סתירות בין חוזה-הקלט לפלט.',
  SECURITY:
    'בדוק אבטחה בלבד: אימות-קלט, הרשאות, דליפת-מידע, הזרקות, מצבי-מירוץ כספיים, fail-closed מול fail-open.',
  PERFORMANCE:
    'בדוק ביצועים בלבד: מורכבות-חישוב, בזבוז-זיכרון, צווארי-בקבוק, התנהגות בקנה-מידה גדול.',
  STYLE:
    'בדוק תחזוקתיות בלבד: קריאות, שמות, כפילויות, עומק-קינון, התאמה לארכיטקטורה הקיימת.',
}

// כל עדשה יורה בדיוק את חוזה-AUDIT — ולידציה זהה לכל העדשות (auditOutputSchema)
export function lensPrimarySystem(lens: FleetLens): string {
  return [
    `אתה בודק-קוד בכיר בצי-ביקורת מקבילי, והעדשה היחידה שלך היא: ${LENS_LABEL[lens]}.`,
    LENS_BRIEF[lens],
    'אל תבדוק דבר מחוץ לעדשה שלך — זו עדשת-עמית מקבילה ותחומים אחרים יטופלו בנפרד.',
    'הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown, בלי טקסט-עוטף.',
    'הסכימה המדויקת: {"verdict":"<מסקנה כוללת קצרה>","findings":[{"severity":"HIGH"|"MEDIUM"|"LOW","title":"<כותרת>","detail":"<הסבר>"}]}.',
    'אין המצאות: ממצא בלי בסיס בקלט — לא נכתב. אין ממצאים? החזר findings עם ממצא LOW יחיד שמנסח זאת.',
  ].join(' ')
}

export function buildWorkerUserPrompt(target: string): string {
  return `יעד-הביקורת (מטעם מנהל-הצי):\n${target}`
}

export const FLEET_SYNTHESIS_SYSTEM = [
  'אתה מנהל-הצי — הממזג היחיד (העובדים אף-פעם לא ממזגים את עצמן).',
  'קיבלת תוצרים מאומתים מעדשות-ביקורת מקביליות על אותו יעד. תפקידך: קונסנזוס.',
  'כללים: אגד ממצאים זהים/חופפים להסכמה אחת (ציין אילו עדשות תמכו); סתירות בין עדשות — אל תכריע בשקט, רשום אותן כקונפליקט עם שתי-העמדות; אל תוסיף ממצאים משלך שלא נכחו בחומר.',
  'הפלט שלך חייב להיות אובייקט JSON תקף בלבד — בלי markdown, בלי טקסט-עוטף.',
  'הסכימה המדויקת: {"consensus":"<מסקנה ממוזגת>","severity":"HIGH"|"MEDIUM"|"LOW"|"CLEAN","agreements":[{"title":"<כותרת>","detail":"<הסבר>","lenses":["<עדשות תומכות>"]}],"conflicts":[{"title":"<כותרת>","detail":"<הסבר עם שתי-העמדות>","lenses":["<לפחות שתי עדשות>"]}]}',
].join(' ')

export const fleetSynthesisSchema = z.object({
  consensus: z.string().min(10).max(3000),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'CLEAN']),
  agreements: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        detail: z.string().min(10).max(2000),
        lenses: z.array(z.string().min(2).max(30)).min(1).max(6),
      })
    )
    .max(12),
  conflicts: z
    .array(
      z.object({
        title: z.string().min(3).max(200),
        detail: z.string().min(10).max(2000),
        lenses: z.array(z.string().min(2).max(30)).min(2).max(6),
      })
    )
    .max(12),
})

export const FLEET_SYNTHESIS_COMPACT =
  'ענה ב-JSON תקף בלבד, ללא טקסט אחר: {"consensus":string,"severity":"HIGH"|"MEDIUM"|"LOW"|"CLEAN","agreements":[{"title":string,"detail":string,"lenses":string[]}],"conflicts":[{"title":string,"detail":string,"lenses":string[]}]}. אגד ממצאים חופפים, אל תכריע סתירות בשקט (רשום ב-conflicts), ואל תוסיף ממצאים שלא נכחו בחומר.'

export interface WorkerResultForSynthesis {
  lens: string
  output: unknown // תוצר-עובד מאומת בלבד (עבר auditOutputSchema)
}

export function buildSynthesisUserPrompt(
  target: string,
  workerResults: WorkerResultForSynthesis[]
): string {
  const payload = workerResults.map((w) => ({
    lens: w.lens,
    findings: w.output,
  }))
  return [
    `יעד-הביקורת המקורי:\n${target}`,
    '',
    `תוצרי-העדשות המאומתים (${payload.length}):`,
    JSON.stringify(payload),
  ].join('\n')
}

// אימות-מפעל: ודא שתוצר-עובד אכן עומד בחוזה-AUDIT לפני שהוא נכנס לסינתזה
export { auditOutputSchema as fleetWorkerSchema }
