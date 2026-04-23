#!/usr/bin/env bash
# E2E scenario 5.1 — agent1 delegates to agent2, agent2 responds, agent1 continues.
#
# Runs the daemon against a local relay with real Ollama. The test has two
# phases:
#
#   Phase A — deterministic daemon plumbing (must pass):
#     - Daemon starts and authenticates as admin to the local relay
#     - Project boot via kind:24000 is recorded in booted-projects.json
#     - kind:1 from user mentioning agent1 triggers a dispatch in the queue
#     - Daemon publishes kind:24010 project status within a bounded window
#
#   Phase B — best-effort LLM behavior (logged, not asserted):
#     - agent1 invokes the `delegate` tool for agent2 (depends on the LLM
#       choosing to delegate — we override the agent's instructions below to
#       push it toward delegation, but with a small local model this is not
#       guaranteed)
#     - agent2 replies, agent1 resumes, full turn completes
#
# Phase B is observed and reported, but the test reports PASS if Phase A
# passes. See "== Phase B =" at the end. If you want deterministic Phase B
# assertions, replace the Ollama model with one that reliably invokes tools,
# or stub the agent worker.
#
# Requires: ollama running at $OLLAMA_BASE_URL (default http://localhost:11434)
# with the model configured in the fixture (qwen3.5) pulled.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Preflight: ollama reachable? --------------------------------------------
OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
if ! curl -fsS --max-time 3 "$OLLAMA_BASE_URL/api/tags" >/dev/null 2>&1; then
  echo "[scenario] SKIP — Ollama not reachable at $OLLAMA_BASE_URL"
  echo "[scenario] Start ollama ('ollama serve') and pull qwen3.5, then rerun."
  exit 77  # conventional skip code
fi

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Override agent1/agent2 instructions to push toward a delegation path.
# These overrides land before the daemon starts, so they're read at boot.
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

# Admin on the relay = backend. Agents and user are whitelisted via a 14199
# that user publishes below (admin-level events aren't enough to let broadcasts
# reach the daemon for events authored by the user/agents; whitelisting is
# needed for the live broadcast path for non-ephemeral kinds).
start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT

point_daemon_config_at_local_relay

# Publish a kind:14199 from user that whitelists user + all three agents +
# backend. This mirrors production: the project owner's client publishes a
# 14199 listing their backend and agents.
echo "[scenario] publishing 14199 (whitelist) as user"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# Publish kind:31933 (project definition). We need to include the agents as
# p-tags so the daemon knows which agents belong to this project.
echo "[scenario] publishing 31933 (project) as user"
publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" \
  "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# --- Start daemon -------------------------------------------------------------
start_daemon

# ============================================================================
# Phase A — deterministic daemon plumbing
# ============================================================================

# Publish kind:24000 boot event for the project
echo "[scenario] publishing 24000 (boot) as user"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

# Assert: daemon records the project as booted
echo "[scenario] waiting for daemon to record project as booted..."
_booted_file="$DAEMON_DIR/booted-projects.json"
_deadline=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_booted_file" ]] && \
     jq -e --arg d "$PROJECT_D_TAG" \
       '.projects[]? | select(.projectDTag == $d)' "$_booted_file" \
       >/dev/null 2>&1; then
    echo "[scenario]   booted-projects.json contains project ✓"
    break
  fi
  sleep 0.5
done
if ! jq -e --arg d "$PROJECT_D_TAG" \
       '.projects[]? | select(.projectDTag == $d)' "$_booted_file" \
       >/dev/null 2>&1; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: project never recorded in $_booted_file"
fi

# Assert: daemon publishes a kind:24010 project status event within 15s
echo "[scenario] waiting for daemon to publish kind:24010 status..."
if await_kind_event 24010 "" "$BACKEND_PUBKEY" 15 >/dev/null; then
  echo "[scenario]   24010 status published ✓"
else
  _die "ASSERT: daemon did not publish kind:24010 status within 15s"
fi

