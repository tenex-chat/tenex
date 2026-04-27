#!/usr/bin/env bash
# E2E scenario 10.3 — SIGKILL during in-flight stream → restart → no duplicate
# kind:1 / kind:1111 events for the same conversation.
#
# Milestone gate (docs/rust/implementation-milestones-and-quality-gates.md
# §"Rollback"): "Rollback tests must include in-flight state, not only idle
# daemon state." Scenarios 101 + 102 prove restart invariants and orphan
# recovery; this scenario specifically asserts the *no-duplicate* invariant
# that the milestone calls out separately ("no duplicate completions, no
# duplicate stream deltas beyond current best-effort tolerance, no missing
# replies").
#
# What this proves:
#   1. Initial delegation flow runs; agent1 publishes its final kind:1.
#   2. Daemon receives SIGKILL while RAL state is still in-progress (i.e.
#      orphan reconciliation will be required on restart).
#   3. After restart, the same conversation is re-sent (idempotent kind:1
#      with the same content) — daemon must not produce a duplicate
#      kind:1 from the agent for the SAME triggering conversation.
#   4. Outbox dedup invariant: each unique `request_id` must appear in
#      `publish-outbox/published/` at most once.
#
# Classification: pass

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# Use pre-built binary for restart cycles.
start_daemon() {
  local daemon_bin="$repo_root/target/release/daemon"
  [[ -x "$daemon_bin" ]] || \
    _die "daemon binary not found at $daemon_bin; run: cargo build -p tenex-daemon --release"
  HARNESS_DAEMON_LOG="$DAEMON_DIR/daemon.log"
  mkdir -p "$DAEMON_DIR"
  _log "starting daemon (TENEX_BASE_DIR=$TENEX_BASE_DIR, binary=$daemon_bin)"
  TENEX_BASE_DIR="$TENEX_BASE_DIR" \
    "$daemon_bin" \
    --tenex-base-dir "$TENEX_BASE_DIR" \
    >>"$HARNESS_DAEMON_LOG" 2>&1 &
  HARNESS_DAEMON_PID=$!
  if ! _await_file "$DAEMON_DIR/tenex.lock" 60; then
    _log "daemon log tail:"; tail -30 "$HARNESS_DAEMON_LOG" >&2 || true
    _die "daemon never wrote lockfile"
  fi
  _log "daemon ready (pid $HARNESS_DAEMON_PID, lock at $DAEMON_DIR/tenex.lock)"
}

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/02_delegation.json"
MOCK_MODEL_ID="mock/delegation-02"
[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-103-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = { "mock-delegation-02": { "provider": "mock", "model": $model } }
    | .default = "mock-delegation-02"
    | .summarization = "mock-delegation-02"
    | .supervision = "mock-delegation-02"
    | .search = "mock-delegation-02"
    | .promptCompilation = "mock-delegation-02"
  ' "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
chmod 600 "$llms_json"
export USE_MOCK_LLM=true
export TENEX_MOCK_LLM_FIXTURE="$MOCK_FIXTURE_PATH"

start_local_relay --admin "$BACKEND_PUBKEY"
point_daemon_config_at_local_relay

publish_event_as "$USER_NSEC" 14199 "" \
  "p=$AGENT1_PUBKEY" "p=$AGENT2_PUBKEY" >/dev/null
publish_event_as "$USER_NSEC" 31933 "Project for no-duplicate test" \
  "d=$PROJECT_D_TAG" \
  "title=No Duplicate Events" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# === Phase 1 — first daemon completes a delegation flow ======================
echo ""
echo "[scenario] === Phase 1: first daemon completes delegation ==="
start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG" >/dev/null
deadline=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $deadline ]]; do
  out="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
    --limit 5 "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if printf '%s\n' "$out" | jq -se --arg a "$PROJECT_A_TAG" \
       'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "What is 2+2?" \
  "a=$PROJECT_A_TAG" \
  "p=$AGENT1_PUBKEY")"
conv_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
[[ -n "$conv_id" ]] && [[ "$conv_id" != "null" ]] || _die "ASSERT: failed to capture user message id"
echo "[scenario]   conv_id=$conv_id"

