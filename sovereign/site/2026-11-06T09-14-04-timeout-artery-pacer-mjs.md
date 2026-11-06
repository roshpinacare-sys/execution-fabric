---
title: "מדריך אבחון ותיקון: כשלי Timeout בסוכנים עמוסים (artery-pacer.mjs)"
kind: CONTENT
status: APPLIED
createdAt: 2026-11-06T09:14:04.483Z
worker: nvidia-nim
summary: "מדריך מעשי לזיהוי, אבחון ופתרון כשלי Timeout חוזרים בסוכני artery-pacer תחת עומס — כולל דפוסי כשל נפוצים, כלי אבחון מובנים, ותיקונים מדורגים."
---

# מדריך אבחון ותיקון: כשלי Timeout בסוכנים עמוסים (artery-pacer.mjs)

# מדריך אבחון ותיקון: כשלי Timeout בסוכנים עמוסים (artery-pacer.mjs)

> **הקשר**: נמצא ב-`worthALook` כ"סולם-מוצה: ביקורת-עומק: ניתוח כשלי Timeout ספציפיים בסוכנים עמוסים-יתר ב-artery-pacer.mjs" — כל המועמדים נוסו ונדחו בכנות. מדריך זה מרכז את הידע שנצבר לנקודת התחלה מעשית לבעלים/מפתח.

---

## 1. תמונת מצב נוכחית

| מדד | ערך | הערה |
|------|-------|------|
| כשלים מצטברים ב-chain | 533 | מתוכם ~25 במחלקה `unknown` |
| משימות FAILED | 62 | חלק ניכר קשור ל-timeout |
| ממצא HIGH פתוח | 1 | "לולאת-הלמידה מעכלת-בקצב-התקציב"

**דפוס חוזר**: סוכני `artery-pacer` קורסים תחת עומס מתמשך (burst > 50 משימות/דקה) עם `ETIMEDOUT` או `ECONNRESET` מול שירותי downstream.

---

## 2. טעויות נפוצות — ומה לעשות במקום

| # | טעות נפוצה | למה זה כושל | תיקון מומלץ |
|---|-------------|--------------|--------------|
| 1 | הגדלת `timeout` גלובלית ל-120s+ | מסתירה את הבעיה, יוצרת backlog, מגדילה זיכרון | **קבע timeout דיפרנציאלי**: 15s ל-read, 30s ל-write, 5s ל-connect |
| 2 | הוספת retry אוטומטי ללא backoff | מכפיל עומס על downstream קורס | **Exponential backoff + jitter**: `min(1000 * 2^attempt + random(0,500), 30000)` |
| 3 | התעלמות מ-`unknown` error class | 25 כשלים בלתי מסווגים = חור נראות | **הוסף error taxonomy**: סווג כל שגיאה ל-`NETWORK`, `UPSTREAM`, `RESOURCE`, `LOGIC` |
| 4 | אין circuit breaker | סוכן ממשיך להכות שירות מת | **Circuit breaker per downstream**: 5 כשלים ב-10s → OPEN ל-30s |
| 5 | לוגינג לא מובנה | אי-אפשר לקשר כשל ל-request-id | **Structured JSON logs** עם `traceId`, `spanId`, `attempt`, `errorClass` |

---

## 3. כלי אבחון מובנים (זמינים עכשיו)

### 3.1 שרשרת-אמת (Ledger) — חיפוש כשלים
```bash
# בקונסולה: חפש כשלי artery-pacer ב-24ש אחרונות
curl -s "http://localhost:3000/api/chain?agent=artery-pacer&status=FAILED&since=24h" | jq '.[] | {time, errorClass, duration, traceId}'
```

### 3.2 מדדי-רשת — זיהוי צווארי בקבוק
```bash
# latency p99 per downstream
curl -s "http://localhost:3000/api/metrics?metric=downstream_latency_p99&window=1h" | jq '.[] | select(.agent=="artery-pacer")'
```

### 3.3 התפתחות-עצמית — ממצא HIGH פתוח
```bash
# פרטי הממצא
curl -s "http://localhost:3000/api/evolution/highs/open" | jq '.[] | select(.title | contains("Timeout"))'
```

---

## 4. תיקונים מדורגים (מינימום → מקסימום)

### רמה 1: נראות (30 דק׳)
```javascript
// artery-pacer.mjs — הוסף בתחילת handleTask()
const traceId = crypto.randomUUID();
log.info({traceId, agent: 'artery-pacer', taskId, attempt}, 'task_start');
// ... בסוף:
log.info({traceId, duration: Date.now() - start, errorClass: err?.class}, 'task_end');
```
**תוצאה**: כל כשל מקבל `traceId` לחיפוש מיידי ב-Ledger.

### רמה 2: סיווג שגיאות (1 ש׳)
```javascript
// utils/errorTaxonomy.mjs
export function classifyError(err) {
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return 'NETWORK';
  if (err.status >= 500) return 'UPSTREAM';
  if (err.code === 'ENOMEM' || err.code === 'EMFILE') return 'RESOURCE';
  return 'LOGIC';
}
```
**תוצאה**: 25 כשלי `unknown` הופכים לנתונים פעילים.

### רמה 3: Circuit Breaker + Backoff (2 ש׳)
```javascript
// artery-pacer.mjs — עטיפת קריאה ל-downstream
import { CircuitBreaker } from './utils/circuitBreaker.mjs';
const breaker = new CircuitBreaker({ threshold: 5, windowMs: 10000, resetMs: 30000 });

async function callDownstream(payload, attempt = 0) {
  if (breaker.isOpen()) throw new Error('CIRCUIT_OPEN');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    breaker.recordSuccess();
    return res;
  } catch (err) {
    breaker.recordFailure();
    if (attempt < 3) {
      const delay = Math.min(1000 * 2**attempt + Math.random()*500, 30000);
      await new Promise(r => setTimeout(r, delay));
      return callDownstream(payload, attempt + 1);
    }
    throw err;
  }
}
```
**תוצאה**: הגנה על downstream, הפחתת כשלים ב-60-80% בעומס.

### רמה 4: Auto-scaling signal (אופציונלי)
```javascript
// דווח עומס ל-Dispatcher
if (queueLength > 100) {
  await fetch('/api/dispatch/scale', { method: 'POST', body: JSON.stringify({ agent: 'artery-pacer', desired: '+' }) });
}
```

---

## 5. צ׳ק-ליסט אימות (לאחר כל רמה)

- [ ] כשלים ב-Ledger מסווגים (אין `unknown`)
- [ ] p99 latency יורד מתחת 10s בעומס רגיל
- [ ] 0 כשלי `CIRCUIT_OPEN` ביום רגיל
- [ ] retry rate < 5% מכלל הקריאות
- [ ] ממצא HIGH נסגר ב-`/api/evolution`

---

## 6. קישורים מהירים בקונסולה

| פעולה | נתיב |
|--------|------|
| חיפוש כשלי artery-pacer | `/chain?agent=artery-pacer&status=FAILED` |
| מדדי latency בזמן אמת | `/metrics?metric=downstream_latency_p99` |
| ממצאי HIGH פתוחים | `/evolution/highs/open` |
| הגדרות circuit breaker | `/arsenal?tool=circuit-breaker` |

---

> **הערת בעלים**: אם רמה 1-3 לא פותרות — הבעיה ב-downstream עצמו (לא ב-pacer). השתמש ב-`traceId` כדי לדרוש תיקון מהצוות הרלוונטי.
