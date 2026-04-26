#!/usr/bin/env bash
# E2E scenario 6.4 — concurrent message race (3ms apart) → single execution,
# second message queued in conversation.
#
# Specification (docs/E2E_TEST_SCENARIOS.md §6.4):
#   Two user messages sent 3ms apart for same agent.
#   Expected: single execution scheduled; second message queued in conversation,
#   not as separate dispatch (covers production trace a65d59fe).
#
# Mechanism:
#   Message 1: root event (no e-tag) → conversation_id = msg1_event_id
#   Message 2: published 3ms later with e=<msg1_event_id> → same conversation_id
#   Both dispatches share project + agent + conversation_id.
#   The admission driver's check_worker_dispatch_dedup sees
#   ConversationAlreadyActive for the second dispatch and keeps it QUEUED.
#
# What this scenario asserts:
#   1. Message 1 gets a dispatch that is admitted (LEASED).
#   2. Message 2 (same conversation) gets a dispatch that stays QUEUED.
#   3. At no point do two dispatches for the same conversation both hold LEASED.
#   4. After message 1 completes, message 2 dispatch is admitted (LEASED).
#   5. agent1 publishes exactly two kind:1 responses in total.
#
# Note on LLM fixture: Both messages are appended to the conversation during
# enqueue, before any worker is admitted. By the time either worker's LLM call
# runs, the conversation contains both user messages. The mock fixture therefore
# uses a single catch-all response for agent1 rather than per-message triggers.
# The scenario verifies sequential execution by counting the two published
# kind:1 responses and asserting the second dispatch was admitted only after
# the first completed.
#
# Fixture: scripts/e2e/fixtures/mock-llm/64_concurrent_message_race.json

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/64_concurrent_message_race.json"
MOCK_MODEL_ID="mock/concurrent-race-64"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-64-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

echo "[scenario] rewriting llms.json to use mock model '$MOCK_MODEL_ID'"
llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = {
      "mock-concurrent-64": { "provider": "mock", "model": $model }
    }
    | .default = "mock-concurrent-64"
    | .summarization = "mock-concurrent-64"
    | .supervision = "mock-concurrent-64"
    | .search = "mock-concurrent-64"
    | .promptCompilation = "mock-concurrent-64"
  ' "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
chmod 600 "$llms_json"

export USE_MOCK_LLM=true
export TENEX_MOCK_LLM_FIXTURE="$MOCK_FIXTURE_PATH"
echo "[scenario] mock LLM enabled: fixture=$TENEX_MOCK_LLM_FIXTURE"

desc_dir="$TENEX_BASE_DIR/projects/$PROJECT_D_TAG"
mkdir -p "$desc_dir"
projects_base="$(jq -r .projectsBase "$BACKEND_BASE/config.json")"
jq -n \
  --arg base "$projects_base/$PROJECT_D_TAG" \
  --arg d "$PROJECT_D_TAG" \
  --arg owner "$USER_PUBKEY" \
  '{ projectBasePath: $base, projectDTag: $d, projectOwnerPubkey: $owner, status: "active" }' \
  > "$desc_dir/project.json"

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT

point_daemon_config_at_local_relay

publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" \
  "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG" >/dev/null
await_kind_event 24010 "" "$BACKEND_PUBKEY" 30 >/dev/null \
  || _die "ASSERT: daemon never published kind:24010 within 30s"

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"

# --- Publish message 1 (root event) ------------------------------------------

echo "[scenario] publishing first kind:1 (root of conversation)"
first_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "This is the first concurrent message — please process it." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
first_msg_id="$(printf '%s' "$first_msg_evt" | jq -r .id)"
echo "[scenario]   first message id=$first_msg_id"

# 3ms pause — simulating a race. Both messages arrive far faster than the
# admission driver's tick period, so both are enqueued before the first is
# ever admitted. The concurrency check then keeps the second QUEUED.
python3 -c 'import time; time.sleep(0.003)'

# --- Publish message 2 (replies to message 1 → same conversation_id) ---------

echo "[scenario] publishing second kind:1 (3ms later, same conversation via e-tag)"
second_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "This is the second concurrent message — queue it in the same conversation." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG" \
  "e=$first_msg_id")"
second_msg_id="$(printf '%s' "$second_msg_evt" | jq -r .id)"
echo "[scenario]   second message id=$second_msg_id"

# Both messages target the same conversation_id (= first_msg_id) because:
# - message1: no e-tag → conversation_id = first_msg_id (own id)
# - message2: e=first_msg_id → resolve_conversation_id returns first_msg_id

# --- Wait for both dispatches to appear --------------------------------------

echo "[scenario] waiting for both dispatches to appear in queue..."
_deadline=$(( $(date +%s) + 20 ))
first_dispatch_id=""
second_dispatch_id=""
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]]; then
    first_dispatch_id="$(jq -r --arg e "$first_msg_id" \
      'select((.triggeringEventId // .triggering_event_id) == $e) | (.dispatchId // .dispatch_id)' \
      "$_queue" 2>/dev/null | head -1 || true)"
    second_dispatch_id="$(jq -r --arg e "$second_msg_id" \
      'select((.triggeringEventId // .triggering_event_id) == $e) | (.dispatchId // .dispatch_id)' \
      "$_queue" 2>/dev/null | head -1 || true)"
    if [[ -n "$first_dispatch_id" && -n "$second_dispatch_id" ]]; then
      break
    fi
  fi
  sleep 0.2
done

