#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Task-123 — ריבונות-ההקמה-העצמית: בוט-אחיד לכל-המערכת בפקודה-אחת.
# הלקח-החי (הבעלים, 2026-10-22): המערכת נשארה-חיה בעת-היעדרות (מדידה: 23-50
# רשומות-שרשרת בכל-שעה, 8 שעות רצוף) — אך אין-דרך-מוכחת להקים-הכל אחרי
# אתחול-מכונה. מעתה: פקודה-אחת מקימה-הכל, אידמפוטנטית (מי-שכבר-חי נשאר-חי),
# כנה (כל-רכיב מדווח PASS/SKIP/FAIL, exit!=0 אם-משהו-לא-קם).
# סדר-העלייה: האפליקציה → עד → לב → זקיפה → שאר-האיברים (הזקיפה משלימה-כל-חסר
# מעצמה — חוק Task-114; הלב מחיה-את-הזקיפה — keeperGuard).
# שימוש:  sh .zscripts/boot-all.sh          (או: nohup sh .zscripts/boot-all.sh &)
# ─────────────────────────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN=/usr/local/bin/bun
WAIT_APP=90
WAIT_ORGAN=30
FAILED=""

port_up() { # $1=port → 0 אם-עונה (כל-קוד-http סביר)
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$1/$( [ "$1" = 3000 ] && echo api/health || echo health )")" != "000" ]
}

wait_up() { # $1=port $2=timeout-sec
  i=0
  while [ "$i" -lt "$2" ]; do
    port_up "$1" && return 0
    sleep 2; i=$((i + 2))
  done
  return 1
}

start_component() { # $1=name $2=port $3=dir $4=log $5=timeout
  if port_up "$2"; then
    echo "SKIP  $1 — כבר-חי (פורט $2)"
    return 0
  fi
  echo "START $1 — עולה (פורט $2)…"
  (cd "$ROOT/$3" && nohup $BUN run dev </dev/null >>"$4" 2>&1 &)
  if wait_up "$2" "$5"; then
    echo "PASS  $1 — חי (פורט $2)"
    return 0
  fi
  echo "FAIL  $1 — לא-ענה-אחרי-$5ש' (בדוק $4)"
  FAILED="$FAILED $1"
  return 1
}

echo "=== בוט-ריבוני — $(date -u +%FT%TZ) ==="

# 1) האפליקציה-הראשית (הלב — כל-ה-loops האוטונומיים חיים-בה)
start_component app 3000 "" /tmp/app-3000.log $WAIT_APP || true

# 2) עד-השרשרת (witness) — אמת-השרשרת-הקנונית
start_component chain-witness 3050 mini-services/chain-witness /tmp/mini-service-chain-witness.log $WAIT_ORGAN || true

# 3) הלב (fabric-heartbeat) — פעימות-גיט + חיווי-חי + digest
start_component fabric-heartbeat 3031 mini-services/fabric-heartbeat /tmp/mini-service-fabric-heartbeat.log $WAIT_ORGAN || true

# 4) הזקיפה (survival-keeper) — מחיה-את-כל-האיברים, כולל-הקמה-מהגיט (Task-114)
start_component survival-keeper 3051 mini-services/survival-keeper /tmp/mini-service-survival-keeper.log $WAIT_ORGAN || true

# 5) שאר-האיברים
start_component saos-metrics 3060 mini-services/saos-metrics /tmp/mini-service-saos-metrics.log $WAIT_ORGAN || true
start_component saos-grid 3070 mini-services/saos-grid /tmp/mini-service-saos-grid.log $WAIT_ORGAN || true
start_component saos-arb 3071 mini-services/saos-arb /tmp/mini-service-saos-arb.log $WAIT_ORGAN || true
start_component saos-council 3072 mini-services/saos-council /tmp/mini-service-saos-council.log $WAIT_ORGAN || true
start_component vault-guardian 3080 mini-services/vault-guardian /tmp/mini-service-vault-guardian.log $WAIT_ORGAN || true
start_component saos-dex 3010 repos/saos-dex /tmp/dex-boot.log $WAIT_APP || true

echo "=== סיכום ==="
if [ -n "$FAILED" ]; then
  echo "כשלים:${FAILED} — כנות; הזקיפה (3051) תמשיך-לנסות-להחיות בעצמה"
  exit 1
fi
echo "כל-הרכיבים חיים — המערכת ריבונית"
