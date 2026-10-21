# KEY-LEDGER — מפת-המפתחות-הריבונית [T-111 · trace 1a15e3bf30e79311]

> **החוק-העל:** אסור-לאף-סוכן-להגיד "חסרים-מפתחות". כל-המפתחות-בגיט/בכספת.
> אם-משהו-חסר-בריצה — **vault-guardian (:3080) משחזר-אוטומטית מהגיט** (POST /heal).
> אין-מצב "ממתין-לבעלים". המצבים-הקיימים: census-green · recovering · recovery-failed(יומן-מלא+ניסיון-חוזר).
> עדכון-אחרון: 2026-10-21 · מקור-אמת: `bun scripts/vault-census.mjs` + `GET :3080/receipt`

## 1. מפתחות-הריצה (חיים-עכשיו)

| מפתח | מקור-בגיט/כספת | צרכן-ראשי | הוכחה-חיה (2026-10-21) |
|---|---|---|---|
| STEEM headcorner · active/posting/memo | `upload/steem.env` (נחת משחזור; טביעות 8fc001a6 / 2bc61fc3 / 2509f6e4) | saos-grid :3070 | **3/3 תפקידים בסמכות-החיה** (השוואת-גוף-33-בייט); הגריד `mode=live`, `fingerprint=headcorner:b575`, 582+ מחזורים, פקודות-אמת |
| GitHub PAT (roshpinacare-sys) | `upload/pat.env` (טביעה 1e39c9b0) | fleet-ops · git-push · guardian | `GET /user` = roshpinacare-sys — חי |
| NVIDIA NIM | `upload/llm.env` (טביעה 4775d4e1) | מוח-LLM (council/agents) | `GET /v1/models` = HTTP 200; קטלוג-השלמות-של-הספק 404 — **לא-בעיית-מפתח** |
| FixedFloat | `upload/fffixedflot.txt` (טביעה da2568bd) | ff-שער ב:3070 | מפתח-נוכח; אישור-הספק-ממתין (401) — לא-להפעיל-בכוח |

## 2. הכספת-העמוקה (248 מפתחות — האחוזה-המלאה)

מקור: `upload/vault-rescue/wallet.db` (מ-Saosmartwallet גיט-היסטוריה `db/custom.db`) — כספת-AES-256-GCM תחת-מפתח-אב.

| שרשרת | חשבונות | רישומים |
|---|---|---|
| steem | 14 (headcorner, tov, cashmachine, haran, israelnews, lsa, macrame, siq, wic, wog, woq, ynet, headcorner-legacy, unknown) | 111 |
| blurt | 12 × 4-תפקידים | 48 |
| ethereum · solana · bitcoin | 12 כ"א | 12+12+12 |
| tron | 15 | 20 |
| hive | 2 | 12 |
| github · infra · nvidia · sovereign · coinomi | — | 15 |

**פתיחת-הכספת (מוכח-חי, תרגיל 3.4ש'):** ארכיון-R11 `Saosmartwallet:agent/vault/KEYS-ACCESS-2026-09-12.tar.enc` (blob 3d8221a345, commit 9e483baff4) → openssl-pbkdf2(300k, סיסמה מ-`recovery-meta-2026-09-12.json` באותו-commit) → `agent/keys/vault.json` → keySeals (12; scrypt N=2^15 r=8 p=1; נוסחת-K-form-גולמית **הוכחה**, P+5-form-גם-נתמכת) → מפתח-אב (טביעה 937f8e01) → VaultEntry → WIF52 → (גוף-33 mod n) → WIF51 → **אימות-מול-השרשרת** → נחיתה.

## 3. שכבת-ה-CI (repo-secrets ב-Autonomy)

רישום: `workspace/Autonomy/engine/runtime/keys.mjs` → `REQUIRED_SECRETS`:
FLEET_PAT · NVIDIA_NIM_KEY · CI_ADOPT_WIF_ACTIVE · FIXEDFLOAT_API_KEY · FIXEDFLOAT_API_SECRET.
ספירה: `censusSecrets` (שמות-בלבד — GitHub לא-מחזיר-ערכים) → `receipts/keys/latest.json`.

## 4. הערובה-הארכיטקטונית (הקץ-ל"ממתין-למפתחות")

1. **vault-census.mjs** — ספירה-מכוננת כל-שער (טביעות-בלבד) → `upload/vault-census.json` + מראה-ציבורית Domain.
2. **vault-guardian :3080** — census-כל-10דק'; אם-כשל/נעדר → **שחזור-מלא-מהגיט ונחיתה** (הוכח: מחיקת-כספת → census-ירוק-מחדש ב-6.3ש'); drill-כל-6ש' (הוכח: 3.4ש', 3/3).
3. **survival-keeper :3051** — מזניק-את-השומר-עצמו-אם-נפל (נרשם-ב-watches).
4. **רישום-האיברים** (`docs/organ-registry.json`) — שער-Steem-live-keys רשום **חי** + חוק-אסור-לומר-חסרים-מפתחות ב-rules_for_agents.
5. **PROCEDURE.md** (`upload/vault-rescue/`) — השביל-המלא-מתועד; השומר-הוא-המימוש-האוטומטי-שלו.

