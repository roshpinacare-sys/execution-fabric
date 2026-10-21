/**
 * recover.ts — מנוע-השחזור-האוטומטי-מהגיט [T-111 · trace 1a15e3bf30e79311]
 * ═════════════════════════════════════════════════════════════════════════════
 * החוק-העל (דברי-הבעלים, 2026-10-21): אסור-שאף-סוכן-יגיע-למצב "חושב-שחסרים-לו-מפתחות"
 * בזמן-שהכל-בגיט. המנוע-הזה-מוכיח-את-ההבטחה: מארכיון-R11 בהיסטוריית-הגיט של
 * Saosmartwallet + wallet.db — נגזר-מפתח-אב (keySeals), פוענחות-שורות-הכספת,
 * מאומת-מול-השרשרת, ונחתת-כספת-ריצה. אפס-אדם. אפס-שאלה.
 *
 * סדר-השביל (מוכח-חי בתרגיל drill 2026-10-21, VERDICT מלא 3/3 MATCH):
 *   1. PAT מ-upload/pat.env → GitHub API (blobs; commits?path= לגילוי-דינמי)
 *   2. KEYS-ACCESS-2026-09-12.tar.enc + recovery-meta-2026-09-12.json מאותו-commit
 *   3. openssl aes-256-cbc-pbkdf2(300k) → tar → agent/keys/vault.json
 *   4. wallet.db (מקומי או מהיסטוריה db/custom.db) → GateConfig.keySeals
 *   5. פתיחת-חותם: KEK=scrypt(keyString, kdfSalt, N=2^15,r=8,p=1) → GCM → master
 *      (וריאציות-נוסחה: K-form גולמי [הוכח], P+5-form, 5-form, P+K-form — GCM מכריע)
 *   6. VaultEntry(verified) → GCM → WIF52 → (גוף-33 mod n) → WIF51
 *   7. אימות-קרקע: גוף-מפתח-33 מול סמכות-החיה ב-condenser_api
 *   8. נחיתה: upload/steem.env (0600) → census → טביעות-אצבע-בלבד בכל-קבלה
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createDecipheriv, scryptSync, createHash as hash } from 'node:crypto';
import { Database } from 'bun:sqlite';

const pExecFile = promisify(execFile);
export const ROOT = join(import.meta.dir, '..', '..');
const UP = join(ROOT, 'upload');
const VAULT_ENV = join(UP, 'steem.env');
const API = 'https://api.github.com';
const REPO = 'roshpinacare-sys/Saosmartwallet';
const ARCHIVE_PATH = 'agent/vault/KEYS-ACCESS-2026-09-12.tar.enc';
const META_PATH = 'agent/vault/recovery-meta-2026-09-12.json';
const WALLET_DB_LOCAL = join(UP, 'vault-rescue', 'wallet.db');
const UA = { 'User-Agent': 'saos-vault-guardian/1', Accept: 'application/vnd.github+json' };

export const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

// ── base58 (עצמאי; אפס-תלות) ────────────────────────────────────────────────
const A58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const N58 = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const b58d = (s: string): Buffer => { let n = 0n; for (const c of s) { const i = A58.indexOf(c); if (i < 0) throw new Error('bad-b58'); n = n * 58n + BigInt(i); } let h = n.toString(16); if (h.length % 2) h = '0' + h; return Buffer.from(h, 'hex'); };
const b58e = (b: Buffer): string => { let n = BigInt('0x' + Buffer.from(b).toString('hex')); let o = ''; while (n > 0n) { o = A58[Number(n % 58n)] + o; n /= 58n; } for (const c of b) { if (c === 0) o = '1' + o; else break; } return o; };
const hexBuf = (s: string) => Buffer.from(String(s), 'hex');
const stmBody = (s: string): string => { try { return b58d(String(s).slice(3)).subarray(0, 33).toString('hex'); } catch { return String(s); } };

/** WIF52 (bitcoin-form גוף-33) → WIF51 קנוני — סמנטיקת-steem-js (signing-key.ts) */
export function wif52to51(w52: string): string {
  const dec = b58d(w52.trim());
  if (dec.length === 38 && dec[0] === 0x80 && dec[33] === 0x01) {
    const scalar = BigInt('0x' + dec.subarray(1, 34).toString('hex')) % N58;
    const payload = Buffer.concat([Buffer.from([0x80]), Buffer.from(scalar.toString(16).padStart(64, '0'), 'hex')]);
    const chk = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
    return b58e(Buffer.concat([payload, chk]));
  }
  if (dec.length === 37 && dec[0] === 0x80) return w52.trim();
  throw new Error('unexpected-wif-form len=' + dec.length);
}