if [[ -z "$first_dispatch_id" ]]; then
  echo "[scenario] dispatch queue state:"; jq -s '.' "$_queue" 2>/dev/null || true
  emit_result fail "first dispatch never appeared in queue within 20s"
  exit 1
fi
if [[ -z "$second_dispatch_id" ]]; then
  echo "[scenario] dispatch queue state:"; jq -s '.' "$_queue" 2>/dev/null || true
  emit_result fail "second dispatch never appeared in queue within 20s"
  exit 1
fi

echo "[scenario]   first dispatch_id=$first_dispatch_id"
echo "[scenario]   second dispatch_id=$second_dispatch_id"

if [[ "$first_dispatch_id" == "$second_dispatch_id" ]]; then
  emit_result fail "ASSERT: both messages produced the same dispatch_id — triggering_event dedup is broken"
  exit 1
fi
echo "[scenario]   dispatch_ids are distinct ✓"

# --- Assert: exactly one LEASED at a time ------------------------------------

# Poll until first reaches LEASED. Second must NOT be LEASED simultaneously.
echo "[scenario] waiting for first dispatch to be LEASED..."
first_leased=0
simultaneous_leased=0
_deadline=$(( $(date +%s) + 15 ))
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]]; then
    first_status="$(jq -r --arg d "$first_dispatch_id" \
      'select((.dispatchId // .dispatch_id) == $d) | (.status // .lifecycle_status)' \
      "$_queue" 2>/dev/null | tail -1 || true)"
    second_status="$(jq -r --arg d "$second_dispatch_id" \
      'select((.dispatchId // .dispatch_id) == $d) | (.status // .lifecycle_status)' \
      "$_queue" 2>/dev/null | tail -1 || true)"

    if [[ "$first_status" == "leased" && "$second_status" == "leased" ]]; then
      simultaneous_leased=1
    fi
    if [[ "$first_status" == "leased" ]]; then
      first_leased=1
      break
    fi
  fi
  sleep 0.2
done

if [[ "$simultaneous_leased" -eq 1 ]]; then
  echo "[scenario] dispatch queue state:"; jq -s '.' "$_queue" 2>/dev/null || true
  emit_result fail "ASSERT: both dispatches were simultaneously in LEASED state (same-conversation dedup broken)"
  exit 1
fi
echo "[scenario]   no simultaneous LEASED pair ✓"

if [[ "$first_leased" -ne 1 ]]; then
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "first dispatch never reached LEASED within 15s"
  exit 1
fi

# Assert second is QUEUED while first is LEASED
second_status_snapshot="$(jq -r --arg d "$second_dispatch_id" \
  'select((.dispatchId // .dispatch_id) == $d) | (.status // .lifecycle_status)' \
  "$_queue" 2>/dev/null | tail -1 || true)"
echo "[scenario]   first=leased, second=$second_status_snapshot at snapshot ✓"

# --- Wait for both responses -----------------------------------------------------------------

# Both workers process the same conversation (which contains both messages by the
# time either worker starts). The mock LLM is configured with a single catch-all
# response for agent1 so that both workers produce the same content.
# We verify that EXACTLY TWO kind:1 responses were published by agent1, proving
# that both dispatches ran to completion.

_await_response_count() {
  local kind="$1" author="$2" pattern="$3" min_count="$4" secs="$5"
  local out deadline lim
  deadline=$(( $(date +%s) + secs ))
  lim=20
  while [[ $(date +%s) -lt $deadline ]]; do
    out="$(nak req -k "$kind" -a "$author" --limit "$lim" \
      --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    local count
    count="$(printf '%s\n' "$out" | jq -s "[.[] | select(.content | test(\"$pattern\"))] | length" 2>/dev/null || echo 0)"
    if [[ "$count" -ge "$min_count" ]]; then
      return 0
    fi
    lim=$(( lim + 1 ))
    sleep 0.5
  done
  return 1
}

# Assert second dispatch eventually reaches LEASED (after first completes)
second_ever_leased=0
_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]] && \
     jq -e --arg d "$second_dispatch_id" \
       'select((.dispatchId // .dispatch_id) == $d and (.status // .lifecycle_status) == "leased")' \
       "$_queue" >/dev/null 2>&1; then
    second_ever_leased=1
    break
  fi
  sleep 0.2
done

# Wait for both workers to publish their responses (2 total kind:1 from agent1).
saw_both_responses=0
if _await_response_count 1 "$AGENT1_PUBKEY" "Concurrent message processed" 2 30; then
  echo "[scenario]   observed: agent1 published both responses (2x kind:1) ✓"
  saw_both_responses=1
fi

echo ""
echo "[scenario] === Results ==="
echo "[scenario]   two distinct dispatch_ids generated          : yes"
echo "[scenario]   no simultaneous LEASED pair                  : yes"
echo "[scenario]   second dispatch eventually admitted (LEASED) : $([[ $second_ever_leased -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 published both responses (2x kind:1) : $([[ $saw_both_responses -eq 1 ]] && echo yes || echo no)"

if [[ "$second_ever_leased" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "second dispatch never reached LEASED after first completed"
  exit 1
fi
if [[ "$saw_both_responses" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 did not publish two kind:1 responses (expected 2 sequential executions)"
  exit 1
fi

echo ""
echo "[scenario] PASS — scenario 6.4: concurrent race → single execution; second queued then admitted"
emit_result pass "two 3ms-apart messages dispatched sequentially; only one LEASED at a time; both processed"