# Publish kind:1 from user mentioning agent1 with the project a-tag
echo "[scenario] publishing kind:1 from user to agent1"
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "Agent 1, please find out what 2+2 equals and reply." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
echo "[scenario]   user message id=$user_msg_id"

# Assert: daemon creates a dispatch record for the user's message
echo "[scenario] waiting for daemon to enqueue a dispatch..."
_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_deadline=$(( $(date +%s) + 30 ))
_saw_dispatch=0
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
if [[ "$_saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch record referenced triggering event $user_msg_id"
fi
echo "[scenario]   dispatch enqueued ✓"

echo "[scenario] === Phase A complete: daemon plumbing OK ==="

# ============================================================================
# Phase B — best-effort LLM behavior observation
# ============================================================================

echo ""
echo "[scenario] === Phase B: observing LLM-driven delegation (best-effort) ==="

# Give the LLM up to 120s to process. With qwen3.5 on Mac this is usually
# enough for short turns.
phase_b_timeout=120
phase_b_deadline=$(( $(date +%s) + phase_b_timeout ))

# Track what we see
saw_agent1_delegation=0
saw_agent2_response=0
saw_agent1_resumption=0
saw_terminal_ral=0

while [[ $(date +%s) -lt $phase_b_deadline ]]; do
  # Did agent1 publish a kind:1 with a delegation-style tag?
  if [[ "$saw_agent1_delegation" -eq 0 ]] && \
     nak req -k 1 -a "$AGENT1_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
       "$HARNESS_RELAY_URL" 2>/dev/null | jq -se 'any' >/dev/null 2>&1; then
    echo "[scenario]   observed: agent1 published kind:1"
    saw_agent1_delegation=1
  fi

  # Did agent2 respond?
  if [[ "$saw_agent2_response" -eq 0 ]] && \
     nak req -k 1 -a "$AGENT2_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
       "$HARNESS_RELAY_URL" 2>/dev/null | jq -se 'any' >/dev/null 2>&1; then
    echo "[scenario]   observed: agent2 published kind:1"
    saw_agent2_response=1
  fi

  # Did the RAL journal record any DelegationRegistered or DelegationCompleted?
  if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
    if [[ "$saw_terminal_ral" -eq 0 ]] && \
       jq -e 'select((.event // .kind) | tostring | test("DelegationCompleted|Completed|Terminal"; "i"))' \
         "$DAEMON_DIR/ral/journal.jsonl" >/dev/null 2>&1; then
      echo "[scenario]   observed: RAL journal has a completion/terminal record"
      saw_terminal_ral=1
    fi
  fi

  # If we've seen everything, break early
  [[ "$saw_agent1_delegation" -eq 1 && "$saw_agent2_response" -eq 1 && "$saw_terminal_ral" -eq 1 ]] && break

  sleep 2
done

echo ""
echo "[scenario] === Phase B observations ==="
echo "[scenario]   agent1 published kind:1       : $([[ $saw_agent1_delegation -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 published kind:1       : $([[ $saw_agent2_response -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL journal saw completion    : $([[ $saw_terminal_ral -eq 1 ]] && echo yes || echo no)"

if [[ "$saw_agent2_response" -eq 1 && "$saw_terminal_ral" -eq 1 ]]; then
  echo "[scenario] Phase B: apparent delegation flow completed"
else
  echo "[scenario] Phase B: flow did NOT fully complete within ${phase_b_timeout}s"
  echo "[scenario]   This is expected if the LLM (qwen3.5) didn't invoke the delegate tool."
  echo "[scenario]   To make Phase B deterministic, use a tool-capable model or stub the worker."
  echo "[scenario]   daemon log at:  $HARNESS_DAEMON_LOG"
  echo "[scenario]   dispatch queue: $_queue"
  echo "[scenario]   RAL journal:    $DAEMON_DIR/ral/journal.jsonl"
fi

echo ""
echo "[scenario] PASS — scenario 5.1 Phase A (daemon plumbing). Phase B is best-effort."