// ── GitHub (PAT מהכספת-המקומית) ─────────────────────────────────────────────
function pat(): string {
  const p = join(UP, 'pat.env');
  if (!existsSync(p)) throw new Error('no-pat-env');
  const m = readFileSync(p, 'utf8').match(/[A-Za-z0-9_]{20,}/);
  if (!m) throw new Error('no-pat-token');
  return m[0];
}
async function gh(pathname: string, accept = UA.Accept): Promise<Response> {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 30_000);
  try {
    return await fetch(`${API}${pathname}`, { headers: { ...UA, Accept: accept, Authorization: `Bearer ${pat()}` }, signal: c.signal });
  } finally { clearTimeout(t); }
}

/** מגלה-את-ה-commit-העתיק-שבו-הארכיון-קיים-בעץ ומחזיר {commit, archiveBlob, metaBlob} */
export async function locateArchive(): Promise<{ commit: string; archiveBlob: string; metaBlob: string }> {
  const lr = await gh(`/repos/${REPO}/commits?path=${encodeURIComponent(ARCHIVE_PATH)}&per_page=10`);
  if (!lr.ok) throw new Error(`commits-http-${lr.status}`);
  const commits: { sha: string }[] = await lr.json();
  for (const c of commits) {
    const tr = await gh(`/repos/${REPO}/git/trees/${encodeURIComponent(c.sha + ':agent/vault')}`);
    if (!tr.ok) continue;
    const tree: { tree?: { path: string; sha: string; type: string }[] } = await tr.json();
    const arc = tree.tree?.find((t) => t.path === ARCHIVE_PATH.split('/').pop() && t.type === 'blob');
    const meta = tree.tree?.find((t) => t.path === META_PATH.split('/').pop() && t.type === 'blob');
    if (arc && meta) return { commit: c.sha, archiveBlob: arc.sha, metaBlob: meta.sha };
  }
  throw new Error('archive-blob-not-found-in-any-commit');
}

