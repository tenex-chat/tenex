#!/usr/bin/env bash
# E2E scenario 12.3 — Debounced reconciliation coalesces multiple triggers.
#
# Setup:
#   - A kind:14199 with only agent1 + backend exists (pre-seeded).
#   - Agent2 is installed on disk.
#   - The reconciler debounce is 5s (hardcoded constant in whitelist_wiring.rs).
#
# Trigger:
#   - Daemon boots; the agent-inventory poller fires every 2s.
#     Multiple triggers accumulate within the debounce window.
#
# Expected:
#   - Exactly ONE new kind:14199 is published (the debounce coalesces all
#     triggers into a single reconcile run).
#
# Covers regression f1d15b7c.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-123-$(date +%s)-$$"
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

seed_whitelist_file "$USER_PUBKEY" "$BACKEND_PUBKEY"

# Register agent2 in the agents index so the reconciler detects a diff vs the
# pre-seeded 14199 (which has only agent1+backend). Without this, byProject is
# empty and the reconciler sees no local agents, producing no change.
agents_index="$TENEX_BASE_DIR/agents/index.json"
jq --arg pk1 "$AGENT1_PUBKEY" --arg pk2 "$AGENT2_PUBKEY" --arg proj "$PROJECT_D_TAG" \
   '.byProject[$proj] = [$pk1, $pk2]' \
   "$agents_index" > "$agents_index.tmp" && mv "$agents_index.tmp" "$agents_index"

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

# Pre-seed a kind:14199 with only agent1 + backend.
pre_14199="$(publish_event_as "$USER_NSEC" 14199 "" \
  "p=$AGENT1_PUBKEY" \
  "p=$BACKEND_PUBKEY")"
pre_14199_id="$(printf '%s' "$pre_14199" | jq -r .id)"
echo "[scenario] pre-seeded 14199 id=$pre_14199_id"

bunker_log="$fixture_root/bunker.log"
nak bunker \
  --sec "$USER_NSEC" \
  --authorized-keys "$BACKEND_PUBKEY" \
  "$HARNESS_RELAY_URL" \
  >"$bunker_log" 2>&1 &
BUNKER_PID=$!
sleep 1

start_daemon
await_daemon_subscribed 45 || { kill "$BUNKER_PID" 2>/dev/null; _die "daemon subscription never became live"; }

# Wait for the reconciler to fire and publish a new 14199.
echo "[scenario] waiting up to 25s for debounced kind:14199 with agent2"
deadline=$(( $(date +%s) + 25 ))
found_new=0
while [[ $(date +%s) -lt $deadline ]]; do
  latest="$(nak req -k 14199 --limit 10 --auth --sec "$BACKEND_NSEC" \
    -a "$USER_PUBKEY" "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'sort_by(.created_at) | last' 2>/dev/null || true)"
  if [[ -n "$latest" ]] && [[ "$(printf '%s' "$latest" | jq -r .id)" != "$pre_14199_id" ]]; then
    agent2_present="$(printf '%s' "$latest" | jq -e '.tags[] | select(.[0] == "p" and .[1] == "'"$AGENT2_PUBKEY"'")' 2>/dev/null || true)"
    if [[ -n "$agent2_present" ]]; then
      found_new=1
      break
    fi
  fi
  sleep 1
done

if [[ "$found_new" -ne 1 ]]; then
  kill "$BUNKER_PID" 2>/dev/null || true
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "new kind:14199 not published within 25s"
  _die "ASSERT: reconciler did not fire"
fi

# Wait an additional 10s to ensure no second 14199 is published (debounce check).
echo "[scenario]   new 14199 found — watching 10s for spurious duplicate"
watch_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $watch_deadline ]]; do
  sleep 1
done

# Count how many kind:14199 events from USER_PUBKEY are NEWER than the pre-seeded one.
new_count="$(nak req -k 14199 --limit 20 --auth --sec "$BACKEND_NSEC" \
  -a "$USER_PUBKEY" "$HARNESS_RELAY_URL" 2>/dev/null | \
  jq -s --arg old_id "$pre_14199_id" \
    '[.[] | select(.id != $old_id)] | length' 2>/dev/null || echo 0)"

kill "$BUNKER_PID" 2>/dev/null || true

echo "[scenario]   new 14199 events from owner: $new_count"

if [[ "$new_count" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "debounce failed: expected exactly 1 new 14199, got $new_count"
  _die "ASSERT: debounce should coalesce multiple triggers into one publish"
fi

echo "[scenario]   exactly 1 new kind:14199 published (debounce confirmed) ✓"
echo ""
echo "[scenario] PASS — scenario 12.3 Debounced reconciliation"
emit_result pass "single 14199 published despite multiple poller triggers"
