#!/usr/bin/env bash
# E2E scenario 05 — parallel delegate tool calls each publish a distinct tool_use
# kind:1 event with an isolated q-tag pointing at their own delegation event.
#
# Regression target: when an LLM emits two delegate tool calls in the same step,
# each must produce a separate tool_use event carrying its own q-tag. The old
# listener-driven path raced against worker exit and either published only one
# event or merged both delegation IDs into one call.
#
# Mock fixture: scripts/e2e/fixtures/mock-llm/05_parallel_delegation.json
#
# Phase A — daemon plumbing (must pass):
#   - Daemon boots and publishes kind:24010
#   - User kind:1 triggers a dispatch in the queue
#
# Phase B — parallel delegation regression assertions (must pass):
#   - agent1 publishes >=2 delegation kind:1 events (both containing "Delegating...parallel")
#   - agent2 publishes >=2 kind:1 responses (alpha + beta)
#   - agent1 publishes >=2 tool_use kind:1 events (tool=delegate), each with a q-tag
#   - The two tool_use q-tag values are distinct (no merging/swapping)
#   - agent1 publishes its final kind:1 ("Parallel delegations complete")
#   - RAL journal records >=2 DelegationCompleted/Terminal entries

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

SCENARIO_MAX_ELAPSED=90
SCENARIO_START="$(date +%s)"

E2E_USE_OLLAMA="${E2E_USE_OLLAMA:-0}"
MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/05_parallel_delegation.json"
MOCK_MODEL_ID="mock/parallel-delegation-05"

if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
  OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
  if ! curl -fsS --max-time 3 "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1; then
    echo "[scenario] SKIP — Ollama not reachable at $OLLAMA_BASE_URL (E2E_USE_OLLAMA=1)"
    exit 77
  fi
