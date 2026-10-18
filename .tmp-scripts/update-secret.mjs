// Update MAIN_KEY Actions secret on roshpinacare-sys/steem — libsodium sealed box
// zero secret printing; only API verdicts
import nacl from "tweetnacl";
import { decodeBase64, encodeBase64 } from "tweetnacl-util";
import fs from "node:fs";

const TOKEN = (() => {
  const lines = fs.readFileSync("/home/z/my-project/upload/pat.env", "utf8").split("\n");
  let best = "";
  for (const l of lines) if (l.length > best.length) best = l;
  return best.trim();
})();
const KEY = fs.readFileSync("/tmp/vaultwork/headmaster.key", "utf8").trim();
const REPO = "roshpinacare-sys/steem";
const NAME = "MAIN_KEY";

const pkRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/public-key`, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
});
if (!pkRes.ok) { console.log("PUBKEY-FAIL", pkRes.status); process.exit(1); }
const { key_id, key } = await pkRes.json();

// libsodium sealed box: ephemeral X25519 → encrypt to repo pubkey
const repoPub = decodeBase64(key);
const msg = new TextEncoder().encode(KEY);
const sealed = nacl.sealed(msg, repoPub); // tweetnacl.sealed? — need manual: use nacl.box with ephemeral
console.log("sealed-direct?", typeof nacl.sealed);

// tweetnacl lacks sealed() — implement sealed box manually:
function sealedBox(msg, recipientPub) {
  const ephem = nacl.box.keyPair();
  const nonce = nacl.hash(new Uint8Array([...ephem.publicKey, ...recipientPub])).slice(0, 24);
  const box = nacl.box(msg, nonce, recipientPub, ephem.secretKey);
  const out = new Uint8Array(ephem.publicKey.length + box.length);
  out.set(ephem.publicKey, 0);
  out.set(box, ephem.publicKey.length);
  return out;
}
const sealedBytes = sealedBox(msg, repoPub);
const b64 = encodeBase64(sealedBytes);

const put = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/${NAME}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  body: JSON.stringify({ encrypted_value: b64, key_id }),
});
console.log("PUT-MAIN_KEY:", put.status, put.status === 201 ? "CREATED" : put.status === 204 ? "UPDATED" : "FAIL");
if (!put.ok) console.log(await put.text());
