#!/usr/bin/env bash
# GEN3 unlock with headcorner master key as shard — per gen3-vault.mjs law
set -u
cd /tmp/saos-work
KEY="$(cat /tmp/vaultwork/headmaster.key)"
ENC=agent/vault/HEADCORNER-GEN3.enc
WANT_INNER=3c5ecf21d0050b835446b41cd82f29e74cd96772baac54014e1c4da7a37dbbff
KEYSHA="$(printf '%s' "$KEY" | sha256sum | cut -d' ' -f1)"
# candidates for the GEN3 shard
SHARDS=("$KEY" "$KEYSHA")
for s in "${SHARDS[@]}"; do
  PASS="$(printf 'GEN3|%s' "$s" | sha256sum | cut -d' ' -f1)"
  # GEN3 format: MAGIC\n salt(32) iv(16) body, aes-256-ctr, pbkdf2-300000
  python3 - "$ENC" "$PASS" "$WANT_INNER" <<'PYEOF'
import sys, hashlib, subprocess, os
enc, pw, want = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(enc, 'rb').read()
magic = b"SAOS-GEN3-1\n"
assert raw[:len(magic)] == magic
salt = raw[len(magic):len(magic)+32]
iv = raw[len(magic)+32:len(magic)+48]
body = raw[len(magic)+48:]
key = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, 300000, 32)
# AES-256-CTR decrypt via openssl
proc = subprocess.run(['openssl', 'enc', '-d', '-aes-256-ctr', '-K', key.hex(), '-iv', iv.hex()],
                      input=body, capture_output=True)
plain = proc.stdout
ok = hashlib.sha256(plain).hexdigest() == want
print('GEN3-UNLOCK-OK' if ok else 'gen3-fail', 'plain-len', len(plain))
if ok:
    open('/tmp/vaultwork/gen3-keyfile.bin', 'wb').write(plain)
PYEOF
  if [ -f /tmp/vaultwork/gen3-keyfile.bin ]; then break; fi
done
if [ -f /tmp/vaultwork/gen3-keyfile.bin ]; then
  chmod 600 /tmp/vaultwork/gen3-keyfile.bin
  echo "keyfile-bytes: $(wc -c < /tmp/vaultwork/gen3-keyfile.bin)"
  # shape: mask any long base58 tokens
  sed -E 's/[P5][5JKL][A-Za-z0-9]{44,53}/<WIF-OR-PKEY>/g; s/STM[A-Za-z0-9]{50,55}/<STM-PUB>/g' /tmp/vaultwork/gen3-keyfile.bin | head -20
else
  echo "gen3-locked-with-both-shard-candidates"
fi
