#!/usr/bin/env bash
# S8.6: hit rate against a strafing target, with lag compensation on and off.
#
# The comparison is the point. S4.13 justifies rewind with an estimate — roughly half a metre
# of miss at 60 ms RTT — and the only honest way to report on that is to run the identical
# experiment with REWIND_DISABLED=1 and put the two columns next to each other.
set -u
cd "$(dirname "$0")/.."

PORT=${PORT:-8120}
SECONDS_PER_RUN=${SECONDS_PER_RUN:-40}
OUT=${OUT:-hit-sweep.jsonl}
: > "$OUT"

for MODE in on off; do
  pkill -f "dist-server/serve" 2>/dev/null
  sleep 1
  if [ "$MODE" = "off" ]; then
    REWIND_DISABLED=1 PORT=$PORT BOTS=0 node dist-server/serve.js > "/tmp/sweep_$MODE.log" 2>&1 &
  else
    PORT=$PORT BOTS=0 node dist-server/serve.js > "/tmp/sweep_$MODE.log" 2>&1 &
  fi
  sleep 3
  for NET in off 50 100 150; do
    node dist-server/netHarness.js --url "ws://127.0.0.1:$PORT" --hittest \
      --seconds "$SECONDS_PER_RUN" --net "$NET" 2>&1 \
      | grep '"event":"hittest"' \
      | sed "s/^/{\"rewind\":\"$MODE\",\"preset\":\"$NET\",\"row\":/" \
      | sed 's/$/}/' >> "$OUT"
  done
done

pkill -f "dist-server/serve" 2>/dev/null
echo "done -> $OUT"
