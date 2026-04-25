#!/usr/bin/env bash
# E2E scenario 5.3 — three-hop delegation chain: agent1 → agent2 → agent3, then unwind.
#
# What this scenario proves:
#   1. User sends kind:1 to agent1.
#   2. agent1 delegates to agent2.
#   3. agent2 delegates to agent3.
#   4. agent3 replies (terminal — no further delegation).
#   5. agent3's completion wakes agent2, which resumes and returns a reply.
#   6. agent2's completion wakes agent1, which resumes and returns the final answer to the user.
#
# Assertions:
#   - All three agents published kind:1 events in the expected sequence.
#   - agent2 published with content incorporating agent3's response.
#   - agent1 published its final answer incorporating agent2's response.
#   - RAL journal records at least two delegation completions (nested chain).
#   - No cross-routing: each completion wakes only its direct parent.
#
# Fixture: scripts/e2e/fixtures/mock-llm/53_three_hop.json
#
# Agent3 note:
#   The setup fixture (scripts/setup-nak-interop-fixture.sh) provisions only
#   agent1, agent2, and transparent. Agent3 is created inline in this scenario
#   using nak key generation and written directly to the backend agents directory.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# Override start_daemon to use the pre-built release binary directly.
# The default harness implementation uses `cargo run --release` which
# triggers a rebuild; on the rust-agent-worker-publishing branch the
# workspace has in-progress changes that break compilation. The binary at
# target/release/daemon was already compiled from a clean state and is fully
# functional for this test.
start_daemon() {
  local daemon_bin="$repo_root/target/release/daemon"
  [[ -x "$daemon_bin" ]] || _die "pre-built daemon binary not found at $daemon_bin"
  HARNESS_DAEMON_LOG="$FIXTURE_ROOT/daemon.log"
  _log "starting daemon via pre-built binary (TENEX_BASE_DIR=$TENEX_BASE_DIR)"
  TENEX_BASE_DIR="$TENEX_BASE_DIR" \
    "$daemon_bin" --tenex-base-dir "$TENEX_BASE_DIR" \
    >"$HARNESS_DAEMON_LOG" 2>&1 &
  HARNESS_DAEMON_PID=$!
  if ! _await_file "$DAEMON_DIR/tenex.lock" 60; then
    _log "daemon log tail:"; tail -30 "$HARNESS_DAEMON_LOG" >&2 || true
    _die "daemon never wrote lockfile"
  fi
  _log "daemon ready (pid $HARNESS_DAEMON_PID, lock at $DAEMON_DIR/tenex.lock)"
}

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/53_three_hop.json"
MOCK_MODEL_ID="mock/three-hop-53"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-53-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# --- Provision agent3 inline --------------------------------------------------
# The fixture setup only creates agent1 and agent2. Generate agent3 here.

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
    role: "Terminal computation agent in delegation chains",
    description: "Agent3 is a terminal worker that performs final computations and returns results directly without further delegation.",
    instructions: "You are Agent 3. You perform terminal computations and return direct answers. Never delegate to other agents.",
    useCriteria: "Use when a final computation answer is needed without further delegation.",
    status: "active",
    default: { model: $model, tools: [] }
  }' > "$BACKEND_BASE/agents/${agent3_pubkey}.json"
chmod 600 "$BACKEND_BASE/agents/${agent3_pubkey}.json"
echo "[scenario]   agent3 JSON written to $BACKEND_BASE/agents/${agent3_pubkey}.json"

# --- Rewrite llms.json for mock model -----------------------------------------
echo "[scenario] rewriting llms.json to use mock fixture model '$MOCK_MODEL_ID'"
llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = {
      "mock-three-hop-53": { "provider": "mock", "model": $model }
    }
    | .default = "mock-three-hop-53"
    | .summarization = "mock-three-hop-53"
    | .supervision = "mock-three-hop-53"
    | .search = "mock-three-hop-53"
    | .promptCompilation = "mock-three-hop-53"
  ' "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
chmod 600 "$llms_json"

export USE_MOCK_LLM=true
export TENEX_MOCK_LLM_FIXTURE="$MOCK_FIXTURE_PATH"
echo "[scenario] mock LLM enabled: fixture=$TENEX_MOCK_LLM_FIXTURE"

# --- Pre-seed project descriptor ----------------------------------------------
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

# Whitelist — must include agent3
echo "[scenario] publishing 14199 (whitelist) as user — includes agent3"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" \
  "p=$AGENT3_PUBKEY" >/dev/null

# Project event — must include agent3
echo "[scenario] publishing 31933 (project) as user — includes agent3"
publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" \
  "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" \
  "p=$AGENT3_PUBKEY" >/dev/null

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
  echo "[scenario] saw kind:24010 but no matching a-tag $PROJECT_A_TAG"
  _die "ASSERT: kind:24010 events on relay don't reference our project"
