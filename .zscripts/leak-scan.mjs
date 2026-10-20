#!/usr/bin/env node
/**
 * leak-scan.mjs — חסם-הדחיפה (T-41 · Sandbox · hardening-2026-10-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 * **חוזה-הסריקה (מדויק):** הסריקה שומרת-על-מה-שהקומיט **מכניס** — לא-על-מה-שכבר-בהיסטוריה.
 *   · --staged → **שורות-שנוספו** ב-diff-המוצב (`git diff --cached -U0` לכל-קובץ)
 *     + **תוכן-מלא של קבצים-untracked** (הקומיט-הראשון). תוכן-שכבר-נדחף-מתועד-פעם-אחת
 *     ואינו-נשפט-שוב — חוזר-עליו היה מקפיא-את-עורק-הדחיפה-לנצח (רפואה-2026-10-20:
 *     gitPushes=0 עקב-הזכרות-מטא-דאטה-כנה-שכבר-בהיסטוריה). דליפה-בהיסטוריה נפתרת
 *     ברוטציה/ניקוי (שער-בעלים) — לא-בהקפאת-כל-הדחיפות.
 *   · מצב-קבצים-מפורש (בלי --staged) → סריקת-תוכן-מלא (כמו-תמיד).
 *   · --passfile → זרע-הסיסמה נבדק מול **תוכן-מלא** של כל-קובץ-מטרה (הכי-קטלני — אין-דלתא).
 *   · בינארי-מוצב (אין-שורות-diff) → תוכן-מלא-של-הקובץ-החדש.
 * **Fail-closed בכל-נתיב**: שגיאת-git/קריאה = יציאה-1, לא-דילוג. רישום-פטנט-לא-תקין = יציאה-1.
 * דפוסי-איסור: נתיבי-מכונה-אישיים · WIF/base58 · טוקני-GitHub · URL-עם-אישור ·
 * x-access-token · הזכרות-שמות-קבצי-מפתח (key-pointer) · --passfile: זרע-בייטי.
 * חריג-מתועד (Task 69-b): db/custom.db = היסטוריית-האמת (append-only) — workpath מדולג
 * עבורה-בלבד; כל-דפוסי-הטוקנים/מפתחות/כתובות נאכפים-עליה במלואם.
 * **מרשם-פטורים** (.zscripts/leak-waivers.json): רק-kind=key-pointer (הזכרות-שם-קובץ =
 * מטא-דאטה, לא-סוד) · פג-תוקף-חובה (ISO) · הסודות-האמת (טוקן/WIF/cred-URL/pass-material)
 * **מעולם-לא-ניתנים-לפטור**. המרשם-עצמו בגיט — מבוקר.
 * מדווח: סוג + קובץ + שורה — מעולם-לא-את-התוכן-המותאם. יציאה: 0=נקי · 1=אסור.
 *
 * שימוש:  node .zscripts/leak-scan.mjs --staged [--passfile <path>]
 *         node .zscripts/leak-scan.mjs [--passfile <path>] <file...>
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// T-60 · מבדק-אנטי-פורץ: שמות-קבצי-מפתח ושמות-מצביעים — בנויים-מ-base64-בלבד
// (הסריקה-עצמה-אף-פעם-לא-מכילה-את-המחרוזות-הגולמיות — אחרת-היא-תחסום-את-עצמה)
const KEY_POINTER_NAMES = [
  "a2V5cy5lbnY=", // קובץ-משבצות-הכספת
  "cmFpbHMuZW52", // קובץ-המסילות (כל-הסיומות)
  "c3NoLWtleXMudGFy", // ארכיון-מפתחות-הפריסה
  "cGF0LmVudg==", // קובץ-ההרשאה-ההיסטורי
  "ZmxlZXQtdmF1bHQ=", // שם-בית-הכספת-ההיסטורי — הכינוי-הפומבי-בלבד-מותר
].map((b) => Buffer.from(b, "base64").toString("utf8"));
const KEY_POINTER_RE = new RegExp(
  `\\b(?:${KEY_POINTER_NAMES.map((n) => n.replace(/[.]/g, "\\.")).join("|")})\\b`,
  "g",
);

const PATTERNS = [
  { kind: "workpath", re: /\/home\/[A-Za-z0-9_.-]+\//g },
  { kind: "wif-key", re: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "cred-url", re: /https?:\/\/[^\s:@/]+:[^\s@/]*@/g },
  { kind: "access-token-echo", re: /x-access-token:[A-Za-z0-9._~=-]/g },
  { kind: "key-pointer", re: KEY_POINTER_RE },
];
// פטור-מותר ל-kind=key-pointer בלבד — הסודות-האמת אינם-ניתנים-לפטור-מעולם
const WAIVABLE_KINDS = new Set(["key-pointer"]);
const WAIVERS_PATH = path.join(ROOT, ".zscripts", "leak-waivers.json");
const MAX_ACTIVE_WAIVERS = 64;

function fail(msg) {
  console.error(`[leak-scan] ✖ ${msg}`);
  process.exit(1);
}

/* ── מרשם-הפטורים — fail-closed: קובץ-לא-תקין = יציאה-1 ─────────────────────── */
function loadWaivers() {
  if (!fs.existsSync(WAIVERS_PATH)) return [];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(WAIVERS_PATH, "utf8"));
  } catch {
    fail("מרשם-הפטורים-לא-תקין (JSON) — fail-closed");
  }
  const arr = doc?.waivers;
  if (!Array.isArray(arr)) fail("מרשם-הפטורים-חסר-מערך waivers — fail-closed");
  const now = Date.now();
  const active = [];
  for (const w of arr) {
    if (!w || typeof w !== "object") fail("רשומת-פטור-לא-תקינה — fail-closed");
    if (!WAIVABLE_KINDS.has(w.kind))
      fail(`פטור-על-kind=${w.kind} אסור — רק ${[...WAIVABLE_KINDS].join(",")}`);
    if (!w.file || typeof w.line !== "number" || !w.reason || !w.until)
      fail("רשומת-פטור-חסרה-שדות (file/line/reason/until) — fail-closed");
    const untilMs = Date.parse(w.until);
    if (Number.isNaN(untilMs)) fail("פטור-עם-until-שאינו-ISO — fail-closed");
    if (untilMs > now) active.push(w);
  }
  if (active.length > MAX_ACTIVE_WAIVERS)
    fail(`יותר-מדי-פטורים-פעילים (${active.length}>${MAX_ACTIVE_WAIVERS}) — fail-closed`);
  return active;
}
const waivers = loadWaivers();
const waiverKey = (kind, file, line) => `${kind}::${file}::${line}`;
const waivedSet = new Set(waivers.map((w) => waiverKey(w.kind, w.file, w.line)));