async function fetchBlobRaw(sha: string): Promise<Buffer> {
  const r = await gh(`/repos/${REPO}/git/blobs/${sha}`, 'application/vnd.github.raw');
  if (!r.ok) throw new Error(`blob-http-${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** wallet.db: מקומי-קודם; אחרת-מההיסטוריה (db/custom.db) — עצמאות-מלאה-מהגיט */
async function ensureWalletDb(work: string): Promise<string> {
  if (existsSync(WALLET_DB_LOCAL)) return WALLET_DB_LOCAL;
  const lr = await gh(`/repos/${REPO}/commits?path=db/custom.db&per_page=1`);
  const commits: { sha: string }[] = await lr.json();
  if (!commits.length) throw new Error('wallet-db-commit-not-found');
  const tr = await gh(`/repos/${REPO}/git/trees/${encodeURIComponent(commits[0].sha + ':db')}`);
  const tree: { tree?: { path: string; sha: string; type: string }[] } = await tr.json();
  const blob = tree.tree?.find((t) => t.path === 'custom.db' && t.type === 'blob');
  if (!blob) throw new Error('wallet-db-blob-not-found');
  const raw = await fetchBlobRaw(blob.sha);
  const dest = join(work, 'custom.db');
  writeFileSync(dest, raw, { mode: 0o600 });
  return dest;
}

// ── פתיחת-הכספת ─────────────────────────────────────────────────────────────
export type OpenResult = {
  ok: boolean;
  masterSource?: string;
  masterFp?: string;
  recovered: Record<string, string>; // role → WIF51 (מטרייה-בזיכרון-בלבד)
  verified: Record<string, { live: boolean; pubPrefix: string }>;
  error?: string;
  steps: string[];
};

/** פתיחת-חותם-בודד: 4 וריאציות-נוסחה; GCM מכריע */
function openSeal(seal: { chain: string; account: string; role: string; kdfSalt: string; encMaster: string; sealIv: string; sealTag: string }, wifK: string): string | null {
  let wif51 = ''; try { wif51 = wif52to51(wifK); } catch { wif51 = wifK; }
  const variants: [string, string][] = [
    ['K-form', wifK], ['P+5-form', 'P' + wif51], ['5-form', wif51], ['P+K-form', 'P' + wifK],
  ];
  for (const [label, keyString] of variants) {
    try {
      const kek = scryptSync(keyString, hexBuf(seal.kdfSalt), 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
      const d = createDecipheriv('aes-256-gcm', kek, hexBuf(seal.sealIv));
      d.setAuthTag(hexBuf(seal.sealTag));
      const masterHex = Buffer.concat([d.update(hexBuf(seal.encMaster)), d.final()]).toString('utf8');
      if (/^[0-9a-f]{64}$/i.test(masterHex)) return masterHex;
    } catch { /* וריאציה-שגויה — GCM דוחה-מיד */ }
  }
  return null;
}

/**
 * השלמת-השביל: מארכיון+wallet.db עד-מפתחות-מאומתים-מול-השרשרת.
 * accounts: לאילו-חשבונות-לשחזר (ברירת-מחדל: מ-GRID_ACCOUNTS-התבנית = headcorner)
 */
export async function openVaultAndRecover(accounts: string[]): Promise<OpenResult> {
  const steps: string[] = [];
  const res: OpenResult = { ok: false, recovered: {}, verified: {}, steps };
  const work = mkdtempSync(join(tmpdir(), 'vg-'));
  try {
    // 1–3: ארכיון מהגיט
    const loc = await locateArchive();
    steps.push(`archive-located ${loc.commit.slice(0, 10)} blob=${loc.archiveBlob.slice(0, 10)}`);
    const [enc, metaRaw] = await Promise.all([fetchBlobRaw(loc.archiveBlob), fetchBlobRaw(loc.metaBlob)]);
    const encPath = join(work, 'keys.tar.enc'); writeFileSync(encPath, enc, { mode: 0o600 });
    const meta = JSON.parse(metaRaw.toString('utf8'));
    const pass = meta.keys_access_2026_09_12;
    if (!pass) throw new Error('no-pass-in-recovery-meta');
    const passPath = join(work, '.p'); writeFileSync(passPath, pass + '\n', { mode: 0o600 });
    await pExecFile('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '300000', '-in', encPath, '-out', join(work, 'keys.tar.gz'), '-pass', 'file:' + passPath]);
    rmSync(passPath);
    await pExecFile('tar', ['xzf', join(work, 'keys.tar.gz'), '-C', work]);
    const vaultJsonPath = join(work, 'agent/keys/vault.json');
    if (!existsSync(vaultJsonPath)) throw new Error('vault-json-missing-after-extract');
    steps.push('archive-decrypted-and-extracted');

    // 4: wallet.db
    const dbPath = await ensureWalletDb(work);
    const db = new Database(dbPath, { readonly: true });
    const seals: { chain: string; account: string; role: string; kdfSalt: string; encMaster: string; sealIv: string; sealTag: string }[] =
      JSON.parse(db.query("SELECT keySeals FROM GateConfig WHERE id='gate'").get().keySeals);
    const vault = JSON.parse(readFileSync(vaultJsonPath, 'utf8'));
    const byUser = new Map<string, { keys: Record<string, Record<string, { wif: string }>> }>(vault.accounts.map((a: never) => [(a as { username: string }).username, a]));

    // 5: פתיחת-חותם (owner קודם — ההוכחה; אחר-כך כל-חותם-שנפתח)
    let masterHex: string | null = null; let masterSrc = '';
    const order = [...seals].sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0));
    for (const seal of order) {
      const wifK = byUser.get(seal.account)?.keys?.[seal.chain]?.[seal.role]?.wif;
      if (!wifK) continue;
      masterHex = openSeal(seal, wifK);
      if (masterHex) { masterSrc = `${seal.chain}/${seal.account}/${seal.role}`; break; }
    }
    if (!masterHex) { res.error = 'no-seal-opened'; steps.push('seal-open: FAIL'); return res; }
    res.masterSource = masterSrc; res.masterFp = fp(masterHex);
    steps.push(`seal-opened ${masterSrc}`);
    const master = Buffer.from(masterHex, 'hex');

    // 6: פענוח-שורות
    for (const acc of accounts) {
      const rows = db.query("SELECT role, encPriv, privIv, privTag FROM VaultEntry WHERE chain='steem' AND account=? AND status='verified'").all(acc) as { role: string; encPriv: string; privIv: string; privTag: string }[];
      for (const r of rows) {
        if (!['active', 'posting', 'memo'].includes(r.role) || res.recovered[r.role]) continue;
        try {
          const d = createDecipheriv('aes-256-gcm', master, hexBuf(r.privIv));
          d.setAuthTag(hexBuf(r.privTag));
          const w52 = Buffer.concat([d.update(hexBuf(r.encPriv)), d.final()]).toString('utf8').trim();
          res.recovered[r.role] = wif52to51(w52);
        } catch { /* שורה-שאינה-נפתחת-תחת-האב-הזה — מדלגים-בכנות */ }
      }
    }
    steps.push(`entries-decrypted ${Object.keys(res.recovered).join('+') || 'none'}`);
    db.close();

    // 7: אימות-קרקע
    for (const acc of accounts) {
      const r = await fetch('https://api.steemit.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'condenser_api.get_accounts', params: [[acc]], id: 1 }), signal: AbortSignal.timeout(12_000) });
      const a = (await r.json()).result?.[0];
      if (!a) { steps.push(`chain-check ${acc}: not-found`); continue; }
      for (const [role, wif] of Object.entries(res.recovered)) {
        const pubStr = await wifToPub(wif);
        const pub = stmBody(pubStr);
        const live = role === 'memo' ? stmBody(a.memo_key) === pub : a[role]?.key_auths?.some((k: [string, number]) => stmBody(k[0]) === pub);
        res.verified[role] = { live: !!live, pubPrefix: pubStr.slice(0, 12) };
      }
    }
    steps.push(`chain-verified ${Object.entries(res.verified).filter(([, v]) => v.live).map(([k]) => k).join('+') || 'none'}`);
    res.ok = Object.keys(res.recovered).includes('active') && res.verified['active']?.live === true;
    return res;
  } catch (e) {
    res.error = String((e as Error)?.message || e).slice(0, 120);
    return res;
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ניקוי-בטוח */ }
  }
}

/** WIF51 → STM pub (גוף-33 mod n נתמך; שימוש-ב-helper-הקיים-של-saos-grid; WIF ב-stdin בלבד) */
export async function wifToPub(wif: string): Promise<string> {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('bun', ['scripts/steem-pub-derive.cjs'], { input: wif + '\n', cwd: join(ROOT, 'mini-services/saos-grid'), encoding: 'utf8' });
  return String(out).trim();
}

// ── נחיתה: upload/steem.env ─────────────────────────────────────────────────
export async function landSteemEnv(recovered: Record<string, string>, accounts: string[]): Promise<{ ok: boolean; landed: string[] }> {
  const landed: string[] = [];
  const lines = [
    '# כספת-צי-הגריד — נחתמה-אוטומטית ע"י vault-guardian (T-111) משחזור-מלא-מהגיט',
    '# מקור: Saosmartwallet R11-archive + wallet.db keySeals; אימות-קרקע: condenser_api',
    `# at: ${new Date().toISOString()}`,
  ];
  for (const acc of accounts) {
    const P = acc.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    for (const role of ['active', 'posting', 'memo']) {
      const w = recovered[role];
      if (!w) continue;
      lines.push(`${P}_${role.toUpperCase()}_WIF=${w}`);
      landed.push(`${P}_${role.toUpperCase()}_WIF`);
    }
    if (!lines.some((l) => l.startsWith('GRID_ACCOUNTS='))) lines.splice(3, 0, `GRID_ACCOUNTS=${accounts.join(',')}`);
  }
  mkdirSync(UP, { recursive: true });
  writeFileSync(VAULT_ENV, lines.join('\n') + '\n');
  try { (await import('node:fs')).chmodSync(VAULT_ENV, 0o600); } catch { /* פרטיות-טובה-מנסה */ }
  return { ok: landed.length > 0, landed };
}

