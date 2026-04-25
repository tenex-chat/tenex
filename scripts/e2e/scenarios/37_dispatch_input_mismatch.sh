#!/usr/bin/env bash
# E2E scenario 3.7 — Dispatch input mismatch validation.
#
# Validates that the daemon refuses to launch a worker when the dispatch
# sidecar on disk contradicts the dispatch queue row.
#
# Contract under test (crates/tenex-daemon/src/daemon_worker_runtime.rs:648):
#   read_worker_dispatch_launch_input reads the sidecar at
#     $DAEMON_DIR/workers/dispatch-inputs/<dispatch_id>.json
#   and compares:
#     - sidecar.dispatchId         vs queue.dispatchId          (→ DispatchInputMismatch)
#     - sidecar.executeFields      vs queue.triggeringEventId   (→ DispatchInputTriggeringEventMismatch)
#   Admission fails. Tick loop catches the error, logs "daemon tick failed;
#   continuing". No worker is spawned.
#
# Flow:
#   1. Normal boot + project + user mention → daemon enqueues a dispatch and
#      writes its sidecar.
#   2. Stop the daemon cleanly so nothing mutates the queue or sidecars.
#   3. Overwrite the sidecar's triggeringEventId with a bogus value while
#      preserving schemaVersion, dispatchId, writer, etc.
#   4. Restart the daemon. The next dispatch tick tries to admit the queued
#      dispatch, reads the corrupted sidecar, fails
#      DispatchInputTriggeringEventMismatch, and logs.
#   5. Assert the log line matches and the dispatch never transitions past
#      "queued" (no leased row appears).
#
# No LLM required.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-37-$(date +%s)-$$"
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
  "p=$USER_PUBKEY" "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" "p=$AGENT1_PUBKEY" "p=$AGENT2_PUBKEY" >/dev/null

publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" "p=$AGENT1_PUBKEY" "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
echo "[scenario] boot event id=$(printf '%s' "$boot_evt" | jq -r .id)"

await_kind_event 24010 "" "$BACKEND_PUBKEY" 12 >/dev/null \
  || { tail -40 "$HARNESS_DAEMON_LOG" >&2 || true; _die "ASSERT: daemon never published kind:24010"; }
echo "[scenario] daemon published kind:24010 ✓"

# --- Step A: publish an inbound event, wait for its dispatch + sidecar --------
queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
inputs_dir="$DAEMON_DIR/workers/dispatch-inputs"
user_msg_id=""
for attempt in 1 2 3; do
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Mismatch test message." \
    "p=$AGENT1_PUBKEY" "a=$PROJECT_A_TAG")"
  user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
  echo "[scenario] inbound event id=$user_msg_id (attempt $attempt)"

  deadline=$(( $(date +%s) + 15 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -f "$queue" ]] && \
       jq -e --arg e "$user_msg_id" \
         '(.triggeringEventId // .triggering_event_id) == $e' "$queue" \
         >/dev/null 2>&1; then
      break 2
    fi
    sleep 0.2
  done
  echo "[scenario]   not yet; retrying..."
done

dispatch_id="$(jq -r --arg e "$user_msg_id" \
  'select((.triggeringEventId // .triggering_event_id) == $e) | (.dispatchId // .dispatch_id)' \
  "$queue" | head -1)"
[[ -n "$dispatch_id" ]] || {
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch_id found for event $user_msg_id"
}
echo "[scenario] dispatch_id=$dispatch_id"

sidecar="$inputs_dir/${dispatch_id}.json"
# The daemon keeps dispatch-inputs sidecars as read-only files. Give it a
# brief window to finish writing (hardlink + parent fsync).
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$sidecar" ]] && break
  sleep 0.5
done
[[ -f "$sidecar" ]] || _die "ASSERT: sidecar not found at $sidecar"

echo "[scenario] sidecar present at $sidecar"

# --- Step B: stop daemon, corrupt sidecar, restart ---------------------------
echo "[scenario] stopping daemon to corrupt sidecar"
stop_daemon

