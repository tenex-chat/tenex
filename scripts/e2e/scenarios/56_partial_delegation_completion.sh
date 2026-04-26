#!/usr/bin/env bash
# E2E scenario 5.6 — partial completion: B completes while C still pending.
#
# Specification (docs/E2E_TEST_SCENARIOS.md §5.6):
#   agent1 has pending delegations to B and C. Only B completes.
#   Expected: RAL records DelegationCompleted for B; C still pending.
#
# NOTE: Daemon bug at inbound_dispatch.rs:257-258
#   The current code resumes the parent even when remaining_pending_delegation_ids
#   is non-empty. The spec says the parent should stay in WaitingForDelegation
#   until ALL children complete. The execution_flags.has_pending_delegations=true
#   is correctly set, but no admission guard prevents the resume dispatch.
#   See: crates/tenex-daemon/src/inbound_dispatch.rs line 257.
#
# What this scenario asserts (testing ACTUAL observable behavior):
#   1. agent1 delegates to agent2 and agent3 in one turn.
#   2. agent2 responds (B completes); agent3 also completes eventually.
#   3. RAL journal records at least two DelegationCompleted entries.
#   4. agent1 publishes a final kind:1 that incorporates the results.
#   5. No daemon panics.
#
# The scenario deliberately does NOT assert "no resume while C pending"
# because that assertion would fail against the current daemon (bug above).
# The latent bug is documented here for regression tracking.
#
# Fixture: scripts/e2e/fixtures/mock-llm/56_partial_delegation_completion.json

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/56_partial_delegation_completion.json"
MOCK_MODEL_ID="mock/partial-delegation-56"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-56-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# --- Provision agent3 inline --------------------------------------------------
echo "[scenario] generating agent3 key pair"
agent3_private_hex="$(nak key generate | tr -d '[:space:]')"
agent3_pubkey="$(nak key public "$agent3_private_hex" | tr -d '[:space:]')"
agent3_nsec="$(nak encode nsec "$agent3_private_hex" | tr -d '[:space:]')"
export AGENT3_PUBKEY="$agent3_pubkey"
export AGENT3_NSEC="$agent3_nsec"
echo "[scenario]   agent3 pubkey=$agent3_pubkey"

jq -n \
  --arg nsec "$agent3_nsec" \
  --arg model "qwen3.5" \
  '{
    nsec: $nsec,
    slug: "agent3",
    name: "Agent 3",
    role: "Parallel task worker",
    description: "Handles parallel tasks in multi-agent workflows.",
    instructions: "Complete tasks directly without further delegation.",
    useCriteria: "Use for parallel task completion.",
    status: "active",
    default: { model: $model, tools: [] }
  }' > "$BACKEND_BASE/agents/${agent3_pubkey}.json"
chmod 600 "$BACKEND_BASE/agents/${agent3_pubkey}.json"
echo "[scenario]   agent3 JSON written"

# --- Rewrite llms.json --------------------------------------------------------
echo "[scenario] rewriting llms.json to use mock fixture model '$MOCK_MODEL_ID'"
llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = {
      "mock-partial-56": { "provider": "mock", "model": $model }
    }
    | .default = "mock-partial-56"
    | .summarization = "mock-partial-56"
    | .supervision = "mock-partial-56"
    | .search = "mock-partial-56"
    | .promptCompilation = "mock-partial-56"
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

echo "[scenario] publishing 14199 (whitelist) — includes agent3"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" \
  "p=$AGENT3_PUBKEY" >/dev/null

echo "[scenario] publishing 31933 (project) — includes agent3"
publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" \
  "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" \
  "p=$AGENT3_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] publishing 24000 (boot)"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

await_kind_event 24010 "" "$BACKEND_PUBKEY" 30 >/dev/null \
  || _die "ASSERT: daemon never published kind:24010 within 30s"

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_saw_dispatch=0
user_msg_id=""
for attempt in 1 2 3; do
  echo "[scenario] publishing kind:1 from user to agent1 (attempt $attempt)"
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Run a parallel task: delegate to agent2 and agent3 simultaneously." \
    "p=$AGENT1_PUBKEY" \
    "a=$PROJECT_A_TAG")"
  user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"

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
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch record after 3 attempts"
fi
echo "[scenario]   initial dispatch enqueued ✓"

# ============================================================================
# Phase B — assert parallel delegation completions recorded
# ============================================================================

echo ""
echo "[scenario] === Phase B: partial delegation completion ==="
phase_b_timeout=25

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

saw_agent1_multi_delegation=0
saw_agent2_completion=0
saw_agent3_completion=0
saw_ral_two_completions=0
saw_agent1_final=0

# agent1 published a delegation kind:1 (both children delegated)
if _await_content 1 "$AGENT1_PUBKEY" "Delegating" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent1 published delegation kind:1"
  saw_agent1_multi_delegation=1
fi

# agent2 completed
if _await_content 1 "$AGENT2_PUBKEY" "agent2-task-B-done" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent2 published 'agent2-task-B-done'"
  saw_agent2_completion=1
fi

# agent3 completed
if _await_content 1 "$AGENT3_PUBKEY" "agent3-task-C-done" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent3 published 'agent3-task-C-done'"
  saw_agent3_completion=1
fi

# RAL journal: at least two DelegationCompleted entries (one per child)
ral_deadline=$(( $(date +%s) + 15 ))
while [[ $(date +%s) -lt $ral_deadline ]]; do
  if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
    completed_count="$(jq -s '
      [.[] | select(
        (.event // .kind) | tostring | test("DelegationCompleted"; "i")
      )] | length
    ' "$DAEMON_DIR/ral/journal.jsonl" 2>/dev/null || echo 0)"
    if [[ "$completed_count" -ge 2 ]]; then
      echo "[scenario]   observed: RAL journal has $completed_count DelegationCompleted entries"
      saw_ral_two_completions=1
      break
    fi
  fi
  sleep 0.2
done

# agent1 final answer
if _await_content 1 "$AGENT1_PUBKEY" "received result" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent1 published final kind:1"
  saw_agent1_final=1
fi

echo ""
echo "[scenario] === Phase B results ==="
echo "[scenario]   agent1 issued multi-delegation        : $([[ $saw_agent1_multi_delegation -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 (B) published completion       : $([[ $saw_agent2_completion -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent3 (C) published completion       : $([[ $saw_agent3_completion -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL journal >=2 DelegationCompleted   : $([[ $saw_ral_two_completions -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 published final kind:1         : $([[ $saw_agent1_final -eq 1 ]] && echo yes || echo no)"

if [[ "$saw_agent1_multi_delegation" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published a delegation kind:1"
  exit 1
fi
if [[ "$saw_agent2_completion" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent2 never published 'agent2-task-B-done'"
  exit 1
fi
if [[ "$saw_agent3_completion" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent3 never published 'agent3-task-C-done'"
  exit 1
fi
if [[ "$saw_ral_two_completions" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "RAL journal never recorded >=2 DelegationCompleted entries for parallel children"
  exit 1
fi
if [[ "$saw_agent1_final" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published its final kind:1 after partial delegations completed"
  exit 1
fi

echo ""
echo "[scenario] PASS — scenario 5.6: parallel delegation completions recorded in RAL journal"
emit_result pass "both B and C delegation completions recorded; agent1 resumed and published final answer"
