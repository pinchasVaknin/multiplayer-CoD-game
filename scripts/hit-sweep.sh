#!/usr/bin/env bash
# S8.6: hit rate against a strafing target, with lag compensation on and off.
#
# The comparison is the point. S4.13 justifies rewind with an estimate — roughly half a metre
# of miss at 60 ms RTT — and the only honest way to report on that is to run the identical
# experiment with REWIND_DISABLED=1 and put the two columns next to each other.
#
# CROUCH=1 makes the target hold crouch (M13 C2), so the same sweep measures the crouch
# layouts: run it before and after a layout changes and the hit rate is a measured move.
#
# The server is started here and stopped here, by the PID this script was handed — not by
# `pkill -f`, which from Git Bash on Windows never reaches a native node.exe. M10's note that
# "the sweep script died partway on Windows" was this: the first server outlived every later
# one, each of which failed with EADDRINUSE, and every later row was measured against the
# first server — the wrong rewind mode, and in M13 C2 the wrong rig. So a mode now refuses to
# run unless the server it started reports `listening`, and a row can only come from it.
set -u
cd "$(dirname "$0")/.."

PORT=${PORT:-8120}
SECONDS_PER_RUN=${SECONDS_PER_RUN:-40}
OUT=${OUT:-hit-sweep.jsonl}
LOG_DIR=${LOG_DIR:-/tmp}
CROUCH_FLAG=""
if [ "${CROUCH:-0}" = "1" ]; then CROUCH_FLAG="--crouch"; fi
: > "$OUT"

SERVER_PID=""

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    SERVER_PID=""
  fi
}
trap stop_server EXIT

# Start one server for a mode and block until it is listening on our port, or fail the sweep.
start_server() {
  local mode=$1
  local log="$LOG_DIR/sweep_$mode.log"
  if [ "$mode" = "off" ]; then
    REWIND_DISABLED=1 PORT=$PORT BOTS=0 node dist-server/serve.js > "$log" 2>&1 &
  else
    PORT=$PORT BOTS=0 node dist-server/serve.js > "$log" 2>&1 &
  fi
  SERVER_PID=$!
  local waited=0
  while ! grep -q "listening" "$log" 2>/dev/null; do
    if grep -q "EADDRINUSE" "$log" 2>/dev/null; then
      echo "hit-sweep: port $PORT is held by another process; a row from it would measure the wrong server" >&2
      exit 2
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "hit-sweep: the $mode server exited before listening — see $log" >&2
      exit 2
    fi
    sleep 0.5
    waited=$((waited + 1))
    if [ "$waited" -ge 40 ]; then
      echo "hit-sweep: the $mode server did not report listening within 20 s — see $log" >&2
      exit 2
    fi
  done
}

for MODE in on off; do
  start_server "$MODE"
  for NET in off 50 100 150; do
    node dist-server/netHarness.js --url "ws://127.0.0.1:$PORT" --hittest $CROUCH_FLAG \
      --seconds "$SECONDS_PER_RUN" --net "$NET" 2>&1 \
      | grep '"event":"hittest"' \
      | sed "s/^/{\"rewind\":\"$MODE\",\"preset\":\"$NET\",\"row\":/" \
      | sed 's/$/}/' >> "$OUT"
  done
  stop_server
done

echo "done -> $OUT"