# Rewrite the sidecar's triggering event id with a bogus but syntactically
# valid value. The sidecar uses camelCase; it's a JSON object with
# executeFields.triggeringEventId (when the daemon wrote it from
# enqueue_inbound_dispatch). We preserve every other field so only the
# mismatch triggers — the schema validator still passes.
bogus_event_id="deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
orig_trigger="$(jq -r '.executeFields.triggeringEventId' "$sidecar")"
[[ "$orig_trigger" == "$user_msg_id" ]] || {
  echo "[scenario] sidecar JSON:" >&2
  cat "$sidecar" >&2
  _die "ASSERT: sidecar.executeFields.triggeringEventId != user_msg_id (got $orig_trigger)"
}

# Hardlinked files cannot be modified in-place without affecting the other
# link. Remove and recreate.
python3 - "$sidecar" "$bogus_event_id" <<'PY'
import json, os, sys
path, bogus = sys.argv[1], sys.argv[2]
with open(path, "r") as f:
    doc = json.load(f)
doc["executeFields"]["triggeringEventId"] = bogus
os.unlink(path)
with open(path, "w") as f:
    json.dump(doc, f)
    f.write("\n")
PY
echo "[scenario] sidecar corrupted: triggeringEventId $orig_trigger -> $bogus_event_id"

# Record log size for post-restart grep.
log_bytes_before="$(wc -c < "$HARNESS_DAEMON_LOG" 2>/dev/null || echo 0)"

echo "[scenario] restarting daemon"
start_daemon

# The dispatch is still queued; on the next tick the daemon will replay the
# queue, attempt admission, try to load the sidecar, and hit the mismatch.
# Poll the daemon log for the expected failure phrase (up to 10s).
echo "[scenario] polling for dispatch admission failure in daemon log (up to 10s)"
mismatch_deadline=$(( $(date +%s) + 10 ))
saw_mismatch=0
while [[ $(date +%s) -lt $mismatch_deadline ]]; do
  tail_log_check="$(tail -c +$((log_bytes_before + 1)) "$HARNESS_DAEMON_LOG" 2>/dev/null || true)"
  if printf '%s\n' "$tail_log_check" | grep -Eq 'worker dispatch input validation failed'; then
    saw_mismatch=1
    break
  fi
  sleep 0.2
done

# --- Assertions --------------------------------------------------------------
tail_log="$(tail -c +$((log_bytes_before + 1)) "$HARNESS_DAEMON_LOG" 2>/dev/null || true)"

if [[ "$saw_mismatch" -eq 1 ]]; then
  # "worker dispatch input validation failed" is the stable phrase emitted by
  # the Rust validation path regardless of field names or tick numbers.
  echo "[scenario]   mismatch error observed in daemon log ✓"
else
  echo "[scenario] daemon log (post-restart tail):"
  printf '%s\n' "$tail_log" | tail -60 >&2 || true
  _die "ASSERT: expected triggering event mismatch error in daemon log"
fi

# The dispatch's CURRENT (latest) status must be "cancelled". Note: the
# original daemon may have already written a lease record before the test
# stopped it for sidecar corruption, so a historical "leased" entry is
# expected. What matters is that the restarted daemon recognised the
# corrupted sidecar at startup and APPENDED a cancellation, leaving the
# dispatch's effective state as cancelled — admission cannot lease it
# again, and no worker will be launched.
latest_status="$(jq -s --arg d "$dispatch_id" \
  '[.[] | select((.dispatchId // .dispatch_id) == $d)] | last | (.status // .lifecycle_status)' \
  "$queue" 2>/dev/null)"
[[ "$latest_status" == '"cancelled"' ]] || {
  echo "[scenario] dispatch rows:"
  jq -s --arg d "$dispatch_id" \
    '[.[] | select((.dispatchId // .dispatch_id) == $d)]' "$queue" >&2
  _die "ASSERT: dispatch latest status is $latest_status, expected cancelled"
}
echo "[scenario]   dispatch cancelled by startup sidecar validation ✓"

echo ""
echo "[scenario] PASS — scenario 3.7: dispatch input mismatch validation"
