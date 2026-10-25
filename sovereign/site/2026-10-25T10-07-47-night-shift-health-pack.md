---
title: "חבילת אינדיקטורי בריאות למשמרת-לילה — Night-Shift Health Pack"
kind: DATA
status: APPLIED
createdAt: 2026-10-25T10:07:47.719Z
worker: nvidia-nim
summary: "JSON payload מוכן-להצגה בקונסולה RTL: מדדי שרשרת-אמת, תור משימות, זיכרון רשת, התראות HIGH פתוחות, וסטטוס עורקי-לב — כרטיס אחד שמאפשר למשמרת-לילה לאבחן מצב רשת ב-30 שניות."
---

# חבילת אינדיקטורי בריאות למשמרת-לילה — Night-Shift Health Pack

# חבילת אינדיקטורי בריאות למשמרת-לילה

קובץ JSON זה נועד להיטען ישירות לכרטיס **"משמרת-לילה"** בקונסולה RTL. הוא מרכז את כל המדדים הקריטיים שצוות תורן צריך כדי להחליט תוך דקות: האם הרשת בריאה, היכן צווארי-בקבוק, ואילו לולאות פתוחות דורשות טיפול מיידי.

## מבנה ה-payload

| שדה | סוג | תיאור | מקור נתונים |
|------|------|---------|--------------|
| `generatedAt` | ISO8601 | חותמת זמן יצירת החבילה | שרת המטא-דאטה |
| `chain` | object | בריאות שרשרת-אמת (Ledger) | `/api/metrics` → `chain` |
| `tasks` | object | מצב תור המשימות המרכזי | `/api/metrics` → `tasksByStatus` |
| `memory` | object | מצב זיכרון רשת ולולאות פתוחות | `/api/metrics` → `memory` |
| `highFindings` | object | ממצאי HIGH פתוחים מביקורות עצמיות | `/api/evolution` → `openHighs` |
| `arteries` | object | סטטוס עורקי-לב (Night-Shift Arteries) | `/api/census` → `arteries` |
| `alerts` | array | רשימת התראות מחושבות (אוטומטי) | נגזר מהשדות לעיל |

## לוגיקת התראות אוטומטית (מומלצת למימוש בקונסולה)

```javascript
function computeAlerts(p) {
  const alerts = [];
  // שרשרת-אמת: יחס כשל > 15%
  if (p.chain.failed / (p.chain.done + p.chain.failed) > 0.15) {
    alerts.push({level:'critical', code:'CHAIN_HIGH_FAILURE_RATE', msg:`שרשרת-אמת: ${p.chain.failed} כשלים מתוך ${p.chain.done + p.chain.failed} בלוקים`});
  }
  // תור משימות: כשלים > 10% או תור תקוע
  const taskTotal = p.tasks.DONE + p.tasks.FAILED;
  if (taskTotal > 0 && p.tasks.FAILED / taskTotal > 0.1) {
    alerts.push({level:'warning', code:'TASK_HIGH_FAILURE_RATE', msg:`משימות: ${p.tasks.FAILED} כשלים מתוך ${taskTotal}`});
  }
  // זיכרון: לולאות פתוחות > 10
  if (p.memory.openLoops > 10) {
    alerts.push({level:'attention', code:'MEMORY_OPEN_LOOPS', msg:`${p.memory.openLoops} לולאות פתוחות בזיכרון רשת`});
  }
  // HIGH findings > 5
  if (p.highFindings.open > 5) {
    alerts.push({level:'attention', code:'HIGH_FINDINGS_BACKLOG', msg:`${p.highFindings.open} ממצאי HIGH פתוחים`});
  }
  // עורקי-לב: כל עורק לא במצב 'healthy'
  Object.entries(p.arteries).forEach(([name, status]) => {
    if (status !== 'healthy') {
      alerts.push({level:'critical', code:'ARTERY_UNHEALTHY', msg:`עורק ${name}: ${status}`});
    }
  });
  return alerts;
}
```

## דוגמת שימוש בקונסולה RTL

```jsx
import NightShiftCard from '@/components/console/NightShiftCard';

function NightShiftPage() {
  const [pack, setPack] = useState(null);
  useEffect(() => {
    fetch('/api/nightshift/health-pack')
      .then(r => r.json())
      .then(setPack);
  }, []);
  return <NightShiftCard data={pack} />;
}
```

הכרטיס יציג:
- **סרגל בריאות כללי** (ירוק/צהוב/אדום) לפי חומרת ההתראה הגבוהה ביותר
- **4 כרטיסי מדד ראשיים**: שרשרת, משימות, זיכרון, HIGH-findings
- **רשימת עורקי-לב** עם סטטוס צבעוני
- **פאנל התראות** ממוין לפי חומרה
- **כפתור רענון ידני** + טיימר רענון אוטומטי (30 שניות)

---
*חבילה זו מיוצרת אוטומטית בכל מחזור התפתחות. גרסה: 2026-10-25T10:07:12.515Z*
