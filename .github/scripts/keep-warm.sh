#!/usr/bin/env bash
# Keep the Render free-tier server warm by pinging /health repeatedly.
#
# This runs as a LOOP inside one workflow run rather than relying on the
# cron to fire often enough, because it does not: GitHub delivers only a
# fraction of a high-frequency schedule (measured on this repo: ~30% of a
# */10 cron, with gaps of 26-52 minutes). Every one of those gaps is longer
# than Render's ~15 minute idle window, so a one-ping-per-trigger workflow
# never actually prevents hibernation. One run that pings for an hour does.
#
# Environment:
#   HEALTH_URL         full URL to ping. Unset -> warn and exit 0.
#   DURATION_MIN       how long this run keeps pinging (default 55).
#   INTERVAL_MIN       minutes between pings (default 5).
#   PING_MAX_TIME      curl timeout in seconds (default 90 — a cold Render
#                      service can take ~50s to answer).
#   PING_RETRIES       curl retries per ping (default 2). Lowered by the
#                      smoke test so its failure cases resolve promptly
#                      instead of waiting out a production-sized timeout.
#   ACTIVE_HOURS_UTC   "START-END" hour window, e.g. "11-05" (wraps past
#                      midnight). Outside it the loop idles without pinging.
#                      Empty = always on. See the workflow for why this
#                      exists: Render's free tier grants ~750 instance-hours
#                      per month and a 31-day month is 744 hours, so a
#                      genuinely 24/7-warm service leaves almost no room for
#                      anything else in the workspace.
set -uo pipefail

HEALTH_URL="${HEALTH_URL:-}"
DURATION_MIN="${DURATION_MIN:-55}"
INTERVAL_MIN="${INTERVAL_MIN:-5}"
ACTIVE_HOURS_UTC="${ACTIVE_HOURS_UTC:-}"
PING_MAX_TIME="${PING_MAX_TIME:-90}"
PING_RETRIES="${PING_RETRIES:-2}"

if [ -z "$HEALTH_URL" ]; then
  echo "::warning::RENDER_HEALTH_URL repo variable is not set — nothing to ping."
  exit 0
fi

# Is the current UTC hour inside the active window? An empty window is
# always open; a window whose start is after its end wraps past midnight.
window_open() {
  [ -z "$ACTIVE_HOURS_UTC" ] && return 0
  local start="${ACTIVE_HOURS_UTC%%-*}" end="${ACTIVE_HOURS_UTC##*-}" hour
  hour=$(date -u +%-H)
  # strip any leading zero so arithmetic never reads them as octal
  start=$((10#$start)); end=$((10#$end))
  if [ "$start" -le "$end" ]; then
    [ "$hour" -ge "$start" ] && [ "$hour" -lt "$end" ]
  else
    [ "$hour" -ge "$start" ] || [ "$hour" -lt "$end" ]
  fi
}

# One ping. A cold service can take ~50s to answer, so allow for that and
# treat any 2xx as awake.
ping_once() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
           --max-time "$PING_MAX_TIME" --retry "$PING_RETRIES" \
           --retry-delay 5 --retry-all-errors \
           "$HEALTH_URL" 2>/dev/null)
  case "$code" in
    2??) echo "$(date -u +%H:%M:%S) HTTP $code — awake"; return 0 ;;
    *)   echo "$(date -u +%H:%M:%S) HTTP ${code:-000} — no answer"; return 1 ;;
  esac
}

echo "Pinging $HEALTH_URL every ${INTERVAL_MIN}min for ${DURATION_MIN}min" \
     "(active hours UTC: ${ACTIVE_HOURS_UTC:-always})"

# The knobs are in minutes for readability, but bash arithmetic is integer
# only — feeding it a fractional minute silently yields a zero deadline and
# the loop degenerates into the single ping this script exists to replace.
# Convert through awk, which does handle decimals, so the tests can use
# sub-minute values without the production path behaving differently.
to_seconds() { awk -v m="$1" 'BEGIN { printf "%d", (m * 60) + 0.5 }'; }
duration_s=$(to_seconds "$DURATION_MIN")
interval_s=$(to_seconds "$INTERVAL_MIN")
[ "$interval_s" -lt 1 ] && interval_s=1

deadline=$(( $(date +%s) + duration_s ))
attempts=0
failures=0
skipped=0

while :; do
  if window_open; then
    attempts=$((attempts + 1))
    ping_once || failures=$((failures + 1))
  else
    skipped=$((skipped + 1))
    echo "$(date -u +%H:%M:%S) outside active hours — idling"
  fi

  # stop once the next ping would land past the deadline, so a run never
  # overruns the window the schedule is expected to cover
  next=$(( $(date +%s) + interval_s ))
  [ "$next" -gt "$deadline" ] && break
  sleep "$interval_s"
done

echo "Done: $attempts ping(s), $failures failure(s), $skipped skipped."

# A single dropped ping is normal (Render restarts, transient DNS). The job
# only fails when the service never answered at all, which is the case worth
# a red X in the run history.
if [ "$attempts" -gt 0 ] && [ "$failures" -eq "$attempts" ]; then
  echo "::error::Every ping failed — $HEALTH_URL never answered."
  exit 1
fi
exit 0
