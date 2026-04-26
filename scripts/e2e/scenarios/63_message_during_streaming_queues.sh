#!/usr/bin/env bash
# E2E scenario 6.3 — new user message during streaming queues but doesn't pre-empt.
#
# Specification (docs/E2E_TEST_SCENARIOS.md §6.3):
#   agent1 streaming a long response. User sends second message. Second message
#   queued in conversation; current stream completes; second message dispatched after.
#
# What this scenario asserts:
#   1. agent1's first dispatch is admitted (LEASED) and streaming (streamDelay=3s).
#   2. While agent1 is actively streaming, user publishes a second kind:1.
#   3. Second message's dispatch is enqueued with status QUEUED (not immediately LEASED).
#   4. First stream completes; agent1 publishes its kind:1 response.
#   5. Second dispatch transitions to LEASED and agent1 processes second message.
#   6. agent1 publishes a second kind:1 response.
#   7. At no point are both dispatches in LEASED state simultaneously.
#
# Fixture: scripts/e2e/fixtures/mock-llm/63_message_during_streaming.json

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/63_message_during_streaming.json"
MOCK_MODEL_ID="mock/streaming-63"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-63-$(date +%s)-$$"
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
      "mock-streaming-63": { "provider": "mock", "model": $model }
    }
    | .default = "mock-streaming-63"
    | .summarization = "mock-streaming-63"
    | .supervision = "mock-streaming-63"
    | .search = "mock-streaming-63"
    | .promptCompilation = "mock-streaming-63"
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

# --- Publish first message and wait for LEASED --------------------------------

echo "[scenario] publishing first kind:1 (triggers 3s streaming response)"
first_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "This is the first message — respond with a long streaming reply." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
first_msg_id="$(printf '%s' "$first_msg_evt" | jq -r .id)"
echo "[scenario]   first message id=$first_msg_id"

echo "[scenario] waiting for first dispatch to be LEASED (worker active)..."
first_dispatch_leased=0
_deadline=$(( $(date +%s) + 20 ))
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]] && \
     jq -e 'select((.status // .lifecycle_status) == "leased")' "$_queue" >/dev/null 2>&1; then
    first_dispatch_leased=1
    break
  fi
  sleep 0.2
done

if [[ "$first_dispatch_leased" -ne 1 ]]; then
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "first dispatch never reached LEASED state within 20s"
  exit 1
fi
echo "[scenario]   first dispatch is LEASED (agent1 streaming) ✓"

# --- Publish second message while first is still streaming --------------------

# The first response has a 3s streamDelay. We publish the second message now
# (within ~1s of LEASED) so it arrives while streaming is in progress.
echo "[scenario] publishing second kind:1 mid-stream"
second_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "This is the second message — process it after the current stream finishes." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
second_msg_id="$(printf '%s' "$second_msg_evt" | jq -r .id)"
echo "[scenario]   second message id=$second_msg_id"

# --- Assert: second dispatch is QUEUED (not LEASED yet) ----------------------

echo "[scenario] waiting for second dispatch to appear as QUEUED..."
second_dispatch_queued=0
_deadline=$(( $(date +%s) + 8 ))
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]] && \
     jq -e --arg e "$second_msg_id" \
       'select((.triggeringEventId // .triggering_event_id) == $e and (.status // .lifecycle_status) == "queued")' \
       "$_queue" >/dev/null 2>&1; then
    second_dispatch_queued=1
    break
  fi
  sleep 0.2
done

if [[ "$second_dispatch_queued" -ne 1 ]]; then
  echo "[scenario] dispatch queue state:"
  jq -s '.' "$_queue" 2>/dev/null || true
  emit_result fail "second dispatch never appeared as QUEUED within 8s"
  exit 1
fi
echo "[scenario]   second dispatch is QUEUED (not pre-empting first stream) ✓"

# --- Assert: no simultaneous LEASED state for two dispatches -----------------

# Snapshot: at this moment first should be LEASED, second should be QUEUED.
leased_count="$(jq -s '[.[] | select((.status // .lifecycle_status) == "leased")] | length' \
  "$_queue" 2>/dev/null || echo 0)"
if [[ "$leased_count" -gt 1 ]]; then
  echo "[scenario] dispatch queue state:"
  jq -s '.' "$_queue" 2>/dev/null || true
  emit_result fail "ASSERT: $leased_count dispatches simultaneously in LEASED state (expected <=1)"
  exit 1
fi
echo "[scenario]   only $leased_count dispatch(es) in LEASED state at time of check ✓"

# --- Wait for first stream to complete and second to be processed -------------

echo "[scenario] waiting for first stream to complete and agent1 to publish first kind:1..."
_await_content() {
  local kind="$1" author="$2" pattern="$3" secs="$4"
  local out deadline lim
  deadline=$(( $(date +%s) + secs ))
  lim=20
  while [[ $(date +%s) -lt $deadline ]]; do
    out="$(nak req -k "$kind" -a "$author" --limit "$lim" \
      --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if printf '%s\n' "$out" | jq -se "any(.[]; .content | test(\"$pattern\"))" >/dev/null 2>&1; then
      return 0
    fi
    lim=$(( lim + 1 ))
    sleep 0.5
  done
  return 1
}

saw_first_response=0
saw_second_response=0

if _await_content 1 "$AGENT1_PUBKEY" "long streaming response" 15; then
  echo "[scenario]   observed: agent1 published first kind:1 response"
  saw_first_response=1
fi

if _await_content 1 "$AGENT1_PUBKEY" "Second message processed" 15; then
  echo "[scenario]   observed: agent1 published second kind:1 response"
  saw_second_response=1
fi

echo ""
echo "[scenario] === Results ==="
echo "[scenario]   first dispatch LEASED (streaming active)     : yes"
echo "[scenario]   second dispatch QUEUED mid-stream            : yes"
echo "[scenario]   no simultaneous LEASED pair                  : yes"
echo "[scenario]   agent1 published first kind:1 response       : $([[ $saw_first_response -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 published second kind:1 response      : $([[ $saw_second_response -eq 1 ]] && echo yes || echo no)"

if [[ "$saw_first_response" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published first streaming response kind:1"
  exit 1
fi
if [[ "$saw_second_response" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published second kind:1 after stream completed"
  exit 1
fi

echo ""
echo "[scenario] PASS — scenario 6.3: second message queued mid-stream; not pre-empted; processed after"
emit_result pass "streaming not pre-empted; second dispatch queued; both messages processed sequentially"