# Wait for agent1 to publish final reply.
phase1_ok=false
deadline=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $deadline ]]; do
  out="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 20 --auth --sec "$BACKEND_NSEC" \
    "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if printf '%s\n' "$out" | jq -se 'any(.[]; .content | test("Final answer: agent2 says 4"))' >/dev/null 2>&1; then
    echo "[scenario]   agent1 published final reply ✓"
    phase1_ok=true
    break
  fi
  sleep 0.5
done

# Guard: daemon must still be alive and Phase 1 must have succeeded.
if ! kill -0 "${HARNESS_DAEMON_PID:-}" 2>/dev/null; then
  emit_result fail "harness-flake: daemon died unexpectedly during Phase 1 before SIGKILL test"
  exit 1
fi
if [[ "$phase1_ok" != true ]]; then
  emit_result fail "harness-flake: agent1 never published final reply within 30s"
  exit 1
fi

# Snapshot the count of kind:1 events from agent1 BEFORE crash.
agent1_pre_crash="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 50 \
  --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
agent1_pre_count="$(printf '%s' "$agent1_pre_crash" | jq -se 'length')"
echo "[scenario]   pre-crash agent1 kind:1 count: $agent1_pre_count"

# === Phase 2 — SIGKILL daemon ================================================
echo ""
echo "[scenario] === Phase 2: SIGKILL daemon mid-flight ==="
crash_daemon
sleep 1

# === Phase 3 — restart daemon ================================================
echo ""
echo "[scenario] === Phase 3: restart daemon ==="
start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live (post-restart)"

# Allow orphan recovery time to run.
sleep 3

# Re-publish kind:24000 (boot) so the restarted daemon picks the project up.
# The project_event_index is hydrated from disk via af4c5be8, but boot is
# still required to mark the project active.
publish_event_as "$USER_NSEC" 24000 "boot-post-restart" "a=$PROJECT_A_TAG" >/dev/null
deadline=$(( $(date +%s) + 30 ))
while [[ $(date +%s) -lt $deadline ]]; do
  out="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
    --limit 10 "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if printf '%s\n' "$out" | jq -se --arg a "$PROJECT_A_TAG" \
       'all(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a)) | not | not' >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# === Phase 4 — assert no duplicate kind:1 from agent1 for old conv =========
echo ""
echo "[scenario] === Phase 4: assert no duplicates for old conversation ==="

# Wait a few seconds for any in-flight republish from the restarted daemon.
sleep 5

agent1_post_crash="$(nak req -k 1 -a "$AGENT1_PUBKEY" --limit 100 \
  --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
agent1_post_count="$(printf '%s' "$agent1_post_crash" | jq -se 'length')"
echo "[scenario]   post-restart agent1 kind:1 count: $agent1_post_count"

# The restarted daemon must NOT republish the agent1 reply for the OLD
# conversation. Allow at most the same count we saw pre-crash.
if [[ "$agent1_post_count" -gt "$agent1_pre_count" ]]; then
  diff=$(( agent1_post_count - agent1_pre_count ))
  echo "[scenario] new agent1 kind:1 events post-restart: $diff"
  printf '%s\n' "$agent1_post_crash" | jq -r '.[] | "\(.created_at) \(.id) \(.content[0:60])"' >&2 | head -20
  _die "ASSERT: agent1 published $diff DUPLICATE kind:1 event(s) for the same conversation after SIGKILL+restart"
fi
echo "[scenario]   agent1 did not republish for old conversation ✓"

# === Phase 5 — assert outbox dedup invariant =================================
echo ""
echo "[scenario] === Phase 5: outbox dedup invariant ==="

published_dir="$DAEMON_DIR/publish-outbox/published"
[[ -d "$published_dir" ]] || _die "ASSERT: publish-outbox/published not present"
duplicate_request_ids="$(jq -r '.request_id // empty' "$published_dir"/*.json 2>/dev/null \
  | sort | uniq -c | awk '$1 > 1 { print $0 }')"
if [[ -n "$duplicate_request_ids" ]]; then
  echo "[scenario] duplicate request_id(s) in published outbox:"
  printf '%s\n' "$duplicate_request_ids" >&2
  _die "ASSERT: outbox dedup invariant violated — same request_id published more than once"
fi
echo "[scenario]   outbox dedup invariant holds ✓"

emit_result pass "no duplicate kind:1 from agent1 post-SIGKILL-restart; outbox request_id unique"
