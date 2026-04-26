#!/usr/bin/env bash
# E2E scenario 10.4 — Correlation ID chain visible across daemon log, RAL
# journal, and publish outbox for one inbound→reply round-trip.
#
# Milestone gate (docs/rust/implementation-milestones-and-quality-gates.md
# §"Observability"): "Every Rust-dispatched execution needs a correlation
# ID present in: Rust logs, worker protocol messages, RAL journal entries,
# worker state files, relevant telemetry spans".
#
# We assert the conversation_id (the user's triggering kind:1 native_id)
# threads through every Rust-owned record produced by the round-trip:
#   - daemon.log tracing JSON
#   - daemon/ral/journal.jsonl records for the parent agent
#   - daemon/publish-outbox/published/*.json records for the reply
#
# This is "correlation chain at the conversation grain" — the ID a human
# operator can use to reconstruct what happened to a specific user message.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/02_delegation.json"
MOCK_MODEL_ID="mock/delegation-02"
[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

SCENARIO_MAX_ELAPSED=60
SCENARIO_START="$(date +%s)"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-104-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = {
      "mock-delegation-02": { "provider": "mock", "model": $model }
    }
    | .default = "mock-delegation-02"
    | .summarization = "mock-delegation-02"
    | .supervision = "mock-delegation-02"
    | .search = "mock-delegation-02"
    | .promptCompilation = "mock-delegation-02"
  ' "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
chmod 600 "$llms_json"
export USE_MOCK_LLM=true
export TENEX_MOCK_LLM_FIXTURE="$MOCK_FIXTURE_PATH"

start_local_relay --admin "$BACKEND_PUBKEY"
point_daemon_config_at_local_relay

publish_event_as "$USER_NSEC" 14199 "" "p=$AGENT1_PUBKEY" "p=$AGENT2_PUBKEY" >/dev/null
publish_event_as "$USER_NSEC" 31933 "Project for correlation chain test" \
  "d=$PROJECT_D_TAG" \
  "title=Correlation Chain" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Boot the project.
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

# Wait for the daemon to process boot (kind:24010 published).
deadline=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $deadline ]]; do
  out="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
    --limit 5 "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if printf '%s\n' "$out" | jq -se --arg a "$PROJECT_A_TAG" \
       'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
    echo "[scenario]   kind:24010 published for our project ✓"
    break
  fi
  sleep 0.5
done

# Send the user message. Capture its event id — that's our correlation key.
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "What is 2+2?" \
  "a=$PROJECT_A_TAG" \
  "p=$AGENT1_PUBKEY")"
conv_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
[[ -n "$conv_id" ]] && [[ "$conv_id" != "null" ]] || _die "ASSERT: failed to capture user message event id"
echo "[scenario]   user message id (correlation key)=$conv_id"

# Wait for agent1 to publish its final reply.
deadline=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $deadline ]]; do
  out="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
    "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if printf '%s\n' "$out" | \
       jq -se 'any(.[]; .content | test("Final answer: agent2 says 4"))' >/dev/null 2>&1; then
    echo "[scenario]   agent1 published final reply ✓"
    break
  fi
  sleep 0.5
done

# === Correlation chain assertions =============================================

echo ""
echo "[scenario] === Asserting correlation_id chain ==="

# 1. daemon.log tracing JSON: must mention our conversation_id at least once.
daemon_log="$DAEMON_DIR/daemon.log"
[[ -f "$daemon_log" ]] || _die "ASSERT: daemon.log not present"
log_hits="$(jq -r --arg c "$conv_id" \
  'select(((.fields // {}) | tostring) | contains($c)) | .timestamp' \
  "$daemon_log" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$log_hits" -lt 1 ]]; then
  _die "ASSERT: conversation_id $conv_id did not appear in daemon.log"
fi
echo "[scenario]   daemon.log hits for conv_id: $log_hits ✓"

# 2. RAL journal: at least one record must reference the conversation_id.
ral_journal="$DAEMON_DIR/ral/journal.jsonl"
[[ -f "$ral_journal" ]] || _die "ASSERT: ral/journal.jsonl not present"
ral_hits="$(jq -r --arg c "$conv_id" \
  'select(.conversationId == $c) | .sequence' \
  "$ral_journal" 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$ral_hits" -lt 1 ]]; then
  _die "ASSERT: no RAL journal records reference conversation_id $conv_id"
fi
echo "[scenario]   ral journal records for conv_id: $ral_hits ✓"

# 3. Publish outbox: at least one published record must reference the conv_id.
published_dir="$DAEMON_DIR/publish-outbox/published"
[[ -d "$published_dir" ]] || _die "ASSERT: publish-outbox/published not present"
outbox_hits=0
for f in "$published_dir"/*.json; do
  [[ -f "$f" ]] || continue
  if jq -e --arg c "$conv_id" \
      '.. | objects | select(.conversation_id? == $c or .conversationId? == $c)' \
      "$f" >/dev/null 2>&1; then
    outbox_hits=$((outbox_hits + 1))
  fi
done
if [[ "$outbox_hits" -lt 1 ]]; then
  _die "ASSERT: no publish-outbox records reference conversation_id $conv_id"
fi
echo "[scenario]   publish-outbox records for conv_id: $outbox_hits ✓"

emit_result pass "conv_id present in daemon.log ($log_hits) + ral journal ($ral_hits) + publish outbox ($outbox_hits)"
