#!/usr/bin/env bash
# open KEYS-SEED-2026-10-04.zip.enc with ROT3-era keysZipPass — no secret printing
set -u
cd /tmp/vaultwork/vault-home
PASS="$(cat /tmp/vaultwork/pass-keysZipPass.key)"
ENC=KEYS-SEED-2026-10-04.zip.enc
# this meta's era used iter 300000 in saos-work formulas; try both iters
for it in 300000 200000; do
  tmp="$(mktemp)"
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter "$it" -in "$ENC" -out "$tmp" -pass "pass:$PASS" 2>/dev/null; then
    if unzip -l "$tmp" >/dev/null 2>&1; then
      echo "SEED-OPEN iter=$it; members:"
      unzip -l "$tmp" | tail -n +4 | head -15
      mkdir -p /tmp/vaultwork/seed-open
      unzip -o -q "$tmp" -d /tmp/vaultwork/seed-open
      chmod -R go-rwx /tmp/vaultwork/seed-open
      rm -f "$tmp"
      exit 0
    fi
  fi
  rm -f "$tmp"
done
echo "SEED-LOCKED"
