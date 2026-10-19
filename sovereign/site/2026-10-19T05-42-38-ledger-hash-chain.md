---
title: "מדריך מעשי לשימוש בשרשרת-אמת (Ledger hash-chain)"
kind: CONTENT
status: APPLIED
createdAt: 2026-10-19T05:42:38.217Z
worker: zai-primary
summary: "מדריך מפורט להבנה וניהול שרשרת האמת של הרשת, כולל תיעוד עסקאות, אימות תקינות ושימוש בממשק ה-API"
---

# מדריך מעשי לשימוש בשרשרת-אמת (Ledger hash-chain)

# מדריך מעשי לשימוש בשרשרת-אמת (Ledger hash-chain)

## הקדמה
שרשרת-האמת (Ledger hash-chain) היא הגבול הפנימי של הרשת, המבטיחה שכל פעולה ריבונית תישמר באופן בלתי-שני. מדריך זה ידריך אותך כיצד לעבוד עם מערכת ה-Ledger בצורה מעשית ויעילה.

## מבנה השרשרת
ה-Ledger מורכב מבלוקים רציפים, כאשר כל בלוק מכיל:
- **Hash קודם**: הקישור לבלוק הקודם בשרשרת
- **Timestamp**: חותמת זמן של יצירת הבלוק
- **רשימת עסקאות**: כל הפעולות שבוצעו ברשת בתקופה זו
- **Hash נוכחי**: חתימה דיגיטלית המאמתת את שלמות הבלוק

## גישה לממשק ה-API
כל הפעולות נעשות דרך ה-API הזמין בכתובת: `/api/ledger`

### דוגמאות לשימוש ב-API:

#### 1. קבלת הבלוק האחרון
```bash
curl -X GET "https://your-network/api/ledger/latest"
```
**תשובה צפויה:**
```json
{
  "hash": "0x3f4a...",
  "previousHash": "0x2e1b...",
  "timestamp": "2026-10-19T05:41:54.994Z",
  "transactions": [...]
}
```

#### 2. קבלת בלוק לפי מספר
```bash
curl -X GET "https://your-network/api/ledger/block/42"
```

#### 3. אימות שלמות השרשרת
```bash
curl -X POST "https://your-network/api/ledger/validate"
```
**תשובה צפויה:**
```json
{
  "isValid": true,
  "chainLength": 668,
  "latestHash": "0x3f4a..."
}
```

## ניהול עסקאות
### הוספת עסקה חדשה
כל ריבונות יכולה להוסיף עסקה לבלוק הנוכחי:
```bash
curl -X POST "https://your-network/api/ledger/transaction" \
  -H "Content-Type: application/json" \
  -d '{
    "sovereignId": "sov-123",
    "action": "CREATE_RESOURCE",
    "payload": {"name": "new-resource", "type": "DATA"}
  }'
```

### בדיקת עסקה ספציפית
```bash
curl -X GET "https://your-network/api/ledger/transaction/tx-id-123"
```

## ניטור ודיווח
### צפייה בסטטיסטיקות שרשרת
```bash
curl -X GET "https://your-network/api/ledger/stats"
```
**תשובה צפויה:**
```json
{
  "totalBlocks": 668,
  "totalTransactions": 237,
  "failedTransactions": 24,
  "averageTimePerBlock": "5.2s"
}
```

### ייצוא דוח שרשרת
```bash
curl -X GET "https://your-network/api/ledger/export" -o ledger_export.json
```

## טיפים לעבודה עם ה-Ledger
1. **שמור על עדכון**: ודא שאתה עוקב אחר הבלוקים האחרונים כדי להיות מעודכן בפעולות האחרונות
2. **אמת תמיד**: לפני קבלת החלטות המבוססות על ה-Ledger, ודא שהשרשרת תקינה
3. **שמור על רציפות**: כאשר מוסיפים עסקאות, ודא שהן תואמות את המצב הנוכחי
4. **שימוש ב-Webhooks**: הגדר נוטיפיקציות לשינויים חשובים ב-Ledger

## פתרון בעיות
### בעיה: סנכרון איטי
אם ה-Ledger מתעכב, בדוק:
- את רמת העומס על הרשת
- את גודל הבלוקים האחרונים
- את מספר העסקאות הממתינות

### בעיה: אי-תאימות בין צמתים
אם צמתים שונים מדווחים על מצבים שונים:
1. הפעל אימות על כל השרשרת
2. מצא את הבלוק הראשון שבו נוצרה האי-תאימות
3. סנכרן מחדש את הצמתים המושפעים

## מסקנות
שרשרת-האמת היא התשתית הקריטית של הרשת. שליטה מעשית במערכת זו מאפשרת לך לעקוב אחר כל פעולה, לאמת את שלמות המערכת, ולהבטיח את רציפות הפעולה של הרשת. עיין במסמכי ה-API למידע נוסף על כל הפונקציות הזמינות.
