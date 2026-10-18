#!/usr/bin/env bash
# vault-home lawful unwrap chain — zero secret printing, shape metrics only
set -u
VDIR=/tmp/vaultwork/vault-home
cd "$VDIR"
TOKEN="$(awk '{ if (length($0) > m) { m = length($0); l = $0 } } END { print l }' /home/z/my-project/upload/pat.env)"
if [ -z "$TOKEN" ]; then echo "no-token"; exit 1; fi
P=""
CH=""
# candidate set: PAT + its sha (wrap key = sha256(C))
TSHA="$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)"
for C in "$TOKEN" "$TSHA"; do
  p="$(printf '%s' "$C" | sha256sum | cut -d' ' -f1)"
  for w in wraps/*.enc; do
    tmp="$(mktemp)"
    if VAULT_TMP_P="$p" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$w" -out "$tmp" -pass env:VAULT_TMP_P 2>/dev/null; then
      if [ -s "$tmp" ]; then P="$(cat "$tmp")"; CH="wrap:$(basename "$w" | cut -c1-8)"; fi
    fi
    rm -f "$tmp"
    if [ -n "$P" ]; then break; fi
  done
  if [ -n "$P" ]; then break; fi
done
if [ -z "$P" ]; then
  # legacy: P == credential itself
  tmp="$(mktemp)"
  if VAULT_TMP_P="$TOKEN" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in keys.env.enc -out "$tmp" -pass env:VAULT_TMP_P 2>/dev/null; then
    P="$TOKEN"; CH="legacy"
  fi
  rm -f "$tmp"
fi
if [ -z "$P" ]; then echo "UNWRAP-FAIL"; exit 1; fi
echo "unwrap-ok via $CH, pass-len ${#P}"
printf '%s' "$P" > /tmp/vaultwork/.P
chmod 600 /tmp/vaultwork/.P
# open the headcorner master file
tmp2="$(mktemp)"
if openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in intake/headcorner-master.txt.enc -out "$tmp2" -pass "pass:$P" 2>/dev/null; then
  echo "headcorner-master-OPEN: $(wc -c < "$tmp2") bytes, $(wc -l < "$tmp2") lines"
  KEY=""
  # extract the P-prefixed key ONLY (without name)
  KEY="$(grep -oE 'P[5JKL][A-Za-z0-9]{48,53}' "$tmp2" | head -1)"
  if [ -z "$KEY" ]; then
    KEY="$(grep -oE 'P[A-Za-z0-9]{40,60}' "$tmp2" | head -1)"
  fi
  if [ -n "$KEY" ]; then
    printf '%s' "$KEY" > /tmp/vaultwork/headmaster.key
    chmod 600 /tmp/vaultwork/headmaster.key
    SHA12="$(printf '%s' "$KEY" | sha256sum | cut -c1-12)"
    echo "headmaster-key-extracted: len ${#KEY}, sha12 $SHA12"
  else
    echo "key-extract-fail: file-sha12 $(sha256sum "$tmp2" | cut -c1-12)"
    cp "$tmp2" /tmp/vaultwork/headcorner-plain.tmp
    chmod 600 /tmp/vaultwork/headcorner-plain.tmp
  fi
else
  echo "headcorner-SEAL-FAIL with unwrapped P"
fi
rm -f "$tmp2"
