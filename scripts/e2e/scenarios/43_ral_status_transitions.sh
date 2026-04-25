#!/usr/bin/env bash
# E2E scenario 4.3 — RAL status class transitions.
#
# Proves that the RAL journal correctly records the full lifecycle of each RAL
# identity from allocation through terminal states, using the same
# deterministic mock-LLM delegation fixture as scenario 02.
#
# What this asserts (filesystem-observable):
#   1. After a full delegation flow (A→B→A), journal.jsonl exists and is
#      non-empty.
#   2. Sequences are strictly monotonic in file order (sanity check; the
#      authoritative proof is in scenario 3.2).
#   3. Every RAL identity starts with an "allocated" event.
#   4. For any identity that reaches a terminal event (completed | no_response |
#      error | aborted | crashed), no active event appears after it in file
#      order — the terminal is final.
#   5. At least one identity passes through "claimed" (proves claim path ran).
#   6. At least one identity reaches "completed" (proves the happy-path
#      terminal ran end-to-end).
#   7. Status class classification is coherent: every event type observed is
#      one of the known RAL event types; no unknown events appear.
#
# Note on agent1's RAL: In the mock delegation fixture, agent1 registers
# multiple sub-delegations to agent2 and accumulates delegation_completed
# events. The fixture drives agent1 to publish its final kind:1 from within
# agent2's final resumed conversation, so agent1's own RAL identity may remain
# in a non-terminal active state at the end of the scenario. This is correct
# daemon behaviour: agent1's RAL stays alive until agent1's resumed worker
# concludes, which may happen outside the observable window. The assertions
# here therefore require that AT LEAST ONE identity reaches a terminal state,
# not that ALL do.
#
# Runs the same mock-LLM fixture as 02_delegation_a_to_b_to_a.sh.

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
    sleep 0.2
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

journal="$DAEMON_DIR/ral/journal.jsonl"

saw_agent2_response=0
saw_agent1_final=0
saw_terminal_ral=0

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
    if jq -se 'any(.[]; .event | test("^(completed|no_response|error|aborted|crashed)$"))' \
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
ALL_KNOWN_EVENTS = TERMINAL_EVENTS | ACTIVE_EVENTS

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

# 1. All event types are known
for rec in records:
    ev = rec.get("event")
    if ev not in ALL_KNOWN_EVENTS:
        sys.exit(f"ASSERT: unknown event type '{ev}' in record seq={rec.get('sequence')}")
print(f"[scenario]   all {len(records)} records use known event types ✓")

# 2. Strictly monotonic sequences in file order
sequences = [r.get("sequence") for r in records]
for i in range(1, len(sequences)):
    if sequences[i] is None or sequences[i - 1] is None:
        sys.exit(f"ASSERT: missing sequence field at record index {i}")
    if sequences[i] <= sequences[i - 1]:
        sys.exit(
            f"ASSERT: non-monotonic sequence at index {i}: "
            f"seq[{i-1}]={sequences[i-1]}, seq[{i}]={sequences[i]}"
        )
print(f"[scenario]   sequences strictly monotonic (1..{sequences[-1]}) ✓")

# Group records by RAL identity tuple (preserving file order)
identity_events = {}  # key -> list of (sequence, event_type)
for rec in records:
    ev = rec.get("event")
    project_id   = rec.get("projectId")
    agent_pubkey = rec.get("agentPubkey")
    conv_id      = rec.get("conversationId")
    ral_number   = rec.get("ralNumber")

    if any(v is None for v in (project_id, agent_pubkey, conv_id, ral_number)):
        sys.exit(
            f"ASSERT: record with event='{ev}' missing identity fields "
            f"(projectId={project_id}, agentPubkey={agent_pubkey}, "
            f"conversationId={conv_id}, ralNumber={ral_number})"
        )

    key = (project_id, agent_pubkey, conv_id, ral_number)
    identity_events.setdefault(key, []).append((rec["sequence"], ev))

print(f"[scenario]   distinct RAL identities observed: {len(identity_events)}")

# 3. Every identity starts with "allocated"
for key, seq_events in identity_events.items():
    first_ev = seq_events[0][1]
    if first_ev != "allocated":
        sys.exit(
            f"ASSERT: identity {key} first event is '{first_ev}', expected 'allocated'"
        )
print("[scenario]   every identity starts with 'allocated' ✓")

# 4. No active event appears after a terminal event for any identity
for key, seq_events in identity_events.items():
    terminal_indices = [i for i, (_, ev) in enumerate(seq_events) if ev in TERMINAL_EVENTS]
    if not terminal_indices:
        continue  # this identity hasn't terminated yet — that's allowed
    first_terminal_idx = terminal_indices[0]
    post_terminal = seq_events[first_terminal_idx + 1:]
    active_after = [(s, e) for s, e in post_terminal if e in ACTIVE_EVENTS]
    if active_after:
        _, agent_short = key[0], key[1][:12]
        events_only = [e for _, e in seq_events]
        sys.exit(
            f"ASSERT: identity agent={agent_short}... has active events after terminal: "
            f"{active_after} (full sequence: {events_only})"
        )
print("[scenario]   no active events after terminal event for any identity ✓")

# 5. At least one identity passes through "claimed"
saw_claimed = any(ev == "claimed" for _, evs in identity_events.items() for _, ev in evs)
if not saw_claimed:
    sys.exit("ASSERT: no identity ever transitioned through 'claimed'")
print("[scenario]   at least one identity claimed ✓")

# 6. At least one identity reaches "completed"
saw_completed = any(
    ev in TERMINAL_EVENTS for _, evs in identity_events.items() for _, ev in evs
    if ev == "completed"
)
if not saw_completed:
    sys.exit("ASSERT: no identity reached the 'completed' terminal state")
print("[scenario]   at least one identity completed ✓")

# 7. At least one identity participates in delegation
# (delegation_registered or delegation_completed appears)
saw_delegation = any(
    ev in {"delegation_registered", "delegation_completed", "waiting_for_delegation"}
    for _, evs in identity_events.items() for _, ev in evs
)
if not saw_delegation:
    sys.exit("ASSERT: no delegation events observed; delegation flow did not run")
print("[scenario]   delegation events present in journal ✓")

# Summary: print each identity's event sequence
print("[scenario]   event sequences per identity:")
for key, seq_events in identity_events.items():
    _, agent_pubkey, conv_id, ral_number = key
    agent_short = agent_pubkey[:12]
    conv_short = conv_id[:12]
    events_only = [e for _, e in seq_events]
    terminal_marker = " [TERMINAL]" if any(e in TERMINAL_EVENTS for e in events_only) else " [active]"
    print(
        f"[scenario]     ral={ral_number} agent={agent_short}... conv={conv_short}...: "
        f"{' → '.join(events_only)}{terminal_marker}"
    )

print("[scenario]   all RAL status class transition assertions passed ✓")
PY

echo ""
echo "[scenario] PASS — scenario 4.3 (RAL status class transitions)"
emit_result pass "ral journal: monotonic sequences, all identities start allocated, no active-after-terminal, claimed+completed+delegation observed"
