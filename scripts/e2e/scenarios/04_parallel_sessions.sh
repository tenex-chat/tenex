#!/usr/bin/env bash
# E2E scenario 4 — two agent sessions run in parallel (temporally overlapping).
#
# What this scenario proves:
#   1. User sends kind:1 to agent1 (SESSION-ALPHA token) and agent2 (SESSION-BETA token)
#      in quick succession, before either completes.
#   2. The daemon enqueues both dispatches independently.
#   3. Both workers run in parallel — the RAL journal shows their [claimed, terminal]
#      windows overlap in wall-clock time.
#   4. agent1 publishes its expected kind:1 response containing "session-alpha result: 100".
#   5. agent2 publishes its expected kind:1 response containing "session-beta result: 200".
#
# Parallelism proof (Phase B):
#   From the RAL journal, extract the "claimed" timestamp (worker start) and the
#   terminal event timestamp (worker end) for each agent. Assert that:
#     agent1.claimed_at < agent2.terminal_at  AND
#     agent2.claimed_at < agent1.terminal_at
#   i.e. each worker started before the other finished.
#
# This is a direct regression guard for the removal of WorkerConcurrencyLimits
# (commit 2b2f4db1): with no global cap, two dispatches to distinct agents must
# execute concurrently, not sequentially.
#
# Phase A — deterministic daemon plumbing (must pass):
#   - Daemon authenticates and processes boot (kind:24010 published)
#   - Both kind:1 messages trigger dispatch-queue entries
#
# Phase B — mock-driven parallel execution (must pass):
#   - agent1 publishes kind:1 with fixture content "session-alpha result: 100"
#   - agent2 publishes kind:1 with fixture content "session-beta result: 200"
#   - RAL journal timestamps prove temporal overlap between the two workers

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/04_parallel_sessions.json"
MOCK_MODEL_ID="mock/parallel-04"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-04-$(date +%s)-$$"
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
      "mock-parallel-04": { "provider": "mock", "model": $model }
    }
    | .default = "mock-parallel-04"
    | .summarization = "mock-parallel-04"
    | .supervision = "mock-parallel-04"
    | .search = "mock-parallel-04"
    | .promptCompilation = "mock-parallel-04"
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
  _die "ASSERT: kind:24010 events on relay don't reference our project"
fi
echo "[scenario]   24010 status published for our project ✓"

# Publish both user messages in quick succession before either agent completes.
echo "[scenario] publishing kind:1 SESSION-ALPHA → agent1"
msg1_evt="$(publish_event_as "$USER_NSEC" 1 \
  "Hello SESSION-ALPHA: please compute result alpha for me." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
msg1_id="$(printf '%s' "$msg1_evt" | jq -r .id)"
echo "[scenario]   msg1 id=$msg1_id"

echo "[scenario] publishing kind:1 SESSION-BETA → agent2"
msg2_evt="$(publish_event_as "$USER_NSEC" 1 \
  "Hello SESSION-BETA: please compute result beta for me." \
  "p=$AGENT2_PUBKEY" \
  "a=$PROJECT_A_TAG")"
msg2_id="$(printf '%s' "$msg2_evt" | jq -r .id)"
echo "[scenario]   msg2 id=$msg2_id"

# Wait for both dispatches to appear in the queue.
_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
_saw_dispatch1=0
_saw_dispatch2=0

echo "[scenario] waiting up to 20s for both dispatches to be enqueued..."
_deadline=$(( $(date +%s) + 20 ))
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]]; then
    if [[ "$_saw_dispatch1" -eq 0 ]] && \
       jq -e --arg e "$msg1_id" \
         '(.triggeringEventId // .triggering_event_id) == $e' "$_queue" \
         >/dev/null 2>&1; then
      echo "[scenario]   SESSION-ALPHA dispatch enqueued ✓"
      _saw_dispatch1=1
    fi
    if [[ "$_saw_dispatch2" -eq 0 ]] && \
       jq -e --arg e "$msg2_id" \
         '(.triggeringEventId // .triggering_event_id) == $e' "$_queue" \
         >/dev/null 2>&1; then
      echo "[scenario]   SESSION-BETA dispatch enqueued ✓"
      _saw_dispatch2=1
    fi
  fi
  [[ "$_saw_dispatch1" -eq 1 && "$_saw_dispatch2" -eq 1 ]] && break
  sleep 0.5
done

