#!/usr/bin/env bash
# E2E scenario 12.2 — Additive reconciliation on agent add.
#
# Setup:
#   - A kind:14199 with only agent1 + backend already exists on the relay
#     (simulating a previous reconcile run).
#   - Agent2 is added to disk.
#
# Trigger:
#   - Daemon boots and reconciler runs. It detects the diff (agent2 missing).
#
# Expected:
#   - A newer kind:14199 appears with p-tags for agent1, agent2, and backend.
#   - Agent1 and backend are preserved (additive, not replaced).
#
# Covers regressions 668fa3a5, 3a19695b.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-122-$(date +%s)-$$"
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

# Register agent1 in the agents index (byProject is empty by default in the fixture).
# The reconciler reads byProject to build the desired p-tag set; without this
# agent1 and agent2 are invisible to the reconciler.
agents_index="$TENEX_BASE_DIR/agents/index.json"
jq --arg pk1 "$AGENT1_PUBKEY" --arg pk2 "$AGENT2_PUBKEY" --arg proj "$PROJECT_D_TAG" \
   '.byProject[$proj] = [$pk1, $pk2]' \
   "$agents_index" > "$agents_index.tmp" && mv "$agents_index.tmp" "$agents_index"

# Configure daemon with USER_PUBKEY as whitelisted owner.
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

# Publish an existing kind:14199 with only agent1 + backend as p-tags.
# This seeds the relay so the daemon's snapshot cache will load it.
pre_14199="$(publish_event_as "$USER_NSEC" 14199 "" \
  "p=$AGENT1_PUBKEY" \
  "p=$BACKEND_PUBKEY")"
pre_14199_id="$(printf '%s' "$pre_14199" | jq -r .id)"
echo "[scenario] pre-seeded 14199 id=$pre_14199_id (agent1+backend only)"

# Start nak bunker.
bunker_log="$fixture_root/bunker.log"
nak bunker \
  --sec "$USER_NSEC" \
  --authorized-keys "$BACKEND_PUBKEY" \
  "$HARNESS_RELAY_URL" \
  >"$bunker_log" 2>&1 &
BUNKER_PID=$!
echo "[scenario] nak bunker pid=$BUNKER_PID"
sleep 1

start_daemon
await_daemon_subscribed 45 || { kill "$BUNKER_PID" 2>/dev/null; _die "daemon subscription never became live"; }

# Wait for the new kind:14199 (must be newer than pre_14199_id and have agent2).
echo "[scenario] waiting up to 25s for updated kind:14199 with agent2"
deadline=$(( $(date +%s) + 25 ))
found_new=0
while [[ $(date +%s) -lt $deadline ]]; do
  latest="$(nak req -k 14199 --limit 5 --auth --sec "$BACKEND_NSEC" \
    -a "$USER_PUBKEY" "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'sort_by(.created_at) | last' 2>/dev/null || true)"
  if [[ -n "$latest" ]] && [[ "$(printf '%s' "$latest" | jq -r .id)" != "$pre_14199_id" ]]; then
    agent2_present="$(printf '%s' "$latest" | jq -e '.tags[] | select(.[0] == "p" and .[1] == "'"$AGENT2_PUBKEY"'")' 2>/dev/null || true)"
    if [[ -n "$agent2_present" ]]; then
      found_new=1
      event_json="$latest"
      break
    fi
  fi
  sleep 1
done

kill "$BUNKER_PID" 2>/dev/null || true

if [[ "$found_new" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  echo "[scenario] bunker log:"
  cat "$bunker_log" >&2 || true
  emit_result fail "updated kind:14199 with agent2 not published within 25s"
  _die "ASSERT: additive reconciliation did not produce new 14199"
fi

echo "[scenario]   updated kind:14199 appeared ✓"

p_tags="$(printf '%s' "$event_json" | jq -r '.tags[] | select(.[0] == "p") | .[1]')"
echo "[scenario]   p-tags: $(printf '%s' "$p_tags" | tr '\n' ' ')"

for pubkey in "$AGENT1_PUBKEY" "$AGENT2_PUBKEY" "$BACKEND_PUBKEY"; do
  if ! printf '%s' "$p_tags" | grep -q "$pubkey"; then
    emit_result fail "kind:14199 missing pubkey ${pubkey:0:16}... in p-tags"
    _die "ASSERT: pubkey not in p-tags"
  fi
done

echo "[scenario]   agent1, agent2, and backend all present in p-tags ✓"
echo ""
echo "[scenario] PASS — scenario 12.2 Additive reconciliation on agent add"
emit_result pass "additive 14199 published with all three p-tags"
