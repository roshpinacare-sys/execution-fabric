#!/usr/bin/env bash
# sync live engine state (saos-fresh) into work tree (saos-work) — union/append law
set -u
SRC=/tmp/saos-fresh/mini-services/saos-engine
DST=/tmp/saos-work/mini-services/saos-engine
synced=0
# jsonl files: append the missing tail (lines beyond work count — both share history)
for f in events.jsonl exec-log.jsonl think-log.jsonl; do
  a="$SRC/state/$f"; b="$DST/state/$f"
  [ -f "$a" ] && [ -f "$b" ] || continue
  na=$(wc -l < "$a"); nb=$(wc -l < "$b")
  if [ "$na" -gt "$nb" ]; then
    tail -n $((na - nb)) "$a" >> "$b"
    synced=$((synced+1))
    echo "appended $f: +$((na - nb)) lines"
  fi
done
# json state files: fresh copy wins (newest measurements — the fresh engine just ran the cycle)
for f in adaptation.json army-custody.json authority-watchdog.json blurt-probe.json bridge-guard.json bus.json capital-router.json content-ops.json; do
  a="$SRC/state/$f"; b="$DST/state/$f"
  [ -f "$a" ] || continue
  if ! cmp -s "$a" "$b" 2>/dev/null; then cp "$a" "$b"; synced=$((synced+1)); echo "copied $f"; fi
done
# receipts
for f in authority-watchdog.jsonl capital-router.jsonl finance-digest.jsonl node-health.jsonl revenue-compile.jsonl yield-distribution.jsonl; do
  a="$SRC/receipts/$f"; b="$DST/receipts/$f"
  [ -f "$a" ] || continue
  if [ ! -f "$b" ]; then cp "$a" "$b"; synced=$((synced+1)); echo "copied receipts/$f"; else
    na=$(wc -l < "$a"); nb=$(wc -l < "$b")
    if [ "$na" -gt "$nb" ]; then tail -n $((na - nb)) "$a" >> "$b"; synced=$((synced+1)); echo "appended receipts/$f: +$((na - nb))"; fi
  fi
done
echo "synced=$synced"
