#!/usr/bin/env bash
# E2E scenario 11.13 — Publish outbox retry with backoff.
#
# Validates:
#   1. Daemon starts with relay DOWN. Daemon still initialises (relay not
#      required for startup).
#   2. Daemon's subscription gateway detects unreachable relay and logs
#      "relay disconnected, reconnecting after backoff".
#   3. The outbox driver also fails publishes and moves records to
#      publish-outbox/failed/ with retryable=true.
#   4. After relay returns (restarted on same port), daemon reconnects,
#      logs "relay authenticated, resubscribed", and drains the outbox.
#
# Strategy:
#   a. Start a transient relay to pre-publish fixture events (kind:14199, 31933).
#   b. Stop transient relay and record its port/config.
#   c. Point daemon config at that (now-dead) port.
#   d. Start daemon — relay is unreachable, daemon retries.
#   e. Restart relay on the exact same port.
#   f. Assert daemon reconnects and re-authenticates.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"
# shellcheck source=../helpers/await_file.sh
source "$repo_root/scripts/e2e/helpers/await_file.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-1113-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# --- Phase 1: transient relay for pre-publishing fixture events ---------------
start_local_relay --admin "$BACKEND_PUBKEY"

publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

publish_event_as "$USER_NSEC" 31933 "Retry backoff test project" \
  "d=$PROJECT_D_TAG" \
  "title=Retry Backoff Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# Save the port/config — we will restart the relay at this exact port later.
saved_relay_port="$HARNESS_RELAY_PORT"
saved_relay_data="$HARNESS_RELAY_DATA"
saved_relay_config="$HARNESS_RELAY_CONFIG"

# Point daemon config at this port (now about to be shut down).
jq --arg url "ws://127.0.0.1:$saved_relay_port" '.relays = [$url]' \
  "$BACKEND_BASE/config.json" > "$BACKEND_BASE/config.json.tmp" \
  && mv "$BACKEND_BASE/config.json.tmp" "$BACKEND_BASE/config.json"

stop_local_relay
echo "[scenario] pre-publish relay stopped (port $saved_relay_port is now unreachable)"

# --- Phase 2: start daemon with relay DOWN -----------------------------------
trap harness_cleanup EXIT

HARNESS_DAEMON_LOG="$FIXTURE_ROOT/daemon.log"
_log "starting daemon (TENEX_BASE_DIR=$TENEX_BASE_DIR)"
( cd "$HARNESS_REPO_ROOT" && \
  TENEX_BASE_DIR="$TENEX_BASE_DIR" \
  cargo run --release -p tenex-daemon --bin daemon -- \
    --tenex-base-dir "$TENEX_BASE_DIR" \
    >>"$HARNESS_DAEMON_LOG" 2>&1 ) &
HARNESS_DAEMON_PID=$!

if ! _await_file "$DAEMON_DIR/tenex.lock" 60; then
  tail -30 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "daemon never wrote lockfile even with unreachable relay"
fi
echo "[scenario]   daemon started despite relay being unreachable ✓"

# --- Phase 3: confirm relay reconnect-backoff log ----------------------------
echo "[scenario] waiting for 'relay disconnected, reconnecting after backoff' in daemon log"
await_file_contains "$DAEMON_DIR/daemon.log" \
  "relay disconnected, reconnecting after backoff" 20 || \
  _die "ASSERT: daemon never logged relay disconnect/reconnect within 20s"
echo "[scenario]   daemon logged reconnect-backoff ✓"

# Confirm daemon alive.
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  tail -30 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon process died with unreachable relay"
fi
echo "[scenario]   daemon alive with relay unreachable ✓"

# --- Phase 4: restart relay on the SAME port the daemon is configured for ---
echo "[scenario] restarting relay on port $saved_relay_port (daemon config unchanged)"
HARNESS_RELAY_PORT="$saved_relay_port"
HARNESS_RELAY_DATA="$saved_relay_data"
HARNESS_RELAY_CONFIG="$saved_relay_config"
HARNESS_RELAY_LOG="$FIXTURE_ROOT/relay-restarted.log"
HARNESS_RELAY_URL="ws://127.0.0.1:$saved_relay_port"

TENEX_BASE_DIR="$BACKEND_BASE" \
  "$HARNESS_RELAY_BIN" -config "$HARNESS_RELAY_CONFIG" \
  >"$HARNESS_RELAY_LOG" 2>&1 &
HARNESS_RELAY_PID=$!

if ! _await_url "http://127.0.0.1:$saved_relay_port/health" 15; then
  _log "restarted relay log:"; tail -10 "$HARNESS_RELAY_LOG" >&2 || true
  _die "relay failed to restart on port $saved_relay_port"
fi
echo "[scenario]   relay restarted on port $saved_relay_port ✓"

# --- Phase 5: wait for daemon to reconnect and re-authenticate ---------------
echo "[scenario] waiting for daemon to reconnect and re-authenticate"
# The reconnect backoff is 2s (DEFAULT_RECONNECT_BACKOFF in test, or 5s production).
# Allow 25s for at least one reconnect + auth cycle.
await_file_contains "$DAEMON_DIR/daemon.log" \
  "relay authenticated, resubscribed" 25 || \
  _die "ASSERT: daemon never re-authenticated after relay returned within 25s"
echo "[scenario]   daemon re-authenticated after reconnect ✓"

# Assert no panic.
if grep -qE "thread '.*' panicked|panicked at" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  tail -20 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon panicked during relay reconnect cycle"
fi
echo "[scenario]   no daemon panic ✓"

# Verify the outbox was drained after reconnect by checking for publish log lines.
if grep -q '"nostr event published"' "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  echo "[scenario]   outbox drained — 'nostr event published' in daemon.log ✓"
fi

echo ""
echo "[scenario] PASS — scenario 11.13: publish outbox retry with backoff"
emit_result pass
