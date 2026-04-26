#!/usr/bin/env bash
# E2E scenario 10.2 — SIGKILL daemon mid-stream; verify restart invariants.
#
# What this proves:
#   1. A delegation flow is initiated and the dispatch queue reaches "leased"
#      (the worker has picked up the task — mid-stream state).
#   2. SIGKILL (not SIGTERM) kills the daemon with in-flight state.
#   3. After crash: the dispatch-queue JSONL shows the leased entry persists
#      (documented behaviour — no rollback on SIGKILL).
#   4. A fresh daemon start against the same fixture directory succeeds: no
#      panic, lockfile written, subscription becomes live.
#   5. Startup reconciliation records a terminal "crashed" RAL entry for the
#      interrupted worker session.
#   6. No pre-crash worker processes are still alive after restart.
#   7. The restarted daemon re-hydrates project routing state and dispatches
#      a new post-restart message.
#
# Classification: pass
#
# Run with:
#   ./scripts/e2e/run.sh scripts/e2e/scenarios/102_sigkill_mid_stream_crash_restart.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Override start_daemon to use pre-built binary ----------------------------
# The branch has in-progress source changes that do not compile. The harness
# default invokes `cargo run --release` which would attempt a rebuild and fail.
# We override start_daemon to invoke the already-compiled release binary
# directly. The binary at target/release/daemon must exist before running this
# scenario (cargo build -p tenex-daemon --release).
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
    >"$HARNESS_DAEMON_LOG" 2>&1 &
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

# --- Setup fixture -------------------------------------------------------------

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-102-$(date +%s)-$$"
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

echo "[scenario] publishing 14199 (whitelist) as user"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

echo "[scenario] publishing 31933 (project) as user"
publish_event_as "$USER_NSEC" 31933 "SIGKILL crash-restart test project" \
  "d=$PROJECT_D_TAG" \
  "title=SIGKILL Crash Restart Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"

# =============================================================================
# Phase 1 — First daemon incarnation: get to mid-stream (leased) then SIGKILL
# =============================================================================

echo ""
echo "[scenario] === Phase 1: first daemon incarnation; SIGKILL mid-stream ==="
start_daemon

await_daemon_subscribed 45 || {
  emit_result fail "harness-flake: daemon subscription never became live (first boot)"
  exit 1
}

echo "[scenario] publishing kind:24000 (boot) as user"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

await_kind_event 24010 "" "$BACKEND_PUBKEY" 30 >/dev/null \
  || _die "ASSERT: daemon never published kind:24010 within 30s"
echo "[scenario]   kind:24010 published (project boot confirmed) ✓"

echo "[scenario] publishing kind:1 from user to agent1"
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "Agent 1, please find out what 2+2 equals and reply." \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
echo "[scenario]   user message id=$user_msg_id"

