#!/usr/bin/env bash
# rot3Seed tests: GEN3 inner pin + MASTER zip + GEN3 unlock
set -u
cd /tmp/saos-work
SEED="$(cat /tmp/vaultwork/vh-rotation-rot3Seed.key)"
GEN3_INNER_WANT=3c5ecf21d0050b835446b41cd82f29e74cd96772baac54014e1c4da7a37dbbff
echo "seed-len: ${#SEED}"
# 1. is GEN3's sealed keyfile == rot3Seed?
S1="$(printf '%s' "$SEED" | sha256sum | cut -d' ' -f1)"
[ "$S1" = "$GEN3_INNER_WANT" ] && echo "GEN3-INNER == rot3Seed: YES" || echo "GEN3-INNER != rot3Seed ($S1 vs $GEN3_INNER_WANT)"
# 2. does rot3Seed open the MASTER zip?
for it in 300000 200000; do
  tmp="$(mktemp)"
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter "$it" -in agent/vault/KEYS-ZIP-2026-10-12-MASTER.zip.enc -out "$tmp" -pass "pass:$SEED" 2>/dev/null && unzip -l "$tmp" >/dev/null 2>&1; then
    echo "MASTER-OPENS with rot3Seed iter=$it"
    INNER="$(unzip -p "$tmp" 2>/dev/null | sha256sum | cut -d' ' -f1)"
    echo "inner: $INNER"
    rm -f "$tmp"; exit 0
  fi
  rm -f "$tmp"
done
# 3. GEN3 unlock with rot3Seed as shard
GEN3PASS="$(printf 'GEN3|%s' "$SEED" | sha256sum | cut -d' ' -f1)"
python3 - agent/vault/HEADCORNER-GEN3.enc "$GEN3PASS" "$GEN3_INNER_WANT" <<'PYEOF'
import sys, hashlib, subprocess
enc, pw, want = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(enc, 'rb').read()
magic = b"SAOS-GEN3-1\n"
salt = raw[len(magic):len(magic)+32]
iv = raw[len(magic)+32:len(magic)+48]
body = raw[len(magic)+48:]
key = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, 300000, 32)
proc = subprocess.run(['openssl', 'enc', '-d', '-aes-256-ctr', '-K', key.hex(), '-iv', iv.hex()], input=body, capture_output=True)
plain = proc.stdout
if hashlib.sha256(plain).hexdigest() == want:
    open('/tmp/vaultwork/gen3-keyfile.bin', 'wb').write(plain)
    print('GEN3-UNLOCK-OK with rot3Seed shard; plain-len', len(plain))
else:
    print('gen3-fail-rot3Seed')
PYEOF
if [ -f /tmp/vaultwork/gen3-keyfile.bin ]; then
  chmod 600 /tmp/vaultwork/gen3-keyfile.bin
  sed -E 's/[0-9a-f]{40,64}/<HEX>/g; s/[P5][5JKL][A-Za-z0-9]{44,53}/<PKEY>/g' /tmp/vaultwork/gen3-keyfile.bin | head -10
fi
echo "done"
