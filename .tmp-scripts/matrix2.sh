#!/usr/bin/env bash
# Full lawful matrix: known blobs x known pass candidates — MATCH-only output
set -u
cd /tmp/saos-work
PKEY="$(cat /tmp/vaultwork/headmaster.key)"          # headcorner P-key (52)
PKEYSHA="$(printf '%s' "$PKEY" | sha256sum | cut -d' ' -f1)"
KP3="$(cat /tmp/vaultwork/pass-keysZipPass.key)"      # ROT3-era zip pass (32)
KB3="$(cat /tmp/vaultwork/pass-keysBackupPass.key)"   # backup pass (32)
VP="$(cat /tmp/vaultwork/.P)"                          # vault-home master P
GEN3PASS="$(printf 'GEN3|%s' "$PKEY" | sha256sum | cut -d' ' -f1)"

BLOBS="
agent/vault/KEYS-ZIP-2026-10-12-MASTER.zip.enc
agent/vault/KEYS-ZIP-2026-09-10.zip.enc
agent/vault/KEYS-ZIP-2026-10-08-ROT3.zip.enc
agent/vault/KEYS-ZIP-2026-10-08.zip.enc
agent/vault/KEYS-ZIP-2026-10-07.zip.enc
agent/vault/KEYS-ZIP-2026-10-08-ROT4.zip.enc
agent/vault/KEYS-SEED-2026-10-04.zip.enc
agent/vault/KEYS-BACKUP-2026-09-09.tar.enc
agent/vault/EXTRA-SECRETS-2026-10-08-ROT4.zip.enc
agent/vault/TOOLBELT-SEAL-2026-10-10.zip.enc
agent/vault/INTEGRATIONS-SEAL-20261010T105634Z.zip.enc
agent/vault/GIT-CRED-2026-10-08.enc
agent/vault/PAT-2026-10-07.env.enc
agent/vault/W1-SIGNING-KEY-r5.enc
"

for blob in $BLOBS; do
  [ -f "$blob" ] || continue
  base="$(basename "$blob")"
  for pass_spec in "PKEY:$PKEY" "PKEYSHA:$PKEYSHA" "KP3:$KP3" "KB3:$KB3" "VP:$VP" "GEN3:$GEN3PASS"; do
    label="${pass_spec%%:*}"
    pass="${pass_spec#*:}"
    [ -n "$pass" ] || continue
    for it in 300000 200000; do
      tmp="$(mktemp)"
      if openssl enc -d -aes-256-cbc -pbkdf2 -iter "$it" -in "$blob" -out "$tmp" -pass "pass:$pass" 2>/dev/null; then
        kind="???"
        if unzip -l "$tmp" >/dev/null 2>&1; then kind="zip"; fi
        if tar -tf "$tmp" >/dev/null 2>&1; then kind="tar"; fi
        if [ "$kind" != "???" ]; then
          echo "MATCH: $base <- $label iter=$it ($kind)"
        fi
      fi
      rm -f "$tmp"
    done
  done
done
echo "matrix2-done"
