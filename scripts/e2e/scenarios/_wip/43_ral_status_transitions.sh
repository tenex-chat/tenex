#!/usr/bin/env bash
# E2E scenario 4.3 — RAL status class transitions.
#
# Proves that the RAL journal correctly records the full lifecycle of each RAL
# identity from allocation through a terminal state, using the same
# deterministic mock-LLM delegation fixture as scenario 02.
#
# What this asserts (filesystem-observable):
#   1. After a full delegation flow (A→B→A), journal.jsonl exists and is
#      non-empty.
#   2. Sequences are strictly monotonic in file order (sanity check; the
#      authoritative proof is in scenario 3.2).
#   3. Every RAL identity (projectId+agentPubkey+conversationId+ralNumber)
#      starts with an "allocated" event.
#   4. Every RAL identity ends in a terminal event: one of
#      completed | no_response | error | aborted | crashed.
#   5. The active-event types observed (allocated, claimed,
#      delegation_registered, waiting_for_delegation, delegation_completed,
#      delegation_killed) always precede the terminal event for each identity —
#      no active event appears after the terminal event in file order.
#   6. At least one identity passes through "claimed" (proves claim path ran).
#   7. At least one identity passes through "waiting_for_delegation" (proves
#      the delegation side of agent1 was exercised).
#   8. At least one identity reaches "completed" (non-error terminal; proves
#      the happy path ran end-to-end).
#
# Runs the same mock-LLM fixture as 02_delegation_a_to_b_to_a.sh.
# Phase A assertions (boot, dispatch enqueue) are duplicated here to give the
# journal a chance to accumulate records before we read it.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e/_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/02_delegation.json"
MOCK_MODEL_ID="mock/delegation-02"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-43-$(date +%s)-$$"
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
publish_event_as "$USER_NSEC" 31933 "RAL status transitions test" \
  "d=$PROJECT_D_TAG" \
  "title=RAL Status Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon

await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] publishing kind:24000 (boot)"
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
    "Agent 1, please find out what 2+2 equals and reply." \
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
    sleep 0.5
  done
  [[ "$_saw_dispatch" -eq 1 ]] && break
  echo "[scenario]   no dispatch yet — retrying..."
done