/** ריצת-census (הסקריפט-הקנוני) — מחזיר-את-הקבלה-המפורסמת */
export async function runCensus(): Promise<{ allClear: boolean; steemOk: boolean; receipt: unknown } | { error: string }> {
  try {
    const { stdout } = await pExecFile('bun', ['scripts/vault-census.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
    const start = stdout.indexOf('{');
    const receipt = JSON.parse(stdout.slice(start));
    const steem = (receipt.verdicts ?? []).find((x: { area: string }) => x.area === 'steem');
    return { allClear: !!receipt.allClear, steemOk: !!steem?.ok, receipt };
  } catch (e) {
    return { error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

/** התרגיל-המלא-בלי-נחיתה (מוכיח-שהשביל-חי — קבלה-בטביעות-בלבד) */
export async function drill(): Promise<unknown> {
  const t0 = Date.now();
  const accounts = gridAccounts();
  const r = await openVaultAndRecover(accounts);
  return {
    schema: 'vault-guardian.drill/1',
    at: new Date().toISOString(),
    ms: Date.now() - t0,
    ok: r.ok,
    masterSource: r.masterSource,
    masterFp: r.masterFp,
    roles: Object.fromEntries(Object.keys(r.recovered).map((role) => [role, { verified: r.verified[role]?.live ?? false, fingerprint: fp(r.recovered[role]) }])),
    error: r.error ?? null,
    steps: r.steps,
  };
}

function gridAccounts(): string[] {
  const tpl = join(UP, 'steem.env.template');
  try {
    const m = readFileSync(tpl, 'utf8').match(/^GRID_ACCOUNTS=(.+)$/m);
    if (m) return m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  } catch { /* נופל-לברירת-המחדל */ }
  return ['headcorner'];
}

/** הריפוי-המלא: census → אם-נכשל/נעדר → שחזור-מהגיט → נחיתה → census-חוזר */
export async function heal(): Promise<unknown> {
  const t0 = Date.now();
  const steps: string[] = [];
  const before = await runCensus();
  const need = 'error' in before ? true : !before.steemOk;
  let landed: string[] = [];
  let recovery: unknown = null;
  if (need) {
    steps.push('census-failed-or-missing — מריץ-שחזור-אוטומטי');
    const accounts = gridAccounts();
    const r = await openVaultAndRecover(accounts);
    recovery = { ok: r.ok, masterSource: r.masterSource, masterFp: r.masterFp, roles: Object.keys(r.recovered), verified: r.verified, error: r.error ?? null };
    steps.push(...r.steps);
    if (r.ok) {
      const land = await landSteemEnv(r.recovered, accounts);
      landed = land.landed;
      steps.push(`landed ${landed.length}`);
    }
  } else {
    steps.push('census-green — אין-צורך-בשחזור');
  }
  const after = await runCensus();
  return {
    schema: 'vault-guardian.heal/1',
    at: new Date().toISOString(),
    ms: Date.now() - t0,
    needed: need,
    landed,
    recovery,
    after: 'error' in after ? { error: after.error } : { allClear: after.allClear, steemOk: after.steemOk },
    steps,
  };
}
