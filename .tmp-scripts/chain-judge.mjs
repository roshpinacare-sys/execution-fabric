// decisive test: does the headcorner.txt key reproduce the LIVE chain authorities?
// zero secret printing — verdicts only
import { SEED_ORDERS, derivePub } from "/tmp/saos-work/mini-services/saos-engine/steemtx.mjs";
import fs from "node:fs";

const key = fs.readFileSync("/tmp/vaultwork/headmaster.key", "utf8").trim();
const ACCOUNT = "headcorner";
const ROLES = ["owner", "active", "posting", "memo"];

async function rpc(method, params) {
  const r = await fetch("https://api.steemit.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

const [acc] = await rpc("condenser_api.get_accounts", [[ACCOUNT]]);
if (!acc) { console.log("RPC-FAIL"); process.exit(1); }
const live = {
  owner: (acc.owner?.key_auths ?? []).map((x) => x[0]),
  active: (acc.active?.key_auths ?? []).map((x) => x[0]),
  posting: (acc.posting?.key_auths ?? []).map((x) => x[0]),
  memo: acc.memo_key ? [acc.memo_key] : [],
};

// engine law: detect matchedOrder on "active" across all 4 seed orders
let matchedOrder = null;
for (const [name, compose] of Object.entries(SEED_ORDERS)) {
  const pk = derivePub(compose(ACCOUNT, "active", key));
  if (live.active.includes(pk)) { matchedOrder = name; break; }
}
if (!matchedOrder) {
  // maybe the password includes the P prefix stripped? try raw body too
  const body = key.startsWith("P") ? key.slice(1) : key;
  for (const [name, compose] of Object.entries(SEED_ORDERS)) {
    const pk = derivePub(compose(ACCOUNT, "active", body));
    if (live.active.includes(pk)) { matchedOrder = name + "+body"; break; }
  }
}
console.log("matchedOrder:", matchedOrder ?? "NONE");

if (matchedOrder) {
  const orderName = matchedOrder.replace("+body", "");
  const useBody = matchedOrder.endsWith("+body");
  const pw = useBody ? (key.startsWith("P") ? key.slice(1) : key) : key;
  const compose = SEED_ORDERS[orderName];
  let roles = 0;
  for (const role of ROLES) {
    const pk = derivePub(compose(ACCOUNT, role, pw));
    const hit = live[role].includes(pk);
    if (hit) roles++;
    console.log(`  ${role}: ${hit ? "LIVE-MATCH" : "no-match"}`);
  }
  console.log(`ROLES-MATCHED: ${roles}/4`);
}