if [[ "$_saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch record referenced triggering event after 3 attempts"
fi
echo "[scenario]   dispatch enqueued ✓"

# ============================================================================
# Wait for mock-driven delegation flow to complete
# ============================================================================

echo ""
echo "[scenario] waiting for mock-driven delegation flow to complete (timeout=60s)..."
phase_b_deadline=$(( $(date +%s) + 60 ))

saw_agent2_response=0
saw_agent1_final=0
saw_terminal_ral=0

journal="$DAEMON_DIR/ral/journal.jsonl"

while [[ $(date +%s) -lt $phase_b_deadline ]]; do
  if [[ "$saw_agent2_response" -eq 0 ]]; then
    agent2_events="$(nak req -k 1 -a "$AGENT2_PUBKEY" --limit 10 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if printf '%s\n' "$agent2_events" | jq -se \
          'any(.[]; .content | test("agent2 says 4"))' >/dev/null 2>&1; then
      echo "[scenario]   observed: agent2 published kind:1 with fixture content"
      saw_agent2_response=1
    fi
  fi

  if [[ "$saw_agent1_final" -eq 0 ]]; then
    agent1_events="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
      "$HARNESS_RELAY_URL" 2>/dev/null || true)"
    if printf '%s\n' "$agent1_events" | jq -se \
          'any(.[]; .content | test("Final answer: agent2 says 4"))' >/dev/null 2>&1; then
      echo "[scenario]   observed: agent1 published its final kind:1"
      saw_agent1_final=1
    fi
  fi

  if [[ "$saw_terminal_ral" -eq 0 ]] && [[ -f "$journal" ]]; then
    if jq -e 'select(.event | test("completed|no_response|error|aborted|crashed"; "i"))' \
        "$journal" >/dev/null 2>&1; then
      echo "[scenario]   observed: RAL journal has a terminal record"
      saw_terminal_ral=1
    fi
  fi

  if [[ "$saw_agent2_response" -eq 1 && "$saw_agent1_final" -eq 1 && "$saw_terminal_ral" -eq 1 ]]; then
    break
  fi

  sleep 2
done

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
  _die "ASSERT: RAL journal never recorded a terminal event"
fi

echo "[scenario] delegation flow complete ✓"

# ============================================================================
# RAL journal assertions
# ============================================================================

echo ""
echo "[scenario] === RAL journal assertions ==="

[[ -f "$journal" ]] || _die "ASSERT: RAL journal does not exist at $journal"

total_records="$(grep -c . "$journal" 2>/dev/null || echo 0)"
echo "[scenario]   total journal records: $total_records"
[[ "$total_records" -ge 1 ]] || _die "ASSERT: journal is empty"

python3 - "$journal" <<'PY'
import json
import sys

journal_path = sys.argv[1]

TERMINAL_EVENTS = {"completed", "no_response", "error", "aborted", "crashed"}
ACTIVE_EVENTS = {
    "allocated", "claimed", "delegation_registered",
    "waiting_for_delegation", "delegation_completed", "delegation_killed",
}

records = []
with open(journal_path) as jf:
    for lineno, line in enumerate(jf, 1):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.exit(f"ASSERT: malformed JSON at line {lineno}: {exc}")
        records.append(rec)

if not records:
    sys.exit("ASSERT: journal has no parseable records")

# 1. Strictly monotonic sequences in file order
sequences = [r.get("sequence") for r in records]
for i in range(1, len(sequences)):
    if sequences[i] is None or sequences[i - 1] is None:
        sys.exit(f"ASSERT: missing sequence field at record index {i}")
    if sequences[i] <= sequences[i - 1]:
        sys.exit(
            f"ASSERT: non-monotonic sequence at index {i}: "
            f"seq[{i-1}]={sequences[i-1]}, seq[{i}]={sequences[i]}"
        )
print(f"[scenario]   sequences strictly monotonic: 1..{len(records)} ✓")

# Group records by RAL identity tuple
identity_events = {}
for rec in records:
    event_type = rec.get("event")
    if event_type is None:
        sys.exit("ASSERT: record missing 'event' field")

    project_id   = rec.get("projectId")
    agent_pubkey = rec.get("agentPubkey")
    conv_id      = rec.get("conversationId")
    ral_number   = rec.get("ralNumber")

    if any(v is None for v in (project_id, agent_pubkey, conv_id, ral_number)):
        sys.exit(
            f"ASSERT: record with event='{event_type}' missing identity fields "
            f"(projectId={project_id}, agentPubkey={agent_pubkey}, "
            f"conversationId={conv_id}, ralNumber={ral_number})"
        )

    key = (project_id, agent_pubkey, conv_id, ral_number)
    identity_events.setdefault(key, []).append(event_type)

print(f"[scenario]   distinct RAL identities observed: {len(identity_events)}")

# 2. Every identity starts with "allocated"
for key, events in identity_events.items():
    if events[0] != "allocated":
        sys.exit(
            f"ASSERT: identity {key} first event is '{events[0]}', expected 'allocated'"
        )
print("[scenario]   every identity starts with 'allocated' ✓")

# 3. Every identity ends in a terminal event
for key, events in identity_events.items():
    if events[-1] not in TERMINAL_EVENTS:
        sys.exit(
            f"ASSERT: identity {key} ends with '{events[-1]}' (not terminal); "
            f"full sequence: {events}"
        )
print("[scenario]   every identity ends in a terminal event ✓")

# 4. No active event appears after the terminal event for each identity
for key, events in identity_events.items():
    terminal_idx = next(i for i, e in enumerate(events) if e in TERMINAL_EVENTS)
    post_terminal = events[terminal_idx + 1:]
    active_after = [e for e in post_terminal if e in ACTIVE_EVENTS]
    if active_after:
        sys.exit(
            f"ASSERT: identity {key} has active events after terminal: "
            f"{active_after} (full sequence: {events})"
        )
print("[scenario]   no active events after terminal for any identity ✓")

# 5. At least one identity passes through "claimed"
saw_claimed = any("claimed" in evts for evts in identity_events.values())
if not saw_claimed:
    sys.exit("ASSERT: no identity ever transitioned through 'claimed'")
print("[scenario]   at least one identity claimed ✓")

# 6. At least one identity passes through "waiting_for_delegation"
saw_waiting = any("waiting_for_delegation" in evts for evts in identity_events.values())
if not saw_waiting:
    sys.exit("ASSERT: no identity ever reached 'waiting_for_delegation'")
print("[scenario]   at least one identity waited for delegation ✓")

# 7. At least one identity reaches "completed"
saw_completed = any(evts[-1] == "completed" for evts in identity_events.values())
if not saw_completed:
    sys.exit("ASSERT: no identity reached the 'completed' terminal state")
print("[scenario]   at least one identity completed ✓")

# Summary: print each identity's event sequence
print("[scenario]   event sequences per identity:")
for key, events in identity_events.items():
    _, agent_pubkey, _, ral_number = key
    agent_short = agent_pubkey[:12]
    print(f"[scenario]     ral={ral_number} agent={agent_short}...: {' → '.join(events)}")

print("[scenario]   all RAL status class transition assertions passed ✓")
PY

echo ""
echo "[scenario] PASS — scenario 4.3 (RAL status class transitions)"
emit_result pass "ral journal: valid sequences, all identities allocated→terminal, claimed+waiting_for_delegation+completed observed"
