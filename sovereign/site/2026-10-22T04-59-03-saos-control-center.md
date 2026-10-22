---
title: "מדריך הגדרת סביבת פיתוח מקומית ל-SAOS Control Center"
kind: CONTENT
status: APPLIED
createdAt: 2026-10-22T04:59:03.481Z
worker: nvidia-nim
summary: "תיעוד שלב-אחר-שלב להקמה מהירה של סביבת עבודה מלאה כולל מסד נתונים, משתני סביבה והרצת שרת הפיתוח"
---

# מדריך הגדרת סביבת פיתוח מקומית ל-SAOS Control Center

# מדריך הגדרת סביבת פיתוח מקומית ל-SAOS Control Center

> **מטרה**: לאפשר לכל מפתח חדש להרים סביבה עובדת תוך פחות מ-10 דקות.

---

## 1. דרישות מוקדמות

| כלי | גרסה מינימלית | בדיקה מהירה |
|------|----------------|---------------|
| Node.js | 20.x LTS | `node --version` |
| pnpm | 9.x | `pnpm --version` |
| Docker | 24.x | `docker --version` |
| Git | 2.40+ | `git --version` |

> **הערה**: אם חסר כלי — התקן דרך מנהל החבילות של המערכת (Homebrew / apt / winget / scoop).

---

## 2. שכפול המאגר והתקנת תלויות

```bash
# שכפול
 git clone https://github.com/your-org/saos-control-center.git
 cd saos-control-center

# התקנת תלויות (כולל workspace packages)
 pnpm install --frozen-lockfile
```

---

## 3. הרמת שירותי תשתית עם Docker Compose

הקובץ `docker-compose.dev.yml` מרים:
- **PostgreSQL 16** (פורט 5432)
- **Redis 7** (פורט 6379)
- **MinIO** (פורט 9000/9001) — אחסון אובייקטים תואם S3

```bash
# הרמה ברקע
 docker compose -f docker-compose.dev.yml up -d

# בדיקת בריאות
 docker compose -f docker-compose.dev.yml ps
```

פלט צפוי:
```
NAME                    STATUS          PORTS
saos-postgres           running         0.0.0.0:5432->5432/tcp
saos-redis              running         0.0.0.0:6379->6379/tcp
saos-minio              running         0.0.0.0:9000-9001->9000-9001/tcp
```

---

## 4. הגדרת משתני סביבה

העתק את קובץ הדוגמה וערוך לפי הצורך:

```bash
 cp .env.example .env.local
```

ערכים קריטיים שחייבים להתאים ב-`.env.local`:

```ini
# מסד נתונים
DATABASE_URL="postgresql://saos:saos@localhost:5432/saos_dev?schema=public"

# Redis
REDIS_URL="redis://localhost:6379"

# MinIO / S3
S3_ENDPOINT="http://localhost:9000"
S3_ACCESS_KEY="minioadmin"
S3_SECRET_KEY="minioadmin"
S3_BUCKET="saos-dev"
S3_REGION="us-east-1"

# אימות (NextAuth)
NEXTAUTH_SECRET="$(openssl rand -base64 32)"
NEXTAUTH_URL="http://localhost:3000"

# מצב פיתוח
NODE_ENV="development"
```

> **טיפ**: הפקודה `openssl rand -base64 32` מייצרת מפתח אקראי חזק. הרץ אותה בטרמינל והדבק את הפלט.

---

## 5. הכנת מסד הנתונים

```bash
# הרצת מיגרציות (Prisma)
 pnpm db:migrate:dev

# הזנת נתוני התחלה (seed) — משתמש דמו, הגדרות ברירת מחדל
 pnpm db:seed
```

הפקודה `db:seed` יוצרת:
- משתמש מנהל: `admin@saos.local` / סיסמה: `SaosDev123!`
- ארגון ברירת מחדל
- הגדרות מערכת בסיסיות

---

## 6. הרצת שרת הפיתוח

```bash
 pnpm dev
```

השרת יעלה ב- **http://localhost:3000**.

בדיקת בריאות מהירה:
```bash
 curl -s http://localhost:3000/api/health | jq .
```
פלט צפוי: `{"status":"ok","timestamp":"..."}`

---

## 7. אימות ההתקנה — רשימת בקרה

| שלב | בדיקה | סטטוס |
|------|--------|-------|
| 1 | דף הבית נטען ללא שגיאות קונסול | ☐ |
| 2 | התחברות עם `admin@saos.local` מצליחה | ☐ |
| 3 | לוח המשימות מציג משימות דמו | ☐ |
| 4 | דף מדדי רשת (`/metrics`) מחזיר JSON תקין | ☐ |
| 5 | העלאת קובץ דרך MinIO עובדת | ☐ |
| 6 | הרצת בדיקות יחידה: `pnpm test` עובר | ☐ |

---

## 8. פתרון בעיות נפוצות

### שגיאת חיבור למסד נתונים
```
Error: P1001: Can't reach database server
```
**פתרון**: ודא ש-Docker רץ והקונטיינר `saos-postgres` ב-status `running`. בדוק פורט 5432 לא תפוס.

### שגיאת `NEXTAUTH_SECRET` חסר
```
Error: Please define NEXTAUTH_SECRET
```
**פתרון**: ודא שהערך קיים ב-`.env.local` ואז הפעל מחדש את `pnpm dev`.

### פורט 3000 תפוס
```
Error: listen EADDRINUSE: address already in use :::3000
```
**פתרון**: `lsof -ti:3000 | xargs kill -9` או שנה פורט ב-`package.json` (`"dev": "next dev -p 3001"`).

### מיגרציות נתקעות
```bash
# איפוס מלא (מוחק נתונים!)
 pnpm db:reset
```

---

## 9. פקודות שימושיות יומיומיות

| משימה | פקודה |
|--------|---------|
| הרצת לינטר | `pnpm lint` |
| הרצת טייפ-צ'ק | `pnpm typecheck` |
| הרצת בדיקות | `pnpm test` |
| בניית פרודקשן | `pnpm build` |
| פתיחת Prisma Studio | `pnpm db:studio` |
| צפייה בלוגי Docker | `docker compose -f docker-compose.dev.yml logs -f` |
| כיבוי תשתית | `docker compose -f docker-compose.dev.yml down` |
| כיבוי + מחיקת volumes | `docker compose -f docker-compose.dev.yml down -v` |

---

## 10. מבנה תיקיות רלוונטי

```
saos-control-center/
├── apps/
│   └── web/                 # Next.js App Router (המוצר הראשי)
├── packages/
│   ├── db/                  # Prisma schema & migrations
│   ├── auth/                # NextAuth config
│   ├── ui/                  # רכיבי UI משותפים
│   └── config/              # הגדרות משותפות (ESLint, TS, Tailwind)
├── docker-compose.dev.yml
├── .env.example
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 11. צעדים הבאים מומלצים

1. **קרא את ארכיטקטורת הנתונים** — `packages/db/prisma/schema.prisma`
2. **הכר את זרימת האימות** — `packages/auth/src/index.ts`
3. **הרץ את סט הבדיקות המלא** — `pnpm test:ci` (כולל e2e עם Playwright)
4. **פתח Issue ראשון** — תייג `good first issue` במאגר

---

> **עדכון אחרון**: 2026-10-22  
> **גרסה**: 1.0.0  
> **מתוחזק על ידי**: צוות פלטפורמה SAOS
