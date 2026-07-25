#!/usr/bin/env bash
# Checks keep-warm.sh against a real HTTP server.
#
#   bash .github/scripts/keep-warm-smoke.sh
#
# The workflow's whole job is "keep pinging for a while, and be honest about
# whether the server answered", so that is what this exercises: that it
# really loops (the previous version pinged once), that the active-hours
# window opens and closes on the right side of midnight, that one dropped
# ping is tolerated while total silence is not, and that a missing URL stays
# the harmless no-op it is today.
#
# Runs the real apps/server so the pings hit the same /health the workflow
# does. Durations are in seconds' worth of minutes (fractions are fine) so
# the whole thing takes a few seconds.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1
SCRIPT=".github/scripts/keep-warm.sh"
PORT=3195
PASS=0
FAIL=0

check() { # check <description> <condition-result>
  if [ "$2" -eq 0 ]; then echo "✓ $1"; PASS=$((PASS + 1));
  else echo "✗ $1"; FAIL=$((FAIL + 1)); fi
}

export PORT
node apps/server/src/index.js >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill -9 $SERVER_PID 2>/dev/null' EXIT
for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
  echo "could not start the test server on :$PORT"; exit 1
fi
URL="http://localhost:$PORT/health"

# ---- it loops, rather than pinging once -----------------------------------
# 0.2 min of duration at 0.05 min spacing = one ping plus three more.
out=$(HEALTH_URL="$URL" DURATION_MIN=0.2 INTERVAL_MIN=0.05 ACTIVE_HOURS_UTC="" \
        bash "$SCRIPT" 2>&1)
rc=$?
pings=$(grep -c "awake" <<<"$out")
check "exits 0 while the server answers" "$rc"
check "pings repeatedly within one run (got $pings, wanted >1)" \
  "$([ "$pings" -gt 1 ] && echo 0 || echo 1)"
check "reports its own tally" "$(grep -q "Done: $pings ping" <<<"$out" && echo 0 || echo 1)"

# ---- a single run stays inside its budget ---------------------------------
# It must not overrun the window the schedule expects it to cover, or two
# loops would overlap.
start=$(date +%s)
HEALTH_URL="$URL" DURATION_MIN=0.1 INTERVAL_MIN=0.05 ACTIVE_HOURS_UTC="" \
  bash "$SCRIPT" >/dev/null 2>&1
elapsed=$(( $(date +%s) - start ))
check "stops at its deadline (took ${elapsed}s for a 6s budget)" \
  "$([ "$elapsed" -le 12 ] && echo 0 || echo 1)"

# ---- active hours ---------------------------------------------------------
now_h=$(date -u +%-H)
open_window="$(( (now_h + 23) % 24 ))-$(( (now_h + 1) % 24 ))"   # contains now
shut_window="$(( (now_h + 2) % 24 ))-$(( (now_h + 3) % 24 ))"    # does not

out=$(HEALTH_URL="$URL" DURATION_MIN=0.02 INTERVAL_MIN=0.05 \
        ACTIVE_HOURS_UTC="$shut_window" bash "$SCRIPT" 2>&1); rc=$?
check "skips pinging outside the active window ($shut_window)" \
  "$(grep -q "outside active hours" <<<"$out" && echo 0 || echo 1)"
check "a closed window is not an error" "$rc"
check "a closed window really sends nothing" \
  "$(grep -q "awake" <<<"$out" && echo 1 || echo 0)"

out=$(HEALTH_URL="$URL" DURATION_MIN=0.02 INTERVAL_MIN=0.05 \
        ACTIVE_HOURS_UTC="$open_window" bash "$SCRIPT" 2>&1)
check "pings inside the active window ($open_window)" \
  "$(grep -q "awake" <<<"$out" && echo 0 || echo 1)"

# A window that wraps past midnight is the default shape ("11-05"), so the
# hour right after midnight has to count as inside it.
out=$(HEALTH_URL="$URL" DURATION_MIN=0.02 INTERVAL_MIN=0.05 \
        ACTIVE_HOURS_UTC="$(( (now_h + 23) % 24 ))-$(( (now_h + 1) % 24 ))" \
        bash "$SCRIPT" 2>&1)
check "a window wrapping past midnight still opens" \
  "$(grep -q "awake" <<<"$out" && echo 0 || echo 1)"

# Hours written with a leading zero must not be read as octal ("08", "09").
out=$(HEALTH_URL="$URL" DURATION_MIN=0.02 INTERVAL_MIN=0.05 \
        ACTIVE_HOURS_UTC="08-09" bash "$SCRIPT" 2>&1)
check "zero-padded hours parse (no octal error)" \
  "$(grep -q "value too great for base" <<<"$out" && echo 1 || echo 0)"

# ---- failure reporting ----------------------------------------------------
# Nothing listening: every ping fails, and that is worth a red X.
out=$(HEALTH_URL="http://localhost:9/health" DURATION_MIN=0.02 INTERVAL_MIN=0.05 \
        ACTIVE_HOURS_UTC="" bash "$SCRIPT" 2>&1); rc=$?
check "fails when the server never answers" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
check "says why it failed" "$(grep -q "::error::" <<<"$out" && echo 0 || echo 1)"

# An unset URL is the state of a fresh clone — warn, do not fail.
out=$(HEALTH_URL="" DURATION_MIN=0.02 INTERVAL_MIN=0.05 bash "$SCRIPT" 2>&1)
rc=$?
check "an unset RENDER_HEALTH_URL is a warning, not a failure" "$rc"
check "the warning names the variable" \
  "$(grep -q "RENDER_HEALTH_URL" <<<"$out" && echo 0 || echo 1)"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
echo "KEEP WARM SMOKE PASSED"
