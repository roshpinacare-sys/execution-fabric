// Update MAIN_KEY Actions secret — real libsodium crypto_box_seal. Zero secret printing.
import sodium from "libsodium-wrappers";
import fs from "node:fs";

const TOKEN = (() => {
  const lines = fs.readFileSync("/home/z/my-project/upload/pat.env", "utf8").split("\n");
  let best = "";
  for (const l of lines) if (l.length > best.length) best = l;
  return best.trim();
})();
const KEY = fs.readFileSync("/tmp/vaultwork/headmaster.key", "utf8").trim();

const REPO = process.argv[2] || "roshpinacare-sys/steem";
const NAME = process.argv[3] || "MAIN_KEY";
const VALUE = process.argv[4] === "CRED" ? `headcorner ${KEY}` : KEY;

await sodium.ready;
const pkRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/public-key`, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
});
if (!pkRes.ok) { console.log("PUBKEY-FAIL", pkRes.status); process.exit(1); }
const { key_id, key } = await pkRes.json();

const repoPub = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
const sealed = sodium.crypto_box_seal(new TextEncoder().encode(VALUE), repoPub);
const b64 = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

const put = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/${NAME}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
  body: JSON.stringify({ encrypted_value: b64, key_id }),
});
console.log(`PUT ${REPO}#${NAME}:`, put.status, put.status === 201 ? "CREATED" : put.status === 204 ? "UPDATED" : "FAIL");
if (!put.ok) console.log(await put.text());