/* ── מקורות-הסריקה — fail-closed ──────────────────────────────────────────── */
// מפה: קובץ → { lines: Map<lineNo, text> | null(=תוכן-מלא) , full: boolean }
function gitOut(cmd) {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    fail(`git-פעולה-נכשלה — fail-closed (לא-לדחוף)`);
  }
}

// פרוק-hunks של diff --cached -U0 לקובץ-בודד → מספרי-שורה-חדשים
function addedLinesOfFile(file) {
  const out = gitOut(
    `git -c core.quotepath=off diff --cached -U0 --no-color --no-ext-diff -- ${JSON.stringify(file)}`,
  ).toString("utf8");
  const added = new Map(); // lineNo → text
  let cur = null; // מספר-השורה-החדשה-הנוכחי
  for (const raw of out.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/^\s*@@\s*-\d+(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@/);
      cur = m ? parseInt(m[1], 10) : null;
      continue;
    }
    if (cur === null) continue;
    if (raw.startsWith("+")) {
      added.set(cur, raw.slice(1));
      cur += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // שורה-שנמחקה/המשך-בינארי — לא-מזיזה-את-מונה-החדשות
      continue;
    } else if (raw.length > 0) {
      cur += 1; // שורת-הקשר (לא-אמור-להופיע ב-U0) — הגנה
    }
  }
  return added;
}

function targets() {
  if (process.argv.includes("--staged")) {
    // (א) קבצים-מוצבים-שהשתנו + (ב) untracked — -z: אפס-מניפולציית-שמות
    const changed = gitOut(
      "git -c core.quotepath=off diff --cached --name-only -z",
    ).toString("utf8");
    const untracked = gitOut(
      "git -c core.quotepath=off ls-files --others --exclude-standard -z",
    ).toString("utf8");
    const changedFiles = changed.split("\0").map((s) => s.trim()).filter(Boolean);
    const untrackedFiles = untracked.split("\0").map((s) => s.trim()).filter(Boolean);
    if (changedFiles.length === 0 && untrackedFiles.length === 0) return null; // אין-דלתא — נקי
    // תוכן-בינארי-מוצב: אין-שורות-diff → ייבדק-תוכן-מלא (מזוהה להלן)
    return { changedFiles, untrackedFiles };
  }
  const argv = process.argv.slice(2);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--staged") continue;
    if (argv[i] === "--passfile") { i += 1; continue; } // דלג-על-הערך-שלו
    rest.push(argv[i]);
  }
  if (rest.length === 0) fail("אין-מטרות-סריקה — fail-closed");
  return { explicit: rest };
}

