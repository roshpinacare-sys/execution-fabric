#!/usr/bin/env bash
# pass-candidate matrix for KEYS-ZIP-2026-10-12-MASTER — honest, no printing
set -u
cd /tmp/saos-work
KEY="$(cat /tmp/vaultwork/headmaster.key)"
KEYSHA="$(printf '%s' "$KEY" | sha256sum | cut -d' ' -f1)"
ENC=agent/vault/KEYS-ZIP-2026-10-12-MASTER.zip.enc
WANT_INNER=89d58fd30523d68935e768d78b1690467d5a8f59b9cb410787db85a911116f50
NAME="headcorner"

try() { # $1 label  $2 pass  $3 iter
  local tmp; tmp="$(mktemp)"
  if openssl enc -d -aes-256-cbc -pbkdf2 -iter "$3" -in "$ENC" -out "$tmp" -pass "pass:$2" 2>/dev/null; then
    # verify it's a real zip + inner sha
    local inner
    inner="$(unzip -p "$tmp" 2>/dev/null | sha256sum | cut -d' ' -f1)"
    if [ "$inner" = "$WANT_INNER" ]; then echo "MATCH $1 (inner verified)"; rm -f "$tmp"; return 0; fi
    if unzip -l "$tmp" >/dev/null 2>&1; then echo "ZIP-OK-but-inner-sha-differs $1 inner=$inner"; rm -f "$tmp"; return 0; fi
    echo "DECRYPT-OK-not-zip $1"; rm -f "$tmp"; return 0
  fi
  rm -f "$tmp"; return 1
}

# candidate passes x iterations
for it in 300000 200000; do
  try "pure-key/iter$it"        "$KEY"                        "$it" && continue
  try "key+sha256/iter$it"      "$KEYSHA"                     "$it" && continue
  try "name-newline-key/iter$it" "$(printf '%s\r\n%s' "$NAME" "$KEY")" "$it" && continue
  try "name-space-key/iter$it"  "$NAME $KEY"                  "$it" && continue
  try "namekey/iter$it"         "$NAME$KEY"                   "$it" && continue
  try "name-only/iter$it"       "$NAME"                       "$it" && continue
  try "P-sha3/iter$it"          "$(printf '%s' "$KEY" | sha256sum | cut -c1-64)" "$it" && continue
done
echo "matrix-done"
