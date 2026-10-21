#!/usr/bin/env bun
/**
 * vault-census.mjs — ספירת-הכספות המכונה [T-111 · trace 1a15daf14e62f059]
 * ═══════════════════════════════════════════════════════════════════════
 * החוק: אסור לאף-סוכן להגיד "חסרים-מפתחות" לפני-שהריץ את-הספירה-הזאת.
 * הספירה מודדת את-כל-מקורות-המפתחות-החיים ומפרסמת קבלה-ממוסגרת:
 *   · upload/vault-census.json          — מלא (טביעות-אצבע בלבד, 0600)
 *   · workspace/Domain/dex/vault-census.json — מראה-ציבורית (בוליאנים-בלבד, אפס-סודות)
 *
 * מקורות-האמת (הכל בגיט/בכספת — אין-תלות בבעלים):
 *   1. upload/steem.env                  ← דור-r16 משוחזר (wallet.db ← keySeal hive/owner)
 *   2. upload/pat.env                    ← PAT הריבונות
 *   3. upload/llm.env                    ← NVIDIA NIM (אימות-חי; קטלוג-העל אפוי)
 *   4. upload/fffixedflot.txt / ff.env   ← שער-FixedFloat (ממתין-לספק, לא-למפתחות)
 *   5. upload/vault-rescue/              ← עד-השחזור (wallet.db + PROCEDURE.md)
 *
 * שימוש: bun scripts/vault-census.mjs   (מהיר, ~3ש'; אפס-הדפסת-סודות)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';

const ROOT = join(import.meta.dir, '..');
const UP = join(ROOT, 'upload');
const now = new Date().toISOString();
const fp = (s) => (s ? createHash('sha256').update(s).digest('hex').slice(0, 8) : null);

const verdicts = [];
const v = (area, ok, detail) => { verdicts.push({ area, ok, detail }); return { area, ok, detail }; };

// ── 1. STEEM: הכספת-החיה — אימות-מול-השרשרת בפועל ──────────────────────────
async function censusSteem() {
  const path = join(UP, 'steem.env');
  if (!existsSync(path)) return v('steem', false, 'upload/steem.env נעדר — הרץ את PROCEDURE.md (upload/vault-rescue)');
  const raw = readFileSync(path, 'utf8');
  const env = Object.fromEntries(raw.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const accounts = (env.GRID_ACCOUNTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const roles = [];
  for (const a of accounts) {
    const key = env[`${a.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_ACTIVE_WIF`];
    if (!key || key.length < 40) { v('steem', false, `${a}: אין-WIF-active בכספת`); continue; }
    // אימות-שרשרת: נגזרת-פומבית מול סמכות-החיה (סמנטיקת-steem-js: גוף-33 mod n)
    try {
      const pub = await deriveSteemPub(key);
      const res = await fetch('https://api.steemit.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[a]], id: 1 }), signal: AbortSignal.timeout(12_000) });
      const acc = (await res.json()).result?.[0];
      const live = !!acc && acc.active.key_auths.some((k) => k[0] === pub);
      roles.push({ account: a, fingerprint: fp(key), pubPrefix: pub.slice(0, 12), liveAuthority: live });
      v('steem', live, live ? `${a}: מפתח-active חי-מאומת-מול-השרשרת (${pub.slice(0, 12)}…)` : `${a}: המפתח-בכספת אינו בסמכות-החיה — הרץ-שחזור`);
    } catch (e) { v('steem', false, `${a}: אימות-נכשל (${String(e).slice(0, 40)})`); }
  }
  return { roles };
}

// steem pubkey מ-WIF — תומך-ב-5-form הקנוני וב-52-char bitcoin-form (גוף-33 mod n)
const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function b58d(s) { let n = 0n; for (const c of s) { const i = A58.indexOf(c); if (i < 0) throw new Error('b58'); n = n * 58n + BigInt(i); } let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); }
async function deriveSteemPub(wif) {
  const { execSync } = await import('node:child_process');
  const script = `
    const { secp256k1 } = require('@noble/curves/secp256k1.js');
    const { sha256 } = require('@noble/hashes/sha2.js');
    const { ripemd160 } = require('@noble/hashes/ripemd160.js');
    const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const N = ${SECP_N}n;
    function b58d(s){let n=0n;for(const c of s){n=n*58n+BigInt(A58.indexOf(c));}let h=n.toString(16);if(h.length%2)h='0'+h;return Buffer.from(h,'hex');}
    function b58e(b){let n=BigInt('0x'+Buffer.from(b).toString('hex'));let o='';while(n>0n){o=A58[Number(n%58n)]+o;n/=58n;}for(const c of b){if(c===0)o='1'+o;else break;}return o;}
    const raw = b58d(${JSON.stringify(wif)});
    let scalar;
    if (raw.length === 38 && raw[0] === 0x80 && raw[33] === 0x01) scalar = Buffer.from((BigInt('0x'+raw.subarray(1,34).toString('hex')) % N).toString(16).padStart(64,'0'),'hex');
    else scalar = raw.subarray(1,33);
    const c33 = secp256k1.getPublicKey(scalar, true);
    const chk = ripemd160(sha256(c33)).slice(0,4);
    console.log('STM' + b58e(Buffer.concat([c33, chk])));
  `;
  return execSync(`cd ${join(ROOT, 'mini-services/saos-grid')} && bun -e ${JSON.stringify(script)}`, { encoding: 'utf8' }).trim();
}

// ── 2. GITHUB PAT ────────────────────────────────────────────────────────────
async function censusGithub() {
  const path = join(UP, 'pat.env');
  if (!existsSync(path)) return v('github', false, 'upload/pat.env נעדר');
  const tok = (readFileSync(path, 'utf8').match(/[A-Za-z0-9_]{20,}/) || [])[0];
  if (!tok) return v('github', false, 'pat.env בלי-טוקן');
  try {
    const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'sovereign-census' }, signal: AbortSignal.timeout(10_000) });
    const ok = r.ok;
    v('github', ok, ok ? `PAT חי (${(await r.json()).login}) טביעה ${fp(tok)}` : `PAT נדחה HTTP ${r.status}`);
    return { fingerprint: fp(tok) };
  } catch (e) { return v('github', false, `רשת: ${String(e).slice(0, 40)}`); }
}

// ── 3. NVIDIA NIM ────────────────────────────────────────────────────────────
async function censusNvidia() {
  const path = join(UP, 'llm.env');
  if (!existsSync(path)) return v('nvidia', false, 'upload/llm.env נעדר');
  const key = (readFileSync(path, 'utf8').match(/NVIDIA_API_KEY=([^\s]+)/) || [])[1];
  if (!key) return v('nvidia', false, 'llm.env בלי-NVIDIA_API_KEY');
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    // 200 = אימות-חי (הקטלוג-העליון עשוי-להיות אפוי — זה-כשל-ספק, לא-כשל-מפתח)
    v('nvidia', r.ok, r.ok ? 'אימות-חי-תקף (HTTP 200); קטלוג-השלמות של-הספק עשוי-להיות 404 — לא-בעיית-מפתח' : `HTTP ${r.status}`);
    return { fingerprint: fp(key) };
  } catch (e) { return v('nvidia', false, `רשת: ${String(e).slice(0, 40)}`); }
}

// ── 4. FIXEDFLOAT (מפתח-קיים; אישור-הספק בנפרד) ────────────────────────────
function censusFF() {
  const ffEnv = join(UP, 'ff.env');
  const txt = join(UP, 'fffixedflot.txt');
  let key = null, source = null;
  if (existsSync(ffEnv)) { const m = readFileSync(ffEnv, 'utf8').match(/^KEY=(.+)$/m); if (m) { key = m[1].trim(); source = 'ff.env'; } }
  if (!key && existsSync(txt)) {
    const lines = readFileSync(txt, 'utf8').split('\n').map((l) => l.trim());
    const i = lines.findIndex((l) => l.toLowerCase() === 'api key' || l.toLowerCase() === 'api-key');
    const cand = i >= 0 ? lines[i + 1] : lines.find((l) => l.length >= 30 && /^[A-Za-z0-9]+$/.test(l));
    if (cand) { key = cand; source = 'fffixedflot.txt'; }
  }
  return v('fixedfloat', !!key, key ? `מפתח-נוכח (${source}) טביעה ${fp(key)}; שער-הספק מדווח בנפרד` : 'אין-מפתח בכספת');
}

// ── 5. עד-השחזור ─────────────────────────────────────────────────────────────
function censusRecovery() {
  const dir = join(UP, 'vault-rescue');
  const dbOk = existsSync(join(dir, 'wallet.db'));
  const procOk = existsSync(join(dir, 'PROCEDURE.md'));
  return v('recovery-path', dbOk && procOk, dbOk && procOk ? 'wallet.db + PROCEDURE.md קיימים — שחזור-דור-מלא אפשרי בלי-בעלים' : 'חסר-רכיב-שחזור');
}

const all = { steem: null, github: null, nvidia: null };
all.steem = await censusSteem();
all.github = await censusGithub();
all.nvidia = await censusNvidia();
censusFF();
censusRecovery();

const liveCount = verdicts.filter((x) => x.ok).length;
const summary = { at: now, allClear: liveCount === verdicts.length, live: liveCount, total: verdicts.length, verdicts, detail: all };

mkdirSync(UP, { recursive: true });
writeFileSync(join(UP, 'vault-census.json'), JSON.stringify(summary, null, 1), { mode: 0o600 });

// מראה-ציבורית: בוליאנים-בלבד — אפס-טביעות, אפס-ערכים
const pub = { schema: 'vault-census/1', at: now, allClear: summary.allClear, gates: verdicts.map((x) => ({ area: x.area, ok: x.ok })) };
try {
  const dom = join(ROOT, 'workspace/Domain/dex');
  if (existsSync(dom)) writeFileSync(join(dom, 'vault-census.json'), JSON.stringify(pub, null, 1));
} catch { /* מראה-ציבורית נופלת בשקט — הקבלה-המקומית היא-המכוננת */ }

console.log(JSON.stringify(summary, null, 1));
if (!summary.allClear) process.exit(1);
