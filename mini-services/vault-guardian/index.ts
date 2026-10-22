/**
 * vault-guardian — שומר-הכספת :3060 [T-111 · trace 1a15e3bf30e79311]
 * ═════════════════════════════════════════════════════════════════════════════
 * החוק (דברי-הבעלים): "לא-נגיע-למצב-שסוכן-חושב-שחסר-לו-מפתחות-בזמן-שהכל-בגיט".
 * מה-השומר-עושה-בכל-מחזור:
 *   · ריצת-census-מלאה (steem מול-השרשרת · PAT · NVIDIA · FixedFloat · שביל-שחזור)
 *   · אם-הכספת-נעדרת/נכשלת → שחזור-אוטומטי-מהגיט (ארכיון-R11 → keySeals → אב →
 *     פענוח → אימות-קרקע → נחיתה upload/steem.env) — אפס-אדם, אפס-שאלה
 *   · תרגיל-שחזור (drill) כל-6ש' — הוכחה-שוטפת-שהשביל-חי, קבלה-בטביעות-אצבע-בלבד
 *   · מראה-ציבורית: בוליאנים-בלבד ל-workspace/Domain/dex (אפס-סודות, אפס-טביעות)
 * כנות: מצבי-השומר = census-green | recovering | recovery-failed(עם-יומן-מלא+ניסיון-חוזר).
 * אין-מצב "ממתין-למפתחות" — הוא-לא-קיים-בארכיטקטורה-הזאת.
 */
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { drill, heal, runCensus, ROOT } from './recover';
import { organAuth } from '../organ-auth';

const PORT = Number(process.env.PORT ?? 3080);
const CENSUS_MS = Number(process.env.CENSUS_MS ?? 10 * 60_000); // כל-10 דק'
const DRILL_MS = Number(process.env.DRILL_MS ?? 6 * 3600_000); // כל-6 שעות
const RECEIPT = join(ROOT, 'upload', 'vault-guardian.json');
const LOG = join(ROOT, 'upload', 'vault-guardian-log.jsonl');
const startedAt = new Date().toISOString();
const bootMs = Date.now();

type GuardState = {
  cycles: number;
  lastCensus: { at: string; allClear: boolean; steemOk: boolean } | null;
  lastHeal: { at: string; needed: boolean; afterAllClear: boolean | null } | null;
  lastDrill: { at: string; ok: boolean } | null;
  running: boolean;
  lastError: string | null;
};
const state: GuardState = { cycles: 0, lastCensus: null, lastHeal: null, lastDrill: null, running: false, lastError: null };

function publishReceipt(extra: Record<string, unknown> = {}): void {
  const receipt = {
    schema: 'vault-guardian/1',
    at: new Date().toISOString(),
    law: 'no-agent-ever-reports-missing-keys — keys regenerate from git automatically',
    state: {
      cycles: state.cycles,
      lastCensus: state.lastCensus,
      lastHeal: state.lastHeal,
      lastDrill: state.lastDrill,
      lastError: state.lastError,
    },
    ...extra,
  };
  try {
    mkdirSync(join(ROOT, 'upload'), { recursive: true });
    writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1) + '\n', { mode: 0o600 });
    const line = JSON.stringify({ at: receipt.at, census: state.lastCensus, heal: state.lastHeal, drill: state.lastDrill }) + '\n';
    writeFileSync(LOG, line, { flag: 'a' });
    // מראה-ציבורית — בוליאנים-בלבד
    const dom = join(ROOT, 'workspace/Domain/dex');
    if (existsSync(dom)) {
      writeFileSync(join(dom, 'vault-guardian.json'), JSON.stringify({ schema: 'vault-guardian.public/1', at: receipt.at, censusAllClear: state.lastCensus?.allClear ?? false, lastDrillOk: state.lastDrill?.ok ?? false, lastHealNeeded: state.lastHeal?.needed ?? false }, null, 1));
    }
  } catch { /* קבלה-מקומית-היא-המכוננת */ }
}

async function censusCycle(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const c = await runCensus();
    if ('error' in c) {
      state.lastError = 'census: ' + c.error;
    } else {
      state.lastCensus = { at: new Date().toISOString(), allClear: c.allClear, steemOk: c.steemOk };
      state.lastError = null;
      if (!c.steemOk || !c.allClear) {
        // החוק: לא-מדווחים-ולא-ממתינים — מרפאים
        const h = await heal();
        const hh = h as { needed?: boolean; after?: { allClear?: boolean } };
        state.lastHeal = { at: new Date().toISOString(), needed: !!hh.needed, afterAllClear: hh.after?.allClear ?? null };
      }
    }
    state.cycles++;
    publishReceipt();
  } catch (e) {
    state.lastError = String((e as Error)?.message || e).slice(0, 120);
    publishReceipt();
  } finally {
    state.running = false;
  }
}

async function drillCycle(): Promise<void> {
  try {
    const d = (await drill()) as { ok: boolean };
    state.lastDrill = { at: new Date().toISOString(), ok: !!d.ok };
    publishReceipt();
  } catch (e) {
    state.lastDrill = { at: new Date().toISOString(), ok: false };
    state.lastError = 'drill: ' + String((e as Error)?.message || e).slice(0, 100);
    publishReceipt();
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/health') {
      return Response.json({
        ok: true,
        service: 'vault-guardian',
        port: PORT,
        startedAt,
        uptimeMs: Date.now() - bootMs,
        cycles: state.cycles,
        census: state.lastCensus,
        lastHeal: state.lastHeal,
        lastDrill: state.lastDrill,
        lastError: state.lastError,
        law: 'no-missing-keys-state-exists',
      });
    }
    if (p === '/receipt') {
      try { return Response.json(JSON.parse(await Bun.file(RECEIPT).text())); } catch { return Response.json({ ok: false, error: 'no-receipt-yet' }, { status: 404 }); }
    }
    if (p === '/census' && req.method === 'POST') {
      // Task-121 audit fix (fingerprint vault-guardian.heal-census-drill.zero-auth-custody-ops):
      // פעולות-משמורת-מפתחות נדרשות-סמכות — כשל-סגור בהיעדר-טוקן
      const deny = organAuth(req);
      if (deny) return deny;
      await censusCycle();
      return Response.json({ ok: true, census: state.lastCensus, lastHeal: state.lastHeal });
    }
    if (p === '/heal' && req.method === 'POST') {
      const deny = organAuth(req);
      if (deny) return deny;
      const h = await heal();
      state.lastHeal = { at: new Date().toISOString(), needed: true, afterAllClear: (h as { after?: { allClear?: boolean } })?.after?.allClear ?? null };
      publishReceipt();
      return Response.json({ ok: true, ...(h as object) });
    }
    if (p === '/drill' && req.method === 'POST') {
      const deny = organAuth(req);
      if (deny) return deny;
      const d = await drill();
      state.lastDrill = { at: new Date().toISOString(), ok: (d as { ok?: boolean }).ok === true };
      publishReceipt();
      return Response.json({ ok: true, drill: d });
    }
    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
});

console.log(`[vault-guardian] חי על :${PORT} — census כל ${CENSUS_MS / 60_000} דק' · drill כל ${DRILL_MS / 3600_000} שעות · שחזור-אוטומטי-מהגיט בעת-כשל`);

setInterval(() => void censusCycle(), CENSUS_MS);
setInterval(() => void drillCycle(), DRILL_MS);
setTimeout(() => void censusCycle(), 4_000); // מחזור-ראשון-מיידי
setTimeout(() => void drillCycle(), 20_000); // תרגיל-ראשון
