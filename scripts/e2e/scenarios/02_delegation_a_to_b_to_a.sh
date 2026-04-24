#!/usr/bin/env bash
# E2E scenario 5.1 — agent1 delegates to agent2, agent2 responds, agent1 continues.
#
# Runs the daemon against a local relay with the TENEX mock LLM by default.
# The mock is driven by a fixture at
# scripts/e2e/fixtures/mock-llm/02_delegation.json, so both phases are
# deterministic assertions:
#
#   Phase A — daemon plumbing (must pass):
#     - Daemon authenticates as admin to the local relay
#     - Project boot via kind:24000 is recorded (observed via kind:24010)
#     - kind:1 from user mentioning agent1 triggers a dispatch in the queue
#     - Daemon publishes kind:24010 project status within a bounded window
#
#   Phase B — mock-driven agent behaviour (must pass):
#     - agent1 publishes kind:1 (the delegation)
#     - agent2 publishes kind:1 (the reply with content "agent2 says 4")
#     - agent1 publishes its final kind:1 ("Final answer: agent2 says 4.")
#     - RAL journal carries at least one DelegationRegistered/Completed marker
#
# To run against real Ollama for diagnostics (non-deterministic, best-effort):
#     E2E_USE_OLLAMA=1 ./scripts/e2e/scenarios/02_delegation_a_to_b_to_a.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

E2E_USE_OLLAMA="${E2E_USE_OLLAMA:-0}"
MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/02_delegation.json"
MOCK_MODEL_ID="mock/delegation-02"

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
  # Repoint the fixture's llms.json to the mock model. The provider switch
  # happens at the factory layer (USE_MOCK_LLM=true); we still need the
  # default configuration to declare the modelId the fixture expects, so
  # MockProvider.createModel() accepts it.
  echo "[scenario] rewriting llms.json to use mock fixture model '$MOCK_MODEL_ID'"
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
  echo "[scenario] mock LLM enabled: fixture=$TENEX_MOCK_LLM_FIXTURE"
fi

# Under Ollama we still override agent instructions to nudge delegation.
# Under the mock they're not needed (the mock ignores instructions) but
# they do no harm — we just keep the behaviour symmetric.
if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
  echo "[scenario] overriding agent1/agent2 instructions for delegation test"
  _override_agent_instructions() {
    local pubkey="$1" new_instructions="$2"
    local f="$BACKEND_BASE/agents/$pubkey.json"
    jq --arg s "$new_instructions" '.instructions = $s' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  }
  _override_agent_instructions "$AGENT1_PUBKEY" \
    "You are Agent 1. Agent 2 is available and its npub is known to the system. When you receive ANY message from the user, you MUST call the delegate tool to forward the message to Agent 2 verbatim. Do not reply directly. After Agent 2 responds, relay the response back."
  _override_agent_instructions "$AGENT2_PUBKEY" \
    "You are Agent 2. When you receive a message, respond with exactly: 'agent2 received: <one sentence summary>'. Do not delegate. Complete the turn immediately."
fi

# Pre-seed the per-project descriptor at <TENEX_BASE_DIR>/projects/<d_tag>/project.json
# (separate from the project content dir under projectsBase). Without this, the
# daemon's first ingestion of the kind:31933 event errors with "failed to prepare
# project repository on boot" and tears down its relay subscription.
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

# --- Start daemon -------------------------------------------------------------
start_daemon

await_daemon_subscribed 45 || _die "daemon subscription never became live"

# ============================================================================
# Phase A — deterministic daemon plumbing
# ============================================================================

echo "[scenario] publishing 24000 (boot) as user"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

echo "[scenario] waiting 8s for daemon to process boot and publish kind:24010..."
sleep 8

echo "[scenario] querying for kind:24010 from backend..."
events_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null || true)"

