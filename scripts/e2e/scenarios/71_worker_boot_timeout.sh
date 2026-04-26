#!/usr/bin/env bash
# E2E scenario 7.1 — Worker boot timeout.
#
# Configures the daemon with a 300ms boot timeout, then points the worker
# binary at a script that sleeps indefinitely without sending a ready frame.
# The daemon must detect the timeout, log the error, roll back the dispatch
# lease to queued, and remain alive for subsequent work.
#
# Observable outcomes asserted:
#   1. Daemon process remains alive throughout.
#   2. Daemon log contains the boot timeout error.
#   3. Daemon log does not contain a Rust panic.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

SLOW_BOOT_WORKER="$repo_root/scripts/e2e/test-workers/slow-boot.sh"
[[ -x "$SLOW_BOOT_WORKER" ]] || \
  _die "slow-boot worker not executable at $SLOW_BOOT_WORKER"

DAEMON_BIN="$repo_root/target/release/daemon"
[[ -x "$DAEMON_BIN" ]] || \
  _die "daemon binary not found at $DAEMON_BIN; run: cargo build -p tenex-daemon --release"

start_daemon() {
  HARNESS_DAEMON_LOG="$DAEMON_DIR/daemon.log"
  mkdir -p "$DAEMON_DIR"
  _log "starting daemon with slow-boot worker (boot timeout=300ms)"
  TENEX_BASE_DIR="$TENEX_BASE_DIR" \
  BUN_BIN="$SLOW_BOOT_WORKER" \
  TENEX_WORKER_BOOT_TIMEOUT_MS=300 \
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

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-71-$(date +%s)-$$"
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

publish_event_as "$USER_NSEC" 31933 "Boot timeout test project" \
  "d=$PROJECT_D_TAG" \
  "title=Boot Timeout Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] publishing kind:24000 (boot)"
publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG" >/dev/null

echo "[scenario] publishing kind:1 to trigger worker spawn"
publish_event_as "$USER_NSEC" 1 \
  "hello agent" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG" >/dev/null

# Wait for the daemon to attempt the worker spawn and log the boot timeout.
echo "[scenario] waiting for boot timeout error in daemon log..."
timeout_deadline=$(( $(date +%s) + 15 ))
saw_timeout=0
while [[ $(date +%s) -lt $timeout_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -q "admit_one_worker_dispatch_from_filesystem failed\|boot timed out\|BootTimeout\|worker boot timed out" \
       "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_timeout=1
    break
  fi
  sleep 0.3
done

# Assert 1: daemon still alive.
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  tail -30 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon process died after worker boot timeout"
fi
echo "[scenario]   daemon process still alive ✓"

# Assert 2: boot timeout logged.
if [[ "$saw_timeout" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon log does not contain boot timeout error within 15s"
fi
echo "[scenario]   boot timeout error logged ✓"

# Assert 3: no panic.
if grep -qE "thread '.*' panicked|panicked at" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon log contains a Rust panic after worker boot timeout"
fi
echo "[scenario]   no Rust panic in daemon log ✓"

echo ""
echo "[scenario] PASS — scenario 7.1 Worker boot timeout"
emit_result pass "daemon survives worker boot timeout; error logged; no panic"