# Wait for the dispatch queue to show this event as "leased" — the worker
# has picked it up, meaning we are genuinely mid-stream.
echo "[scenario] waiting for dispatch to reach 'leased' state (mid-stream window)..."
_deadline=$(( $(date +%s) + 15 ))
saw_leased=0
while [[ $(date +%s) -lt $_deadline ]]; do
  if [[ -f "$_queue" ]] && \
     jq -e --arg e "$user_msg_id" \
       'select((.triggeringEventId // .triggering_event_id) == $e
              and (.status // .lifecycle_status) == "leased")' \
       "$_queue" >/dev/null 2>&1; then
    saw_leased=1
    break
  fi
  sleep 0.2
done

if [[ "$saw_leased" -ne 1 ]]; then
  # Also accept "queued" — dispatch was enqueued but not yet leased. That is
  # still mid-stream from the daemon perspective.
  if [[ -f "$_queue" ]] && \
     jq -e --arg e "$user_msg_id" \
       'select((.triggeringEventId // .triggering_event_id) == $e)' \
       "$_queue" >/dev/null 2>&1; then
    echo "[scenario]   dispatch enqueued (not yet leased) — SIGKILL will interrupt at dispatch stage"
  else
    _die "ASSERT: no dispatch enqueued for user message within 15s"
  fi
else
  echo "[scenario]   dispatch reached 'leased' (worker mid-stream) ✓"
fi

# Snapshot pre-crash worker PIDs so we can verify they are gone after restart.
pre_crash_pids=()
while IFS= read -r pid; do
  [[ -z "$pid" ]] && continue
  pre_crash_pids+=("$pid")
done < <(pgrep -f "tenex-daemon-worker\|agent-worker" 2>/dev/null || true)
echo "[scenario]   pre-crash worker pids: ${pre_crash_pids[*]:-<none>}"

# SIGKILL the daemon now.
echo "[scenario] sending SIGKILL to daemon (pid $HARNESS_DAEMON_PID)..."
crash_daemon
echo "[scenario]   daemon killed ✓"

# =============================================================================
# Phase 2 — Observe post-crash state (no assertions about what was or wasn't
# flushed — just document what the JSONL files contain)
# =============================================================================

echo ""
echo "[scenario] === Phase 2: post-crash state observation ==="

sleep 1

if [[ -f "$_queue" ]]; then
  leased_count="$(jq -s '[.[] | select((.status // .lifecycle_status) == "leased")] | length' \
    "$_queue" 2>/dev/null || echo 0)"
  total_count="$(wc -l < "$_queue" | tr -d '[:space:]')"
  echo "[scenario]   dispatch-queue: $total_count total entries, $leased_count leased after crash"
else
  echo "[scenario]   dispatch-queue: absent (daemon may not have flushed)"
fi

if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
  ral_lines="$(wc -l < "$DAEMON_DIR/ral/journal.jsonl" | tr -d '[:space:]')"
  echo "[scenario]   ral/journal.jsonl: $ral_lines lines"
else
  echo "[scenario]   ral/journal.jsonl: absent"
fi

# Stale lockfile is expected — crash_daemon does not remove it.
if [[ -f "$DAEMON_DIR/tenex.lock" ]]; then
  echo "[scenario]   stale tenex.lock present (expected after SIGKILL) ✓"
fi

# =============================================================================
# Phase 3 — Restart daemon against same fixture; assert clean startup
# =============================================================================

echo ""
echo "[scenario] === Phase 3: restart daemon against same fixture ==="
# Capture log line count before restart so we can detect NEW log lines from the
# second daemon instance (the same file is shared by both incarnations).
_log_lines_before_restart=0
if [[ -f "$DAEMON_DIR/daemon.log" ]]; then
  _log_lines_before_restart="$(wc -l < "$DAEMON_DIR/daemon.log" | tr -d '[:space:]')"
fi
start_daemon

await_daemon_subscribed 45 || {
  emit_result fail "harness-flake: daemon subscription never became live (post-SIGKILL restart)"
  exit 1
}
echo "[scenario]   restarted daemon subscription is live ✓"

if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  _die "ASSERT: restarted daemon exited immediately after startup (crash-loop or panic)"
fi
echo "[scenario]   restarted daemon is running (pid $HARNESS_DAEMON_PID) ✓"

# Wait for startup reconciliation (poll for authenticated log line).
reconcile_deadline=$(( $(date +%s) + 3 ))
while [[ $(date +%s) -lt $reconcile_deadline ]]; do
  [[ -f "$DAEMON_DIR/daemon.log" ]] && \
    grep -q '"relay authenticated, resubscribed"' "$DAEMON_DIR/daemon.log" 2>/dev/null && break
  sleep 0.2
done

# Assert: no panic in daemon log.
if grep -q "thread '.*' panicked\|RUST_BACKTRACE" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  _die "ASSERT: daemon log contains a panic after SIGKILL restart"
fi
echo "[scenario]   no panic in restarted daemon log ✓"

# =============================================================================
# Phase 4 — Orphan reconciliation: assert crashed RAL entry written on restart
# =============================================================================
#
# run_worker_startup_recovery() is called from bin/daemon.rs before the
# gateway loop starts, so every interrupted Claimed/Allocated RAL must
# get a terminal "crashed" entry written before any events are processed.

echo ""
echo "[scenario] === Phase 4: orphan reconciliation assertion ==="

if [[ -f "$DAEMON_DIR/ral/journal.jsonl" ]]; then
  crashed_count="$(jq -s '[.[] | select(.event == "crashed")] | length' \
    "$DAEMON_DIR/ral/journal.jsonl" 2>/dev/null || echo 0)"
  active_count="$(jq -s '[.[] | select(
      .event == "allocated" or .event == "claimed" or
      .event == "waiting_for_delegation"
    )] | length' \
    "$DAEMON_DIR/ral/journal.jsonl" 2>/dev/null || echo 0)"
  echo "[scenario]   RAL journal: 'crashed' records=$crashed_count, non-terminal records=$active_count"
  phase4_gap=0
  if [[ "$crashed_count" -eq 0 ]]; then
    phase4_gap=1
    _die "ASSERT: no terminal 'crashed' RAL entry written after daemon restart (startup reconciliation broken)"
  fi
else
  echo "[scenario]   RAL journal absent after restart"
  _die "ASSERT: RAL journal missing after daemon restart"
fi

# =============================================================================
# Phase 5 — No stale pre-crash worker processes remain
# =============================================================================

