#!/usr/bin/env bash
# E2E scenario 12.1 — First kind:14199 publish on boot with N p-tags.
#
# Setup:
#   - Daemon config has USER_PUBKEY as a whitelisted owner with a bunker URI
#     pointing to a nak bunker running on the local relay.
#   - Agent1 is installed on disk.
#   - No kind:14199 exists from the owner (no snapshot cache).
#
# Trigger:
#   - Daemon boots; the whitelist reconciler fires after its debounce window
#     (~5s). The NIP-46 sign request goes to nak bunker which auto-approves.
#
# Expected:
#   - A kind:14199 event authored by USER_PUBKEY appears on the relay with
#     p-tags for agent1 and the backend pubkey.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-121-$(date +%s)-$$"
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

# Pre-seed the whitelist file so nak bunker can subscribe to the NIP-42 relay
# before any kind:14199 is published.
seed_whitelist_file "$USER_PUBKEY" "$BACKEND_PUBKEY"

# Configure daemon: USER_PUBKEY is the sole whitelisted owner; bunker URI
# targets the local relay. The backend pubkey is the authorized NIP-46 requester.
cfg="$TENEX_BASE_DIR/config.json"
jq \
  --arg owner "$USER_PUBKEY" \
  --arg relay "$HARNESS_RELAY_URL" \
  '.whitelistedPubkeys = [$owner] |
   .nip46 = {
     signingTimeoutMs: 15000,
     maxRetries: 0,
     owners: {
       ($owner): {bunkerUri: ("bunker://" + $owner + "?relay=" + $relay)}
     }
   }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

# Start nak bunker signed with USER_NSEC, auto-approving requests from backend.
bunker_log="$fixture_root/bunker.log"
nak bunker \
  --sec "$USER_NSEC" \
  --authorized-keys "$BACKEND_PUBKEY" \
  "$HARNESS_RELAY_URL" \
  >"$bunker_log" 2>&1 &
BUNKER_PID=$!
echo "[scenario] nak bunker pid=$BUNKER_PID"
# Give the bunker a moment to connect and subscribe.
sleep 1

start_daemon
await_daemon_subscribed 45 || { kill "$BUNKER_PID" 2>/dev/null; _die "daemon subscription never became live"; }

# The agent-inventory poller fires every 2s and triggers the reconciler.
# The reconciler debounces for 5s then fires, sending a NIP-46 connect + sign_event.
# nak bunker responds immediately. Total expected: ~8-12s.
echo "[scenario] waiting up to 25s for kind:14199 from owner ($USER_PUBKEY)"
event_json="$(await_kind_event 14199 "" "$USER_PUBKEY" 25 || true)"

kill "$BUNKER_PID" 2>/dev/null || true

if [[ -z "$event_json" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  echo "[scenario] bunker log:"
  cat "$bunker_log" >&2 || true
  emit_result fail "no kind:14199 from owner within 25s"
  _die "ASSERT: kind:14199 never published by reconciler"
fi

echo "[scenario]   kind:14199 appeared on relay ✓"

# Verify p-tags include backend pubkey and agent1 pubkey.
p_tags="$(printf '%s' "$event_json" | jq -r '.tags[] | select(.[0] == "p") | .[1]')"
echo "[scenario]   p-tags: $(printf '%s' "$p_tags" | tr '\n' ' ')"

if ! printf '%s' "$p_tags" | grep -q "$BACKEND_PUBKEY"; then
  emit_result fail "kind:14199 missing backend pubkey in p-tags"
  _die "ASSERT: backend pubkey not in p-tags"
fi
if ! printf '%s' "$p_tags" | grep -q "$AGENT1_PUBKEY"; then
  emit_result fail "kind:14199 missing agent1 pubkey in p-tags"
  _die "ASSERT: agent1 pubkey not in p-tags"
fi

echo "[scenario]   backend and agent1 p-tags present ✓"
echo ""
echo "[scenario] PASS — scenario 12.1 First kind:14199 publish on boot"
emit_result pass "kind:14199 published with correct p-tags"
