#!/usr/bin/env bash
# E2E scenario 12.5 — NIP-46 sign request timeout.
#
# Setup:
#   - Daemon config has a bunker URI pointing at wss://127.0.0.1:1 (refused
#     immediately — no listener) so NIP-46 sign_event requests always timeout.
#   - signingTimeoutMs is reduced to 3000ms (from the 30s default) so the
#     test runs in < 15s.
#   - Agent1 is installed; a kind:14199 does NOT pre-exist so reconciliation
#     runs and hits the timeout.
#
# Trigger:
#   - Daemon boots; reconciler fires; NIP-46 client times out.
#
# Expected:
#   - Daemon logs the timeout error ("nip-46 sign timed out" or similar).
#   - Daemon does NOT panic or crash.
#   - The daemon continues running (subscription stays live) after the failure.
#
# Covers regression bca68a66.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-125-$(date +%s)-$$"
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

# Whitelist the backend so the daemon can subscribe.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$AGENT1_PUBKEY" >/dev/null

# Configure daemon: USER_PUBKEY is whitelisted owner; bunker URI is
# wss://127.0.0.1:1 (connection refused — no server listening there).
# signingTimeoutMs = 3000 so the test finishes in ~10s instead of 30s+.
cfg="$TENEX_BASE_DIR/config.json"
jq \
  --arg owner "$USER_PUBKEY" \
  '.whitelistedPubkeys = [$owner] |
   .nip46 = {
     signingTimeoutMs: 3000,
     maxRetries: 0,
     owners: {
       ($owner): {bunkerUri: ("bunker://" + $owner + "?relay=wss://127.0.0.1:1")}
     }
   }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# The reconciler will attempt to connect/sign via the unreachable relay and
# time out after signingTimeoutMs. We wait for the timeout log.
# The reconciler debounces ~5-10s after startup, plus the 3s sign timeout,
# so total expected time is 8-13s; use 25s to avoid sporadic flakes.
echo "[scenario] waiting up to 25s for NIP-46 timeout log entry"
timeout_deadline=$(( $(date +%s) + 25 ))
saw_timeout=0
while [[ $(date +%s) -lt $timeout_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -qiE "timed out|sign.*timeout|timeout.*sign|nip.46.*timeout|reconcil.*fail" \
       "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_timeout=1
    break
  fi
  sleep 0.5
done

if [[ "$saw_timeout" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "NIP-46 timeout not observed in daemon log within 15s"
  _die "ASSERT: expected timeout log entry after sign request to unreachable bunker"
fi

echo "[scenario]   NIP-46 timeout logged ✓"

# Verify daemon is still running (not crashed). Subscription should be live.
# Use a probe event and check it's processed by the daemon.
probe_evt="$(publish_event_as "$USER_NSEC" 14199 "post-timeout-probe-$$" \
  "p=$USER_PUBKEY" 2>/dev/null || true)"
probe_id="$(printf '%s' "$probe_evt" | jq -r '.id // empty' 2>/dev/null || true)"

alive=0
if [[ -n "$probe_id" ]]; then
  alive_deadline=$(( $(date +%s) + 5 ))
  while [[ $(date +%s) -lt $alive_deadline ]]; do
    if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
       grep -q "$probe_id" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
      alive=1
      break
    fi
    sleep 0.3
  done
else
  # If publish failed (relay issue), just check the daemon process is still up.
  if kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
    alive=1
  fi
fi

if [[ "$alive" -ne 1 ]]; then
  echo "[scenario] daemon log (last 30 lines):"
  tail -30 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "daemon did not survive NIP-46 timeout"
  _die "ASSERT: daemon crashed or became unresponsive after NIP-46 timeout"
fi

echo "[scenario]   daemon survived NIP-46 timeout (still responsive) ✓"
echo ""
echo "[scenario] PASS — scenario 12.5 NIP-46 sign request timeout"
emit_result pass "timeout logged and daemon continued without crash"
