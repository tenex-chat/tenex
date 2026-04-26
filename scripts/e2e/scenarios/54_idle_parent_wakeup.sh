#!/usr/bin/env bash
# E2E scenario 5.4 — idle-parent wakeup: child completion arrives after parent
# finished its LLM turn and entered WaitingForDelegation (no active worker).
#
# Specification (docs/E2E_TEST_SCENARIOS.md §5.4):
#   agent1 has finished its turn (idle / WaitingForDelegation) when the child
#   completion arrives. The daemon spawns a NEW agent1 worker with the
#   completion injected. agent1's prior turn is NOT re-executed.
#
# What this scenario asserts:
#   1. agent1 publishes a delegation kind:1 (enters WaitingForDelegation).
#   2. agent2 publishes a kind:1 reply, triggering delegation completion.
#   3. Daemon journals DelegationCompleted for the parent RAL.
#   4. A SECOND dispatch record appears for agent1 (the resume dispatch).
#   5. agent1 publishes a final kind:1 incorporating agent2's response text.
#   6. No daemon panics.
#
# Fixture: scripts/e2e/fixtures/mock-llm/54_idle_parent_wakeup.json

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/54_idle_parent_wakeup.json"
MOCK_MODEL_ID="mock/idle-parent-54"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-54-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

echo "[scenario] rewriting llms.json to use mock fixture model '$MOCK_MODEL_ID'"
llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = {
      "mock-idle-parent-54": { "provider": "mock", "model": $model }
    }
    | .default = "mock-idle-parent-54"
    | .summarization = "mock-idle-parent-54"
    | .supervision = "mock-idle-parent-54"
    | .search = "mock-idle-parent-54"
    | .promptCompilation = "mock-idle-parent-54"
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
echo "[scenario] pre-seeded project descriptor at $desc_dir/project.json"

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT

point_daemon_config_at_local_relay

echo "[scenario] publishing 14199 (whitelist) as user"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

echo "[scenario] publishing 31933 (project) as user"
publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" \
  "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] publishing 24000 (boot) as user"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

echo "[scenario] waiting for daemon to publish kind:24010..."
await_kind_event 24010 "" "$BACKEND_PUBKEY" 30 >/dev/null \
  || _die "ASSERT: daemon never published kind:24010 within 30s"

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_saw_dispatch=0
user_msg_id=""
for attempt in 1 2 3; do
  echo "[scenario] publishing kind:1 from user to agent1 (attempt $attempt)"
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Please say hello to agent2 and relay the response back." \
    "p=$AGENT1_PUBKEY" \
    "a=$PROJECT_A_TAG")"
  user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
  echo "[scenario]   user message id=$user_msg_id"

  _deadline=$(( $(date +%s) + 15 ))
  while [[ $(date +%s) -lt $_deadline ]]; do
    if [[ -f "$_queue" ]] && \
       jq -e --arg e "$user_msg_id" \
         '(.triggeringEventId // .triggering_event_id) == $e' "$_queue" \
         >/dev/null 2>&1; then
      _saw_dispatch=1
      break
    fi
    sleep 0.2
  done
  [[ "$_saw_dispatch" -eq 1 ]] && break
  echo "[scenario]   no dispatch yet — retrying..."
done

if [[ "$_saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch record for triggering event after 3 attempts"
fi
echo "[scenario]   initial dispatch enqueued ✓"

# ============================================================================
# Phase B — assert delegation flow completes (idle-parent wakeup path)
# ============================================================================

echo ""
echo "[scenario] === Phase B: idle-parent wakeup ==="
phase_b_timeout=20

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

saw_agent1_delegation=0
saw_agent2_response=0
saw_agent1_resume=0
saw_ral_completion=0
saw_second_dispatch=0

# agent1 published kind:1 (delegation)
if _await_content 1 "$AGENT1_PUBKEY" "Delegating" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent1 published delegation kind:1"
  saw_agent1_delegation=1
fi

# agent2 replied with fixture content
if _await_content 1 "$AGENT2_PUBKEY" "hello-from-agent2" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent2 published kind:1 with 'hello-from-agent2'"
  saw_agent2_response=1
fi

# agent1 final kind:1 (resumed after idle-parent wakeup)
if _await_content 1 "$AGENT1_PUBKEY" "delegation complete" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent1 published resume kind:1 incorporating child response"
  saw_agent1_resume=1
fi

# RAL journal: DelegationCompleted record
ral_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $ral_deadline ]]; do
  if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]] && \
     jq -e 'select((.event // .kind) | tostring | test("DelegationCompleted|Completed"; "i"))' \
       "$DAEMON_DIR/ral/journal.jsonl" >/dev/null 2>&1; then
    echo "[scenario]   observed: RAL journal has DelegationCompleted record"
    saw_ral_completion=1
    break
  fi
  sleep 0.2
done

# Dispatch queue: at least 2 dispatches for agent1 (initial + resume)
dispatch_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $dispatch_deadline ]]; do
  if [[ -f "$_queue" ]]; then
    agent1_dispatch_count="$(jq -s --arg p "$AGENT1_PUBKEY" \
      '[.[] | select((.ral.agentPubkey // .agentPubkey // .agent_pubkey) == $p)] | length' \
      "$_queue" 2>/dev/null || echo 0)"
    if [[ "$agent1_dispatch_count" -ge 2 ]]; then
      echo "[scenario]   observed: dispatch queue has $agent1_dispatch_count records for agent1 (initial + resume)"
      saw_second_dispatch=1
      break
    fi
  fi
  sleep 0.2
done

echo ""
echo "[scenario] === Phase B results ==="
echo "[scenario]   agent1 published delegation kind:1  : $([[ $saw_agent1_delegation -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 replied (hello-from-agent2)  : $([[ $saw_agent2_response -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 resumed (idle-parent wakeup) : $([[ $saw_agent1_resume -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL DelegationCompleted recorded    : $([[ $saw_ral_completion -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   resume dispatch enqueued (>=2 total): $([[ $saw_second_dispatch -eq 1 ]] && echo yes || echo no)"

if [[ "$saw_agent1_delegation" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published a delegation kind:1"
  exit 1
fi
if [[ "$saw_agent2_response" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent2 never published kind:1 with 'hello-from-agent2'"
  exit 1
fi
if [[ "$saw_agent1_resume" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published resume kind:1 after idle-parent wakeup"
  exit 1
fi
if [[ "$saw_ral_completion" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "RAL journal never recorded a DelegationCompleted entry"
  exit 1
fi
if [[ "$saw_second_dispatch" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "dispatch queue never showed >=2 records for agent1 (resume dispatch missing)"
  exit 1
fi

echo ""
echo "[scenario] PASS — scenario 5.4: idle-parent wakeup path verified"
emit_result pass "agent1 resumed from WaitingForDelegation via new dispatch after child completion"
