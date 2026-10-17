#!/usr/bin/env node
/**
 * leak-scan.mjs — חסם-הדחיפה (T-41 · Sandbox · post-review hardening)
 * ═════════════════════════════════════════════════════════════════════════════
 * **Fail-closed בכל-נתיב** (סקירה-בטיחות-H1/H2): שגיאת-git/קריאה = יציאה-1, לא-דילוג.
 *   · --staged סורק staged **וגם untracked** (כיסוי-הקומיט-הראשון)
 *   · -z + core.quotepath=off — שמות-קבצים-בעברית לא-מודלים
 * דפוסי-איסור: נתיבי-מכונה-אישיים · WIF/base58 · טוקני-GitHub · URL-עם-אישור ·
 * x-access-token · **ומצב --passfile**: זרע-בייטי-הסיסמה (זיכרון-בלבד) מול-כל-קובץ.
 * מדווח: סוג + קובץ + שורה — מעולם-לא-את-התוכן-המותאם. יציאה: 0=נקי · 1=אסור.
 *
 * שימוש:  node engine/leak-scan.mjs --staged [--passfile <path>]
 *         node engine/leak-scan.mjs [--passfile <path>] <file...>
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

function fail(msg) {
  console.error(`[leak-scan] ✖ ${msg}`);
  process.exit(1);
}

/* ── מקורות-הסריקה — fail-closed ──────────────────────────────────────────── */
function targets() {
  if (process.argv.includes("--staged")) {
    try {
      // staged + untracked (הקומיט-הראשון: כל-העץ-untracked!) · -z: אפס-מניפולציית-שמות
      const out = execSync(
        "git -c core.quotepath=off ls-files --cached --others --exclude-standard -z",
        { cwd: ROOT, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] },
      );
      return out.toString("utf8").split("\0").map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      fail("git-רישום-קבצים-נכשל — fail-closed (לא-לדחוף)");
    }
  }
  const argv = process.argv.slice(2);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--staged") continue;
    if (argv[i] === "--passfile") { i += 1; continue; } // דלג-על-הערך-שלו
    rest.push(argv[i]);
  }
  if (rest.length === 0) fail("אין-מטרות-סריקה — fail-closed");
  return rest;
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

const needle = needleFromPassfile();
for (const t of targets()) {
  const abs = path.isAbsolute(t) ? t : path.join(ROOT, t);
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    fail(`קובץ-מטרה-לא-נקרא: ${t} — fail-closed`);
  }
  if (!buf.length) continue;

  // 1) זרע-הסיסמה — השוואת-בייטים ואז-איתור-שורה (בלי-הדפסת-תוכן)
  if (needle && buf.includes(needle)) {
    const lines = buf.toString("utf8").split("\n");
    const needleStr = needle.toString("utf8");
    lines.forEach((line, i) => {
      if (line.includes(needleStr)) hit("pass-material", t, i + 1);
    });
  }

  // 2) דפוסי-איסור
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  for (const { kind, re } of PATTERNS) {
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hit(kind, t, i + 1);
    });
  }
}

if (hits > 0) {
  console.error(`[leak-scan] נחסם: ${hits} התאמות — אסור-לדחוף. תקן-מקור, לא-רק-את-הסריקה.`);
  process.exit(1);
}
console.log("[leak-scan] ✔ נקי — אפס-התאמות");