if [[ "$_saw_dispatch1" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: SESSION-ALPHA dispatch never enqueued for event $msg1_id"
fi
if [[ "$_saw_dispatch2" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: SESSION-BETA dispatch never enqueued for event $msg2_id"
fi

echo "[scenario] === Phase A complete: both dispatches enqueued ==="

# ============================================================================
# Phase B — mock-driven parallel execution + temporal overlap proof
# ============================================================================

echo ""
echo "[scenario] === Phase B: asserting both sessions complete and ran in parallel ==="
phase_b_timeout=90
phase_b_deadline=$(( $(date +%s) + phase_b_timeout ))

saw_agent1_response=0
saw_agent2_response=0
saw_ral_terminals=0

while [[ $(date +%s) -lt $phase_b_deadline ]]; do
  if [[ "$saw_agent1_response" -eq 0 ]]; then
    agent1_events="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$agent1_events" ]] && [[ "$agent1_events" != "[]" ]]; then
      if printf '%s\n' "$agent1_events" | jq -se \
          'any(.[]; .content | test("session-alpha result: 100"))' >/dev/null 2>&1; then
        echo "[scenario]   observed: agent1 published kind:1 with 'session-alpha result: 100'"
        saw_agent1_response=1
      fi
    fi
  fi

  if [[ "$saw_agent2_response" -eq 0 ]]; then
    agent2_events="$(nak req -k 1 -a "$AGENT2_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if [[ -n "$agent2_events" ]] && [[ "$agent2_events" != "[]" ]]; then
      if printf '%s\n' "$agent2_events" | jq -se \
          'any(.[]; .content | test("session-beta result: 200"))' >/dev/null 2>&1; then
        echo "[scenario]   observed: agent2 published kind:1 with 'session-beta result: 200'"
        saw_agent2_response=1
      fi
    fi
  fi

  if [[ "$saw_ral_terminals" -eq 0 ]] && [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
    terminal_count="$(jq -s '[.[] | select(.event | test("completed|no_response|error|aborted|crashed"))] | length' \
      "$DAEMON_DIR/ral/journal.jsonl" 2>/dev/null || echo 0)"
    if [[ "$terminal_count" -ge 2 ]]; then
      echo "[scenario]   observed: RAL journal has $terminal_count terminal entries"
      saw_ral_terminals=1
    fi
  fi

  if [[ "$saw_agent1_response" -eq 1 && "$saw_agent2_response" -eq 1 \
        && "$saw_ral_terminals" -eq 1 ]]; then
    break
  fi

  sleep 2
done

echo ""
echo "[scenario] === Phase B observations ==="
echo "[scenario]   agent1 kind:1 (session-alpha result: 100) : $([[ $saw_agent1_response -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   agent2 kind:1 (session-beta result: 200)  : $([[ $saw_agent2_response -eq 1 ]] && echo yes || echo no)"
echo "[scenario]   RAL journal >=2 terminal entries           : $([[ $saw_ral_terminals -eq 1 ]] && echo yes || echo no)"

if [[ "$saw_agent1_response" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent1 never published kind:1 with 'session-alpha result: 100'"
  exit 1
fi
if [[ "$saw_agent2_response" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "agent2 never published kind:1 with 'session-beta result: 200'"
  exit 1
fi
if [[ "$saw_ral_terminals" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "RAL journal never recorded >=2 terminal entries"
  exit 1
fi

# ============================================================================
# Phase C — temporal overlap proof
#
# Parse the RAL journal and extract [claimed_at, terminal_at] windows for each
# agent. Assert that the windows overlap:
#   agent1.claimed_at < agent2.terminal_at  AND
#   agent2.claimed_at < agent1.terminal_at
#
# RAL journal fields used (from RalJournalRecord / RalJournalEvent):
#   .event       — snake_case tag: "claimed" | "completed" | "no_response" | ...
#   .timestamp   — unix milliseconds (set when daemon writes the record)
#   .agentPubkey — from flattened RalJournalIdentity
# ============================================================================

echo ""
echo "[scenario] === Phase C: proving temporal overlap from RAL journal ==="

_journal="$DAEMON_DIR/ral/journal.jsonl"
[[ -f "$_journal" ]] || _die "ASSERT: RAL journal missing at $_journal"

overlap_result="$(python3 - "$_journal" "$AGENT1_PUBKEY" "$AGENT2_PUBKEY" <<'PYEOF'
import json, sys

journal_path, pk1, pk2 = sys.argv[1], sys.argv[2], sys.argv[3]
TERMINAL = {"completed", "no_response", "error", "aborted", "crashed"}

sessions = {pk1: {}, pk2: {}}
with open(journal_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        pk = r.get("agentPubkey")
        if pk not in sessions:
            continue
        ev = r.get("event", "")
        ts = r["timestamp"]
        s = sessions[pk]
        if ev == "claimed" and "claimed" not in s:
            s["claimed"] = ts
        elif ev in TERMINAL and "terminal" not in s:
            s["terminal"] = ts

s1, s2 = sessions[pk1], sessions[pk2]
missing = []
for label, s in (("agent1", s1), ("agent2", s2)):
    if "claimed" not in s:
        missing.append(f"{label}: no claimed event")
    if "terminal" not in s:
        missing.append(f"{label}: no terminal event")
if missing:
    print("MISSING_DATA: " + "; ".join(missing))
    sys.exit(2)

a1_start, a1_end = s1["claimed"], s1["terminal"]
a2_start, a2_end = s2["claimed"], s2["terminal"]

if a1_start < a2_end and a2_start < a1_end:
    overlap_ms = min(a1_end, a2_end) - max(a1_start, a2_start)
    print(f"OVERLAP_MS={overlap_ms}")
    print(f"  agent1: [{a1_start}, {a1_end}] duration={a1_end - a1_start}ms")
    print(f"  agent2: [{a2_start}, {a2_end}] duration={a2_end - a2_start}ms")
    sys.exit(0)
else:
    print(f"NO_OVERLAP")
    print(f"  agent1: [{a1_start}, {a1_end}] duration={a1_end - a1_start}ms")
    print(f"  agent2: [{a2_start}, {a2_end}] duration={a2_end - a2_start}ms")
    sys.exit(1)
PYEOF
)"
overlap_exit=$?

echo "[scenario]   RAL overlap analysis:"
printf '%s\n' "$overlap_result" | sed 's/^/[scenario]     /'

if [[ $overlap_exit -eq 2 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "RAL journal missing claimed or terminal events: $overlap_result"
  exit 1
fi

if [[ $overlap_exit -ne 0 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  emit_result fail "workers did not run in parallel — no temporal overlap in RAL journal"
  exit 1
fi

echo "[scenario]   temporal overlap confirmed ✓"
echo ""
echo "[scenario] PASS — scenario 4 (both agents ran in parallel; RAL timestamps prove overlap)"
emit_result pass "parallel execution confirmed: RAL claimed→terminal windows overlap"