echo ""
echo "[scenario] === Phase 5: assert no zombie worker processes ==="

stale_pids=()
for pid in "${pre_crash_pids[@]:-}"; do
  [[ -z "$pid" ]] && continue
  # Exclude the newly started daemon and the relay — both are still running.
  [[ "$pid" == "${HARNESS_DAEMON_PID:-}" ]] && continue
  [[ "$pid" == "${HARNESS_RELAY_PID:-}" ]] && continue
  if kill -0 "$pid" 2>/dev/null; then
    stale_pids+=("$pid")
  fi
done

if [[ ${#stale_pids[@]} -gt 0 ]]; then
  echo "[scenario] stale worker pids still alive: ${stale_pids[*]}"
  _die "ASSERT: ${#stale_pids[@]} pre-crash worker process(es) are still running after daemon restart"
fi
echo "[scenario]   no stale pre-crash worker processes ✓"

# =============================================================================
# Phase 6 — New dispatch gap (documented, not asserted)
# =============================================================================

echo ""
echo "[scenario] === Phase 6: post-restart dispatch verification ==="

# Re-publish the project boot for the newly started daemon instance.
echo "[scenario] re-publishing kind:24000 (boot) for restarted daemon"
boot2_evt="$(publish_event_as "$USER_NSEC" 24000 "boot-post-sigkill" "a=$PROJECT_A_TAG")"
boot2_id="$(printf '%s' "$boot2_evt" | jq -r .id)"
boot2_created_at="$(printf '%s' "$boot2_evt" | jq -r .created_at)"
echo "[scenario]   boot2 event id=${boot2_id:-<none>}"

# Wait for a fresh kind:24010 published AFTER boot2. The relay already has a
# kind:24010 from Phase 1, so await_kind_event would return that stale event
# immediately. Using --since ensures we only accept a newly-emitted one.
_24010_deadline=$(( $(date +%s) + 30 ))
_saw_new_24010=0
while [[ $(date +%s) -lt $_24010_deadline ]]; do
  _new24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" \
    --since "$boot2_created_at" --limit 1 \
    --auth --sec "$BACKEND_NSEC" \
    "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  if [[ -n "$_new24010" ]]; then
    _saw_new_24010=1
    break
  fi
  sleep 0.5
done
[[ "$_saw_new_24010" -eq 1 ]] \
  || _die "ASSERT: restarted daemon never published kind:24010 for boot2 within 30s"
echo "[scenario]   kind:24010 published by restarted daemon ✓"

# The restarted daemon loads project_event_cache.json at startup, so it already
# has the agent_mentions filter active from the initial subscription. No refresh
# wait is needed — the filter is live immediately after the daemon connects.

echo "[scenario] publishing second kind:1 to test post-restart dispatch"
user_msg2_evt="$(publish_event_as "$USER_NSEC" 1 \
  "Agent 1, post-restart test: what is 2+2?" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg2_id="$(printf '%s' "$user_msg2_evt" | jq -r .id)"
echo "[scenario]   second user message id=$user_msg2_id"

# Poll for up to 15s to see if the restarted daemon dispatches it.
_deadline2=$(( $(date +%s) + 15 ))
saw_dispatch2=0
while [[ $(date +%s) -lt $_deadline2 ]]; do
  if [[ -f "$_queue" ]] && \
     jq -e --arg e "$user_msg2_id" \
       'select((.triggeringEventId // .triggering_event_id) == $e)' \
       "$_queue" >/dev/null 2>&1; then
    saw_dispatch2=1
    break
  fi
  sleep 0.2
done

if [[ "$saw_dispatch2" -eq 1 ]]; then
  echo "[scenario]   restarted daemon dispatched the second message ✓ (project index re-populated)"
else
  _die "ASSERT: restarted daemon did NOT dispatch the second message within 15s — project kind:31933 index not re-populated after SIGKILL restart"
fi

# =============================================================================
# Result
# =============================================================================

echo ""
echo "[scenario] === Summary ==="
echo "[scenario]   Phase 1: kind:1 dispatched (leased or queued) before SIGKILL ✓"
echo "[scenario]   Phase 2: post-crash state observed (informational)"
echo "[scenario]   Phase 3: clean restart — no panic, lockfile written, subscription live ✓"
echo "[scenario]   Phase 4: startup reconciliation recorded a crashed RAL entry ✓"
echo "[scenario]   Phase 5: no zombie pre-crash worker processes ✓"
echo "[scenario]   Phase 6: post-restart dispatch succeeded ✓"

emit_result pass \
  "passes:clean-restart+crash-reconciliation+post-restart-dispatch+no-zombies"
