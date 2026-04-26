#!/usr/bin/env bash
# E2E scenario 7.9 — Frame size cap (1 MiB).
#
# A custom worker boots successfully, reads the execute message, then emits
# a frame whose declared payload length exceeds AGENT_WORKER_MAX_PAYLOAD_BYTES
# (1 MiB minus the 4-byte length prefix). The daemon's stdout reader detects
# the oversized declaration without allocating the buffer, returns a
# FramePayloadTooLarge error, and the session loop logs the error.
#
# Observable outcomes asserted:
#   1. Dispatch queue reaches "leased" (worker was admitted).
#   2. Daemon log records the frame-size-cap error within 10s of admission.
#   3. Daemon process remains alive after rejecting the oversized frame.
#   4. No Rust panic in daemon log.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

OVERSIZED_FRAME_WORKER="$repo_root/scripts/e2e/test-workers/oversized-frame.sh"
[[ -x "$OVERSIZED_FRAME_WORKER" ]] || \
  _die "oversized-frame worker not executable at $OVERSIZED_FRAME_WORKER"

DAEMON_BIN="$repo_root/target/release/daemon"
[[ -x "$DAEMON_BIN" ]] || \
  _die "daemon binary not found at $DAEMON_BIN; run: cargo build -p tenex-daemon --release"

start_daemon() {
  HARNESS_DAEMON_LOG="$DAEMON_DIR/daemon.log"
  mkdir -p "$DAEMON_DIR"
  _log "starting daemon with oversized-frame worker"
  TENEX_BASE_DIR="$TENEX_BASE_DIR" \
  BUN_BIN="$OVERSIZED_FRAME_WORKER" \
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

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-79-$(date +%s)-$$"
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

publish_event_as "$USER_NSEC" 31933 "Frame size cap test project" \
  "d=$PROJECT_D_TAG" \
  "title=Frame Size Cap Test" \
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
  "hello agent" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
echo "[scenario]   user message id=$user_msg_id"

# Assert 1: dispatch reaches "leased" — worker was admitted.
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
echo "[scenario]   dispatch reached 'leased' ✓"

# Assert 2: frame size error logged within 10s.
echo "[scenario] waiting for frame-size error in daemon log..."
error_deadline=$(( $(date +%s) + 10 ))
saw_frame_error=0
while [[ $(date +%s) -lt $error_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -qE "session returned error|frame payload exceeds maximum|FramePayloadTooLarge|worker frame receive failed" \
       "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_frame_error=1
    break
  fi
  sleep 0.2
done

if [[ "$saw_frame_error" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon log does not contain frame-size error within 10s"
fi
echo "[scenario]   frame-size-cap error logged ✓"

# Assert 3: daemon still alive.
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  tail -30 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon process died after oversized frame rejection"
fi
echo "[scenario]   daemon process still alive ✓"

# Assert 4: no panic.
if grep -qE "thread '.*' panicked|panicked at" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon log contains a Rust panic after oversized frame"
fi
echo "[scenario]   no Rust panic in daemon log ✓"

echo ""
echo "[scenario] PASS — scenario 7.9 Frame size cap"
emit_result pass "daemon rejects oversized frame; session error logged; no panic"