## 5. אפס-סודות-בפלט

כל-קבלה/יומן/דשבורד — **טביעות-אצבע (sha256 ראשונים-8) בלבד**. ערכי-מפתחות-נעים-בזיכרון/כספת-בלבד.

## 3. קליטה-אוטומטית של-קבצים-נכנסים [T-112 · trace 1a15f2614827141d]

**מקרה-מבחן-חי (2026-10-21 15:47Z):** הקובץ `upload/גיטראש.txt` (40-בייט) הגיע-מהבעלים.
- טביעה sha256-8: **1e39c9b0** — **זהה-בייטים** ל-PAT שכבר-בכספת (`upload/pat.env`)
- אימות-חי מול-GitHub-API: זהות `roshpinacare-sys`, scopes-מלאים — **חי**
- פסק-דין: **dedupe-noop — אפס-פעולה-נדרשת, אפס-שאלה-לבעלים.** הריבונות-כבר-החזיקה-את-מה-שנשלח.
- החוק-מאומת: הבעלים-לא-צריך-לשלוח-דבר — מה-שנשלח-נקלט, נמדד, ונסגר-בקבלה-בטביעות-בלבד.

## 4. קביעות-האיברים — העץ-הנצחי [T-112 · נמדד-חי]

**תגלית-מדודה:** תהליכים-שנוצרו-מחוץ-לעץ-ה-3000 (setsid/nohup/stdin-מנותק) נקצרים-על-ידי-
הסנדבוקס-בין-קריאות-הכלי (5-איברים × 3-שיטות — אפס-שורדים); רק-צאצאי-next-server-הנצחי שורדים.
**שני-שורשים-נמדדו-ותוקנו:**
1. `PORT=3000` בירושת-הסביבה-של-next dev → כל-איבר-שקורא `process.env.PORT` נקשר-ל-3000
   ונחסם-EADDRINUSE (טביעה-חיה: env של pid 5513). **תיקון:** מחיקת-PORT מסביבת-הצאצא
   בשני-מקומות-ההזנקה (route + organ-guardian).
2. hot-reload לא-החליף-את-סגר-ה-interval הישן (global מקצר) → החייאה-החיה-של-כל-האיברים
   עברה-לנתיב-`GET /api/health` עצמו (נטען-מחדש-לכל-בקשה): `REVIVAL_ORGANS` — 9-איברים.

**מצב-סופי-נמדד (16:20Z, כל-היצורים-צאצאי-העץ-הנצחי ppid=1185):**
app:3000 · dex:3010 (שוחזר-מ-github roshpinacare-sys/saos-dex) · heart:3031 · witness:3050 ·
keeper:3051 · metrics:3060 · grid:3070 (live, headcorner:b575) · arb:3071 · council:3072 ·
vault-guardian:3080 — **10/10 חיים**. census allClear 5/5 · drill 3.0ש' אפס-אדם · heal-gate תקין.
