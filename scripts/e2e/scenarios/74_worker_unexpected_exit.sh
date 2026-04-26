#!/usr/bin/env bash
# E2E scenario 7.4 — Worker unexpected exit (non-zero / SIGKILL).
#
# A custom worker boots successfully, signals execution_started, then sleeps.
# The harness sends SIGKILL to the worker process. The daemon's frame pump
# detects EOF (MessageChannelClosed) and logs the session error. The daemon
# itself must remain alive.
#
# Observable outcomes asserted:
#   1. Dispatch queue reaches "leased" (worker picked up the task).
#   2. Worker process is running (pid captured from daemon log).
#   3. Worker is SIGKILLed externally.
#   4. Daemon log records the session error within 10s of the kill.
#   5. Daemon process remains alive after the worker crash.
#   6. No Rust panic in daemon log.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

LONG_RUNNING_WORKER="$repo_root/scripts/e2e/test-workers/long-running.sh"
[[ -x "$LONG_RUNNING_WORKER" ]] || \
  _die "long-running worker not executable at $LONG_RUNNING_WORKER"

DAEMON_BIN="$repo_root/target/release/daemon"
[[ -x "$DAEMON_BIN" ]] || \
  _die "daemon binary not found at $DAEMON_BIN; run: cargo build -p tenex-daemon --release"

start_daemon() {
  HARNESS_DAEMON_LOG="$DAEMON_DIR/daemon.log"
  mkdir -p "$DAEMON_DIR"
  _log "starting daemon with long-running worker"
  TENEX_BASE_DIR="$TENEX_BASE_DIR" \
  BUN_BIN="$LONG_RUNNING_WORKER" \
    "$DAEMON_BIN" \
    --tenex-base-dir "$TENEX_BASE_DIR" \
    >>"$HARNESS_DAEMON_LOG" 2>&1 &
  HARNESS_DAEMON_PID=$!
  if ! _await_file "$DAEMON_DIR/tenex.lock" 60; then
    _log "daemon log tail:"; tail -30 "$HARNESS_DAEMON_LOG" >&2 || true
    _die "daemon never wrote lockfile"
  fi
  _log "daemon ready (pid $HARNESS_DAEMON_PID)"
}

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-74-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

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

publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

publish_event_as "$USER_NSEC" 31933 "Unexpected exit test project" \
  "d=$PROJECT_D_TAG" \
  "title=Unexpected Exit Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

_queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] publishing kind:24000 (boot)"
publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG" >/dev/null

echo "[scenario] publishing kind:1 to trigger worker spawn"
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "hello agent, please work" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
echo "[scenario]   user message id=$user_msg_id"

# Assert 1: dispatch reaches "leased" — the worker has the task.
echo "[scenario] waiting for dispatch to reach leased..."
leased_deadline=$(( $(date +%s) + 20 ))
saw_leased=0
while [[ $(date +%s) -lt $leased_deadline ]]; do
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
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: dispatch never reached 'leased' state within 20s"
fi
echo "[scenario]   dispatch reached 'leased' (worker is running) ✓"

# Assert 2: capture worker pid from the daemon log or pgrep.
# The long-running worker is a python3 process started by the sh script.
worker_pid=""
pid_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $pid_deadline ]]; do
  # The worker logs its pid as part of the workerId in the ready frame which
  # the daemon records. Grep the daemon log for "long-running-worker-<pid>".
  worker_pid="$(grep -oE 'long-running-worker-[0-9]+' "$DAEMON_DIR/daemon.log" 2>/dev/null \
    | head -1 | grep -oE '[0-9]+' | tail -1 || true)"
  [[ -n "$worker_pid" ]] && break
  sleep 0.2
done

if [[ -z "$worker_pid" ]]; then
  # Fall back to pgrep for the python3 process.
  worker_pid="$(pgrep -f "long-running.sh" 2>/dev/null | head -1 || true)"
fi

if [[ -z "$worker_pid" ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: could not determine worker pid"
fi
echo "[scenario]   worker pid=$worker_pid ✓"

# Assert 3: kill the worker with SIGKILL.
echo "[scenario] sending SIGKILL to worker (pid $worker_pid)..."
kill -9 "$worker_pid" 2>/dev/null || true
echo "[scenario]   worker killed ✓"

# Assert 4: daemon logs the session error within 10s.
echo "[scenario] waiting for session error in daemon log..."
error_deadline=$(( $(date +%s) + 10 ))
saw_session_error=0
while [[ $(date +%s) -lt $error_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -qE "session returned error|worker frame receive failed|MessageChannelClosed|worker stdout reader stopped" \
       "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_session_error=1
    break
  fi
  sleep 0.2
done

if [[ "$saw_session_error" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon log does not contain session error within 10s of worker kill"
fi
echo "[scenario]   session error logged ✓"

# Assert 5: daemon still alive.
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  tail -30 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon process died after worker unexpected exit"
fi
echo "[scenario]   daemon process still alive ✓"

# Assert 6: no panic.
if grep -qE "thread '.*' panicked|panicked at" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon log contains a Rust panic after worker unexpected exit"
fi
echo "[scenario]   no Rust panic in daemon log ✓"

echo ""
echo "[scenario] PASS — scenario 7.4 Worker unexpected exit"
emit_result pass "daemon survives worker SIGKILL; session error logged; no panic"