/* ── זרע-הסיסמה (מצב --passfile) — זיכרון-בלבד ────────────────────────────── */
function needleFromPassfile() {
  const i = process.argv.indexOf("--passfile");
  if (i < 0) return null;
  const p = process.argv[i + 1];
  if (!p) fail("--passfile דורש-נתיב");
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch {
    fail("קובץ-סיסמה-לא-נקרא — fail-closed (נתיב-מלא-לא-נחשף)");
  }
  const trimmed = buf.toString("utf8").replace(/[\r\n]+$/, "");
  return Buffer.from(trimmed, "utf8");
}

let hits = 0;
const hit = (kind, file, line) => {
  hits += 1;
  console.error(`[leak-scan] ✖ ${kind} · ${file}:${line} (תוכן-לא-מודפס)`);
};
const noteWaived = (kind, file, line) => {
  console.error(`[leak-scan] ◌ פטור-רשום · ${kind} · ${file}:${line} (מטא-דאטה, מבוקר)`);
};

// סריקת-אוסף-שורות (מספר→טקסט) מול-הדפוסים + הפטורים
function scanLines(kind2, file, linesMap) {
  for (const [lineNo, lineText] of linesMap) {
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      if (!re.test(lineText)) continue;
      if (waivedSet.has(waiverKey(kind, file, lineNo))) { noteWaived(kind, file, lineNo); continue; }
      hit(kind, file, lineNo);
    }
  }
}
// סריקת-תוכן-מלא (מחרוזת) — כולל החריג-המתועד ל-db-האמת
function scanFullText(t, abs, text) {
  const isTruthDb = t === "db/custom.db" || abs.endsWith("/db/custom.db");
  const activePatterns = isTruthDb ? PATTERNS.filter((p) => p.kind !== "workpath") : PATTERNS;
  const lines = text.split("\n");
  for (const { kind, re } of activePatterns) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      if (!re.test(line)) continue;
      if (waivedSet.has(waiverKey(kind, t, i + 1))) { noteWaived(kind, t, i + 1); continue; }
      hit(kind, t, i + 1);
    }
  }
}

const needle = needleFromPassfile();
const needleStr = needle ? needle.toString("utf8") : null;
const scope = targets();
if (scope !== null) {
  const deltas = scope.explicit
    ? scope.explicit.map((f) => ({ file: f, mode: "full" }))
    : [
        ...scope.changedFiles.map((f) => ({ file: f, mode: "delta" })),
        ...scope.untrackedFiles.map((f) => ({ file: f, mode: "full" })), // הקומיט-מכניס-הכל
      ];

  for (const { file: t, mode } of deltas) {
    const abs = path.isAbsolute(t) ? t : path.join(ROOT, t);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      fail(`קובץ-מטרה-לא-נקרא: ${t} — fail-closed`);
    }
    if (!buf.length) continue;

    // זרע-הסיסמה — תמיד מול-תוכן-מלא (אין-דלתא-לחומר-גלם)
    if (needle && buf.includes(needle)) {
      const lines = buf.toString("utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes(needleStr)) hit("pass-material", t, i + 1);
      });
    }

    if (mode === "delta") {
      const added = addedLinesOfFile(t);
      if (added.size === 0) {
        // אין-שורות-טקסט-מוצבות (בינארי/מצב-הרשאות) → תוכן-מלא-של-הקובץ-החדש
        scanFullText(t, abs, buf.toString("utf8"));
      } else {
        scanLines("delta", t, added);
      }
    } else {
      scanFullText(t, abs, buf.toString("utf8"));
    }
  }
}

if (hits > 0) {
  console.error(`[leak-scan] נחסם: ${hits} התאמות-חדשות — אסור-לדחוף. תקן-מקור או-רשום-פטור-מבוקר (key-pointer-בלבד).`);
  process.exit(1);
}
console.log("[leak-scan] ✔ נקי — אפס-התאמות-חדשות (דלתא-מוצבת + untracked)");
