#!/usr/bin/env bash
# E2E scenario 12.7 — SIGHUP reloads NIP-46 owners configuration.
#
# Setup:
#   - Daemon starts with USER_PUBKEY as whitelisted owner and a bunker URI
#     pointing at wss://127.0.0.1:1 (unreachable bunker A, immediate refuse).
#     signingTimeoutMs = 2s so the first reconcile fails fast.
#   - During the run, config.json is updated: bunker URI → bunker B (real nak
#     bunker). SIGHUP is sent.
#   - A dummy agent file is added to disk immediately after SIGHUP to force the
#     agent-inventory poller to fire a fresh trigger (the poller only triggers
#     on inventory changes, and without a change it would wait idle_retry=300s).
#
# Trigger:
#   - SIGHUP causes reload_whitelist_from_handle (registry cleared, new config
#     loaded). Poller detects inventory change → trigger → reconciler fires via
#     bunker B → kind:14199 published.
#
# Expected:
#   - Daemon log contains "SIGHUP reload complete".
#   - A kind:14199 event appears on the relay (published via bunker B).
#
# Covers regression 58bfdfc9.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-127-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

# Pre-seed the whitelist so nak bunker (USER_PUBKEY) and the daemon can subscribe.
seed_whitelist_file "$USER_PUBKEY" "$BACKEND_PUBKEY"

# Start daemon with bunker A: unreachable endpoint, 2s timeout.
cfg="$TENEX_BASE_DIR/config.json"
jq \
  --arg owner "$USER_PUBKEY" \
  '.whitelistedPubkeys = [$owner] |
   .nip46 = {
     signingTimeoutMs: 2000,
     maxRetries: 0,
     owners: {
       ($owner): {bunkerUri: ("bunker://" + $owner + "?relay=wss://127.0.0.1:1")}
     }
   }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Wait for initial reconcile failure with bunker A.
echo "[scenario] waiting up to 12s for initial reconcile failure with bunker A"
fail_deadline=$(( $(date +%s) + 12 ))
saw_fail=0
while [[ $(date +%s) -lt $fail_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -qiE "timed out|sign.*timeout|reconcil.*fail|nip.46.*timeout" \
       "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_fail=1
    break
  fi
  sleep 0.5
done
echo "[scenario]   initial bunker-A timeout (saw_fail=$saw_fail)"

# Start nak bunker B (the real bunker using the local relay).
bunker_log="$fixture_root/bunker.log"
nak bunker \
  --sec "$USER_NSEC" \
  --authorized-keys "$BACKEND_PUBKEY" \
  "$HARNESS_RELAY_URL" \
  >"$bunker_log" 2>&1 &
BUNKER_PID=$!
echo "[scenario] nak bunker B pid=$BUNKER_PID"
sleep 1

# Update config: point bunker URI at the real local bunker with a longer timeout.
jq \
  --arg owner "$USER_PUBKEY" \
  --arg relay "$HARNESS_RELAY_URL" \
  '.nip46.signingTimeoutMs = 15000 |
   .nip46.owners[($owner)].bunkerUri = ("bunker://" + $owner + "?relay=" + $relay)' \
  "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

# Send SIGHUP to trigger config reload.
echo "[scenario] sending SIGHUP to daemon pid=$HARNESS_DAEMON_PID"
kill -HUP "$HARNESS_DAEMON_PID"

# Wait for "SIGHUP reload complete" in daemon log.
reload_deadline=$(( $(date +%s) + 10 ))
saw_reload=0
while [[ $(date +%s) -lt $reload_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -q "SIGHUP reload complete" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_reload=1
    break
  fi
  sleep 0.3
done

if [[ "$saw_reload" -ne 1 ]]; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  kill "$BUNKER_PID" 2>/dev/null || true
  emit_result fail "SIGHUP reload complete not logged within 10s"
  _die "ASSERT: SIGHUP did not trigger whitelist reload"
fi
echo "[scenario]   SIGHUP reload complete logged ✓"

# The agent-inventory poller fires on inventory changes. Add a temporary agent
# file to force the poller to detect a change and send a trigger to the
# reconciler. Without a change the poller won't fire for 300s (idle_retry).
agents_dir="$TENEX_BASE_DIR/agents"
dummy_pubkey="$(printf '%064x' 99)"
dummy_agent="$agents_dir/${dummy_pubkey}.json"
jq -n '{"slug":"dummy-sighup-probe","status":"active"}' > "$dummy_agent"
echo "[scenario]   dummy agent written to force poller trigger"

# Now wait for a successful kind:14199 (bunker B responds).
# Flow: poller detects inventory change (~2s) → trigger sent → debounce 5s →
#       reconcile → client_for_owner (fresh, bunker B) → connect+sign (~1-2s)
#       → 14199 published. Budget: ~10s.
echo "[scenario] waiting up to 20s for kind:14199 via bunker B"
event_json="$(await_kind_event 14199 "" "$USER_PUBKEY" 20 || true)"

# Clean up dummy agent.
rm -f "$dummy_agent"
kill "$BUNKER_PID" 2>/dev/null || true

if [[ -z "$event_json" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  echo "[scenario] bunker log:"
  cat "$bunker_log" >&2 || true
  emit_result fail "kind:14199 not published after SIGHUP within 20s"
  _die "ASSERT: SIGHUP did not restore bunker B path"
fi

echo "[scenario]   kind:14199 published after SIGHUP ✓"
echo ""
echo "[scenario] PASS — scenario 12.7 SIGHUP reloads NIP-46 owners"
emit_result pass "SIGHUP cleared registry; kind:14199 published via bunker B"