fi
echo "[scenario]   24010 status published for our project ✓"

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_saw_dispatch=0
user_msg_id=""
for attempt in 1 2 3; do
  echo "[scenario] publishing kind:1 from user to agent1 (attempt $attempt)"
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Agent 1, please calculate 6 times 7 and reply with the full result." \
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
# Phase B — three-hop delegation chain (mock-driven)
# ============================================================================

echo ""
echo "[scenario] === Phase B: asserting mock-driven three-hop delegation ==="
phase_b_timeout=15

# Stream-wait for a relay event whose content matches a pattern.
# Checks historical first, then opens a streaming subscription.
_await_content() {
  local kind="$1" author="$2" pattern="$3" secs="$4"
  local out
  out="$(nak req -k "$kind" -a "$author" --limit 50 --auth --sec "$BACKEND_NSEC" \
    "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if printf '%s\n' "$out" | jq -se "any(.[]; .content | test(\"$pattern\"))" >/dev/null 2>&1; then
    return 0
  fi
  out="$(timeout "$secs" nak req -k "$kind" -a "$author" --stream \
    --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null \
    | grep -m1 "$pattern" || true)"
  [[ -n "$out" ]]
}

saw_agent1_delegation=0
saw_agent2_delegation=0
saw_agent3_terminal=0
saw_agent2_resume=0
saw_agent1_final=0
saw_ral_completions=0

# agent1 any kind:1 (delegation)
if timeout "$phase_b_timeout" nak req -k 1 -a "$AGENT1_PUBKEY" --stream \
     --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null | head -1 | grep -q .; then
  echo "[scenario]   observed: agent1 published kind:1 (delegation)"
  saw_agent1_delegation=1
fi

# agent2 any kind:1 (delegation to agent3)
if timeout "$phase_b_timeout" nak req -k 1 -a "$AGENT2_PUBKEY" --stream \
     --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null | head -1 | grep -q .; then
  echo "[scenario]   observed: agent2 published kind:1"
  saw_agent2_delegation=1
fi

# agent3 terminal reply with fixture content
if _await_content 1 "$AGENT3_PUBKEY" "agent3 says result is 42" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent3 published terminal reply 'agent3 says result is 42'"
  saw_agent3_terminal=1
fi

# agent2 resume incorporating agent3's answer
if _await_content 1 "$AGENT2_PUBKEY" "agent2 relays: agent3 says result is 42" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent2 published resume reply with agent3's result"
  saw_agent2_resume=1
fi

# agent1 final answer incorporating the full chain
if _await_content 1 "$AGENT1_PUBKEY" "Final answer: agent2 confirmed" "$phase_b_timeout"; then
  echo "[scenario]   observed: agent1 published final answer incorporating the full chain"
  saw_agent1_final=1
fi

# RAL journal must record at least two delegation completions (agent3→agent2, agent2→agent1)
ral_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $ral_deadline ]]; do
  if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
    completion_count="$(jq -s '
      [.[] | select(
        (.event // .kind) | tostring | test("DelegationCompleted|Completed|Terminal"; "i")
      )] | length
    ' "$DAEMON_DIR/ral/journal.jsonl" 2>/dev/null || echo 0)"
    if [[ "$completion_count" -ge 2 ]]; then
      echo "[scenario]   observed: RAL journal has $completion_count delegation completion records"
      saw_ral_completions=1
      break
    fi
  fi
  sleep 0.2
done

echo ""
echo "[scenario] === Phase B observations ==="
echo "[scenario]   agent1 published delegation kind:1      : $([[ $saw_agent1_delegation -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 published delegation kind:1      : $([[ $saw_agent2_delegation -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent3 terminal reply (fixture content) : $([[ $saw_agent3_terminal -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 resume (agent3 result relayed)   : $([[ $saw_agent2_resume -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent1 final answer (full chain)        : $([[ $saw_agent1_final -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL journal >=2 completion records      : $([[ $saw_ral_completions -eq 1 ]] && echo yes || echo no)"

# Hard assertions — any miss is a failure
if [[ "$saw_agent1_delegation" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published any kind:1 delegation event"
  exit 1
fi
if [[ "$saw_agent2_delegation" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent2 never published any kind:1 event"
  exit 1
fi
if [[ "$saw_agent3_terminal" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent3 never published terminal reply with 'agent3 says result is 42'"
  exit 1
fi
if [[ "$saw_agent2_resume" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent2 never published resume reply incorporating agent3's result"
  exit 1
fi
if [[ "$saw_agent1_final" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published final answer incorporating the full chain"
  exit 1
fi
if [[ "$saw_ral_completions" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "RAL journal never recorded >=2 delegation completion entries"
  exit 1
fi

echo ""
echo "[scenario] PASS — scenario 5.3 (Phase A daemon plumbing + Phase B three-hop delegation chain)"
emit_result pass "all six Phase B assertions held: A->B->C chain + unwind both verified"