if [[ -z "$events_24010" ]] || [[ "$events_24010" == "[]" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: daemon never published kind:24010 for d-tag $PROJECT_D_TAG"
fi

if ! printf '%s\n' "$events_24010" | jq -se --arg a "$PROJECT_A_TAG" \
    'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  echo "[scenario] saw kind:24010 but no matching a-tag $PROJECT_A_TAG"
  _die "ASSERT: kind:24010 events on relay don't reference our project"
fi
echo "[scenario]   24010 status published for our project ✓ (proves boot was recorded)"

echo "[scenario] waiting 5s for project-agent membership to hydrate..."
sleep 5

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_saw_dispatch=0
user_msg_id=""
for attempt in 1 2 3; do
  echo "[scenario] publishing kind:1 from user to agent1 (attempt $attempt)"
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Agent 1, please find out what 2+2 equals and reply." \
    "p=$AGENT1_PUBKEY" \
    "a=$PROJECT_A_TAG")"
  user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
  echo "[scenario]   user message id=$user_msg_id"

  echo "[scenario] waiting up to 15s for daemon to enqueue dispatch..."
  _deadline=$(( $(date +%s) + 15 ))
  while [[ $(date +%s) -lt $_deadline ]]; do
    if [[ -f "$_queue" ]] && \
       jq -e --arg e "$user_msg_id" \
         '(.triggeringEventId // .triggering_event_id) == $e' "$_queue" \
         >/dev/null 2>&1; then
      _saw_dispatch=1
      break
    fi
    sleep 0.5
  done
  [[ "$_saw_dispatch" -eq 1 ]] && break
  echo "[scenario]   no dispatch yet — daemon may still be hydrating; retrying..."
done

if [[ "$_saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  echo "[scenario] last few inbound-ignored entries:"
  grep -E "inbound nostr event ignored" "$DAEMON_DIR/daemon.log" 2>/dev/null | tail -5 >&2 || true
  _die "ASSERT: no dispatch record referenced triggering event after 3 attempts"
fi
echo "[scenario]   dispatch enqueued ✓"

echo "[scenario] === Phase A complete: daemon plumbing OK ==="

# ============================================================================
# Phase B — mock-driven delegation (or Ollama best-effort when E2E_USE_OLLAMA=1)
# ============================================================================

echo ""
if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
  echo "[scenario] === Phase B: observing LLM-driven delegation (Ollama, best-effort) ==="
  phase_b_timeout=120
else
  echo "[scenario] === Phase B: asserting mock-driven delegation ==="
  phase_b_timeout=60
fi

phase_b_deadline=$(( $(date +%s) + phase_b_timeout ))

saw_agent1_delegation=0
saw_agent2_response=0
saw_agent1_final=0
saw_terminal_ral=0

while [[ $(date +%s) -lt $phase_b_deadline ]]; do
  if [[ "$saw_agent1_delegation" -eq 0 ]] && \
     nak req -k 1 -a "$AGENT1_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
       "$HARNESS_RELAY_URL" 2>/dev/null | jq -se 'any' >/dev/null 2>&1; then
    echo "[scenario]   observed: agent1 published kind:1"
    saw_agent1_delegation=1
  fi

  if [[ "$saw_agent2_response" -eq 0 ]]; then
    agent2_events="$(nak req -k 1 -a "$AGENT2_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$agent2_events" ]] && [[ "$agent2_events" != "[]" ]]; then
      if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
        echo "[scenario]   observed: agent2 published kind:1"
        saw_agent2_response=1
      elif printf '%s\n' "$agent2_events" | jq -se \
            'any(.[]; .content | test("agent2 says 4"))' >/dev/null 2>&1; then
        echo "[scenario]   observed: agent2 published kind:1 with fixture content 'agent2 says 4'"
        saw_agent2_response=1
      fi
    fi
  fi

  if [[ "$saw_agent1_final" -eq 0 ]]; then
    agent1_events="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$agent1_events" ]] && [[ "$agent1_events" != "[]" ]]; then
      if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
        # Ollama path: count any second agent1 kind:1 as "resumption".
        if printf '%s\n' "$agent1_events" | jq -se 'length >= 2' >/dev/null 2>&1; then
          echo "[scenario]   observed: agent1 published >=2 kind:1 events (resumption)"
          saw_agent1_final=1
        fi
      elif printf '%s\n' "$agent1_events" | jq -se \
            'any(.[]; .content | test("Final answer: agent2 says 4"))' >/dev/null 2>&1; then
        echo "[scenario]   observed: agent1 published its final kind:1 with fixture content"
        saw_agent1_final=1
      fi
    fi
  fi

  if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
    if [[ "$saw_terminal_ral" -eq 0 ]] && \
       jq -e 'select((.event // .kind) | tostring | test("DelegationCompleted|Completed|Terminal"; "i"))' \
         "$DAEMON_DIR/ral/journal.jsonl" >/dev/null 2>&1; then
      echo "[scenario]   observed: RAL journal has a completion/terminal record"
      saw_terminal_ral=1
    fi
  fi

  if [[ "$saw_agent1_delegation" -eq 1 && "$saw_agent2_response" -eq 1 \
        && "$saw_agent1_final" -eq 1 && "$saw_terminal_ral" -eq 1 ]]; then
    break
  fi

  sleep 2
done

echo ""
echo "[scenario] === Phase B observations ==="
echo "[scenario]   agent1 published kind:1           : $([[ $saw_agent1_delegation -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 replied with fixture text  : $([[ $saw_agent2_response -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 final kind:1 (post-delegation): $([[ $saw_agent1_final -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL journal completion record     : $([[ $saw_terminal_ral -eq 1 ]] && echo yes || echo no)"

if [[ "$E2E_USE_OLLAMA" == "1" ]]; then
  # Diagnostic mode — Ollama is non-deterministic, so only log Phase B outcomes.
  if [[ "$saw_agent2_response" -eq 1 && "$saw_terminal_ral" -eq 1 ]]; then
    echo "[scenario] Phase B (Ollama): apparent delegation flow completed"
  else
    echo "[scenario] Phase B (Ollama): flow did NOT fully complete within ${phase_b_timeout}s"
    echo "[scenario]   daemon log:     $HARNESS_DAEMON_LOG"
    echo "[scenario]   dispatch queue: $_queue"
    echo "[scenario]   RAL journal:    $DAEMON_DIR/ral/journal.jsonl"
  fi
  echo "[scenario] PASS — Phase A assertions held; Phase B was observed under Ollama."
  exit 0
fi

# Mock mode: hard _die on any Phase B miss.
if [[ "$saw_agent1_delegation" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent1 never published any kind:1 event"
fi
if [[ "$saw_agent2_response" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent2 never published kind:1 with fixture content 'agent2 says 4'"
fi
if [[ "$saw_agent1_final" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: agent1 never published its final kind:1 ('Final answer: agent2 says 4.')"
fi
if [[ "$saw_terminal_ral" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: RAL journal never recorded a DelegationCompleted/Terminal marker"
fi

echo ""
echo "[scenario] PASS — scenario 5.1 (Phase A daemon plumbing + Phase B mock-driven delegation)"