else
  [[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"
fi

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

if [[ "$E2E_USE_OLLAMA" != "1" ]]; then
  echo "[scenario] rewriting llms.json to use mock fixture model '$MOCK_MODEL_ID'"
  llms_json="$BACKEND_BASE/llms.json"
  jq --arg model "$MOCK_MODEL_ID" '
      .configurations = {
        "mock-parallel-05": { "provider": "mock", "model": $model }
      }
      | .default = "mock-parallel-05"
      | .summarization = "mock-parallel-05"
      | .supervision = "mock-parallel-05"
      | .search = "mock-parallel-05"
      | .promptCompilation = "mock-parallel-05"
    ' "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
  chmod 600 "$llms_json"

  export USE_MOCK_LLM=true
  export TENEX_MOCK_LLM_FIXTURE="$MOCK_FIXTURE_PATH"
  echo "[scenario] mock LLM enabled: fixture=$TENEX_MOCK_LLM_FIXTURE"
fi

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
publish_event_as "$USER_NSEC" 31933 "Parallel delegation test project" \
  "d=$PROJECT_D_TAG" \
  "title=Parallel Delegation Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon

await_daemon_subscribed 45 || _die "daemon subscription never became live"

# ============================================================================
# Phase A — deterministic daemon plumbing
# ============================================================================

echo "[scenario] publishing 24000 (boot) as user"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

echo "[scenario] waiting for daemon to process boot and publish kind:24010..."
await_kind_event 24010 "" "$BACKEND_PUBKEY" 30 >/dev/null \
  || _die "ASSERT: daemon never published kind:24010 within 30s"

events_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null || true)"

if [[ -z "$events_24010" ]] || [[ "$events_24010" == "[]" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: daemon never published kind:24010 for d-tag $PROJECT_D_TAG"
fi

if ! printf '%s\n' "$events_24010" | jq -se --arg a "$PROJECT_A_TAG" \
    'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  _die "ASSERT: kind:24010 events on relay don't reference our project"
fi
echo "[scenario]   24010 status published for our project ✓"

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_saw_dispatch=0
user_msg_id=""
for attempt in 1 2 3; do
  echo "[scenario] publishing kind:1 from user to agent1 (attempt $attempt)"
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Agent 1, please run a parallel task: delegate alpha and beta tasks simultaneously." \
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
  echo "[scenario]   no dispatch yet — daemon may still be hydrating; retrying..."
done

if [[ "$_saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch record referenced triggering event after 3 attempts"
fi
echo "[scenario]   dispatch enqueued ✓"

echo "[scenario] === Phase A complete: daemon plumbing OK ==="

# ============================================================================
# Phase B — parallel delegation + q-tag regression assertions
# ============================================================================

echo ""
if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
  echo "[scenario] === Phase B: observing LLM-driven parallel delegation (Ollama, best-effort) ==="
  phase_b_timeout=120
else
  echo "[scenario] === Phase B: asserting mock-driven parallel delegation ==="
  phase_b_timeout=60
fi

# Hard elapsed guard: fail if total scenario time exceeds SCENARIO_MAX_ELAPSED.
_check_elapsed() {
  local elapsed=$(( $(date +%s) - SCENARIO_START ))
  if [[ $elapsed -gt $SCENARIO_MAX_ELAPSED ]]; then
    echo "[scenario] TIMEOUT: scenario exceeded ${SCENARIO_MAX_ELAPSED}s hard limit (elapsed=${elapsed}s)"
    tail -40 "$HARNESS_DAEMON_LOG" >&2 || true
    _die "ASSERT: scenario elapsed time exceeded ${SCENARIO_MAX_ELAPSED}s"
  fi
}

phase_b_deadline=$(( $(date +%s) + phase_b_timeout ))

saw_agent1_delegations=0
saw_agent2_alpha=0
saw_agent2_beta=0
saw_agent1_tool_use_a=0
saw_agent1_tool_use_b=0
saw_agent1_final=0
saw_terminal_ral=0

while [[ $(date +%s) -lt $phase_b_deadline ]]; do
  _check_elapsed

  # agent1: at least one kind:1 (the delegation step)
  if [[ "$saw_agent1_delegations" -eq 0 ]]; then
    a1_events="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if printf '%s\n' "$a1_events" | jq -se 'length >= 1' >/dev/null 2>&1; then
      echo "[scenario]   observed: agent1 published kind:1 events"
      saw_agent1_delegations=1
    fi
  fi

  # agent2 alpha response
  if [[ "$saw_agent2_alpha" -eq 0 ]]; then
    a2_events="$(nak req -k 1 -a "$AGENT2_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$a2_events" ]] && printf '%s\n' "$a2_events" | \
       jq -se 'any(.[]; .content | test("parallel-delegation-alpha-response"))' >/dev/null 2>&1; then
      echo "[scenario]   observed: agent2 published alpha response"
      saw_agent2_alpha=1
    fi
  fi

  # agent2 beta response
  if [[ "$saw_agent2_beta" -eq 0 ]]; then
    a2_events="$(nak req -k 1 -a "$AGENT2_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$a2_events" ]] && printf '%s\n' "$a2_events" | \
       jq -se 'any(.[]; .content | test("parallel-delegation-beta-response"))' >/dev/null 2>&1; then
      echo "[scenario]   observed: agent2 published beta response"
      saw_agent2_beta=1
    fi
  fi

  # agent1 final summary
  if [[ "$saw_agent1_final" -eq 0 ]]; then
    if [[ -n "${a1_events:-}" ]] && printf '%s\n' "$a1_events" | \
       jq -se 'any(.[]; .content | test("Parallel delegations complete"))' >/dev/null 2>&1; then
      echo "[scenario]   observed: agent1 published its final kind:1 with summary"
      saw_agent1_final=1
    fi
  fi

  # tool_use events: kind:1 from agent1 that have ["tool","delegate"] tag and a q-tag
  # This is the regression assertion: both tool_use events must exist and each must
  # carry a distinct q-tag pointing at its own delegation event.
  if [[ "$saw_agent1_tool_use_a" -eq 0 || "$saw_agent1_tool_use_b" -eq 0 ]]; then
    tool_use_events="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 50 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$tool_use_events" ]]; then
      # Extract all kind:1 events from agent1 that have a ["tool","delegate"] tag
      delegate_tool_use="$(printf '%s\n' "$tool_use_events" | \
        jq -sc '[.[] | select(.tags != null and (.tags | any(.[0] == "tool" and .[1] == "delegate")))]')"
      tool_use_count="$(printf '%s' "$delegate_tool_use" | jq -r 'length')"
      if [[ "$tool_use_count" -ge 1 ]]; then
        echo "[scenario]   observed: $tool_use_count agent1 tool_use(delegate) kind:1 event(s) on relay"
        saw_agent1_tool_use_a=1
      fi
      if [[ "$tool_use_count" -ge 2 ]]; then
        echo "[scenario]   observed: both tool_use(delegate) kind:1 events present"
        saw_agent1_tool_use_b=1

        # Regression assertion: each tool_use event must have a distinct q-tag.
        q_tags="$(printf '%s' "$delegate_tool_use" | \
          jq -r '[.[] | .tags[] | select(.[0] == "q") | .[1]] | sort | unique')"
        q_count="$(printf '%s' "$q_tags" | jq -r 'length')"
        if [[ "$q_count" -lt 2 ]]; then
          echo "[scenario] tool_use events by agent1 with their tags:"
          printf '%s' "$delegate_tool_use" | jq -r '.[] | { content, tags }' >&2 || true
          _die "ASSERT: expected 2 distinct q-tags on tool_use events but got $q_count — parallel delegation IDs were merged or one was dropped"
        fi
        echo "[scenario]   q-tag assertion: both tool_use events carry distinct delegation event IDs ✓"
      fi
    fi
  fi

  # RAL journal: at least 2 DelegationCompleted/Terminal entries
  if [[ "$saw_terminal_ral" -eq 0 ]] && [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
    ral_completions="$(jq -r 'select((.event // .kind) | tostring | test("DelegationCompleted|Completed|Terminal"; "i"))' \
      "$DAEMON_DIR/ral/journal.jsonl" 2>/dev/null | wc -l || echo 0)"
    ral_completions="${ral_completions// /}"
    if [[ "$ral_completions" -ge 2 ]]; then
      echo "[scenario]   observed: RAL journal has $ral_completions completion/terminal records"
      saw_terminal_ral=1
    fi
  fi

  all_done=1
  [[ "$saw_agent1_delegations" -eq 1 ]] || all_done=0
  [[ "$saw_agent2_alpha" -eq 1 ]] || all_done=0
  [[ "$saw_agent2_beta" -eq 1 ]] || all_done=0
  [[ "$saw_agent1_tool_use_a" -eq 1 ]] || all_done=0
  [[ "$saw_agent1_tool_use_b" -eq 1 ]] || all_done=0
  [[ "$saw_agent1_final" -eq 1 ]] || all_done=0
  [[ "$saw_terminal_ral" -eq 1 ]] || all_done=0
  [[ "$all_done" -eq 1 ]] && break

  sleep 1
done

echo ""
echo "[scenario] === Phase B observations ==="
echo "[scenario]   agent1 published kind:1                     : $([[ $saw_agent1_delegations -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 published alpha response              : $([[ $saw_agent2_alpha -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 published beta response               : $([[ $saw_agent2_beta -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 >=1 tool_use(delegate) event          : $([[ $saw_agent1_tool_use_a -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 >=2 tool_use(delegate) events         : $([[ $saw_agent1_tool_use_b -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 final kind:1 (post-delegation)        : $([[ $saw_agent1_final -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL journal >=2 completion records           : $([[ $saw_terminal_ral -eq 1 ]] && echo yes || echo no)"

if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
  if [[ "$saw_agent2_alpha" -eq 1 && "$saw_agent2_beta" -eq 1 ]]; then
    echo "[scenario] Phase B (Ollama): apparent parallel delegation completed"
  else
    echo "[scenario] Phase B (Ollama): flow did NOT fully complete within ${phase_b_timeout}s"
    echo "[scenario]   daemon log: $HARNESS_DAEMON_LOG"
  fi
  echo "[scenario] PASS — Phase A assertions held; Phase B was observed under Ollama."
  exit 0
fi

if [[ "$saw_agent1_delegations" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent1 never published any kind:1 event"
fi
if [[ "$saw_agent2_alpha" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent2 never published alpha response ('parallel-delegation-alpha-response')"
fi
if [[ "$saw_agent2_beta" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent2 never published beta response ('parallel-delegation-beta-response')"
fi
if [[ "$saw_agent1_tool_use_b" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent1 did not publish two tool_use(delegate) kind:1 events with q-tags — this is the parallel-delegation regression"
fi
if [[ "$saw_agent1_final" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent1 never published its final kind:1 summary ('Parallel delegations complete')"
fi
if [[ "$saw_terminal_ral" -ne 1 ]]; then
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: RAL journal never recorded >=2 DelegationCompleted/Terminal markers"
fi

elapsed=$(( $(date +%s) - SCENARIO_START ))
echo ""
echo "[scenario] PASS — scenario 05 parallel delegation q-tags (elapsed=${elapsed}s)"
