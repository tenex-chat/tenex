#!/usr/bin/env bash
# E2E scenario 3.7 — Dispatch input mismatch validation.
#
# Validates that the daemon refuses to launch a worker when the dispatch
# sidecar on disk contradicts the dispatch queue row.
#
# Contract under test:
#   filesystem-backed admission resolves the sidecar at
#     $DAEMON_DIR/workers/dispatch-inputs/<dispatch_id>.json
#   through the same admission/start path used by live dispatches, and compares:
#     - sidecar.dispatchId         vs queue.dispatchId          (→ DispatchInputMismatch)
#     - sidecar.executeFields      vs queue.triggeringEventId   (→ DispatchInputTriggeringEventMismatch)
#   Admission fails. The daemon logs the triggering-event mismatch and no
#   worker is spawned.
#
# Flow:
#   1. Normal boot + project setup.
#   2. Stop the daemon, publish an inbound event to the relay, and pre-acquire
#      the conversation allocation lock for that event id. This keeps the next
#      daemon start from launching the worker while still allowing it to queue
#      the dispatch and write the sidecar.
#   3. Start the daemon, wait for the dispatch + sidecar, and verify the
#      dispatch stays queued while the lock is held.
#   4. Stop the daemon cleanly, overwrite the sidecar's triggeringEventId with
#      a bogus value while preserving schemaVersion, dispatchId, writer, etc.,
#      then release the held allocation lock.
#   5. Restart the daemon. The next dispatch tick tries to admit the queued
#      dispatch, reads the corrupted sidecar, fails with a triggering-event
#      mismatch, and logs.
#   6. Assert the log line matches and the dispatch never transitions past
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
sleep 8

if [[ -z "$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
          "$HARNESS_RELAY_URL" 2>/dev/null || true)" ]]; then
  tail -40 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: daemon never published kind:24010"
fi
sleep 5

# --- Step A: stop daemon, publish inbound event, hold launch lock -------------
echo "[scenario] stopping daemon before publishing the inbound event"
stop_daemon

queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
inputs_dir="$DAEMON_DIR/workers/dispatch-inputs"
user_msg_id=""
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
  "Mismatch test message." \
  "p=$AGENT1_PUBKEY" "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
echo "[scenario] inbound event id=$user_msg_id"

held_lock_path="$DAEMON_DIR/ral/locks/alloc.${PROJECT_D_TAG}.${AGENT1_PUBKEY}.${user_msg_id}.lock"
mkdir -p "$(dirname "$held_lock_path")"
held_lock_started_at="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
held_lock_hostname="$(hostname)"
jq -n \
  --argjson pid "$$" \
  --arg hostname "$held_lock_hostname" \
  --argjson startedAt "$held_lock_started_at" \
  '{pid: $pid, hostname: $hostname, startedAt: $startedAt}' \
  > "$held_lock_path"
echo "[scenario] held allocation lock at $held_lock_path"

echo "[scenario] starting daemon with the allocation lock held"
start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live after inbound publish"

# Wait for the queued dispatch + sidecar to appear while the launch lock is
# held. The dispatch must remain queued.
deadline=$(( $(date +%s) + 20 ))
dispatch_id=""
while [[ $(date +%s) -lt $deadline ]]; do
  if [[ -f "$queue" ]]; then
    dispatch_id="$(jq -r --arg e "$user_msg_id" \
      'select((.triggeringEventId // .triggering_event_id) == $e) | (.dispatchId // .dispatch_id)' \
      "$queue" | head -1)"
    if [[ -n "$dispatch_id" && "$dispatch_id" != "null" ]]; then
      break
    fi
  fi
  sleep 0.5
done
[[ -n "$dispatch_id" && "$dispatch_id" != "null" ]] || {
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: no dispatch_id found for event $user_msg_id while lock was held"
}
echo "[scenario] dispatch_id=$dispatch_id"

sidecar="$inputs_dir/${dispatch_id}.json"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -f "$sidecar" ]] && break
  sleep 0.5
done
[[ -f "$sidecar" ]] || _die "ASSERT: sidecar not found at $sidecar"

echo "[scenario] sidecar present at $sidecar"

# The held allocation lock should prevent any lease row from appearing.
leased_while_held="$(jq -s --arg d "$dispatch_id" \
  '[.[] | select((.dispatchId // .dispatch_id) == $d and (.status // .lifecycle_status) == "leased")] | length' \
  "$queue" 2>/dev/null)"
[[ "$leased_while_held" -eq 0 ]] || {
  jq -s --arg d "$dispatch_id" \
    '[.[] | select((.dispatchId // .dispatch_id) == $d)]' "$queue" >&2
  _die "ASSERT: dispatch leased while the allocation lock was held"
}
echo "[scenario]   dispatch remained queued while lock was held ✓"

# --- Step B: stop daemon, corrupt sidecar, release lock, restart -------------
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
doc["executeFields"]["triggeringEnvelope"]["message"]["nativeId"] = bogus
os.unlink(path)
with open(path, "w") as f:
    json.dump(doc, f)
    f.write("\n")
PY
echo "[scenario] sidecar corrupted: triggeringEventId $orig_trigger -> $bogus_event_id"

rm -f "$held_lock_path"
echo "[scenario] released held allocation lock"

# Record log size for post-restart grep.
log_bytes_before="$(wc -c < "$HARNESS_DAEMON_LOG" 2>/dev/null || echo 0)"

echo "[scenario] restarting daemon"
start_daemon

# The dispatch is still queued; on the next tick the daemon will replay the
# queue, attempt admission, try to load the sidecar, and hit the mismatch.
# Give several ticks to accumulate at least one failure.
echo "[scenario] waiting 10s for dispatch tick to attempt admission + fail"
sleep 10

# --- Assertions --------------------------------------------------------------
tail_log="$(tail -c +$((log_bytes_before + 1)) "$HARNESS_DAEMON_LOG" 2>/dev/null || true)"

if printf '%s\n' "$tail_log" | \
     grep -Eq 'triggering event .* does not match queued dispatch'; then
  echo "[scenario]   mismatch error observed in daemon log ✓"
else
  echo "[scenario] daemon log (post-restart tail):"
  printf '%s\n' "$tail_log" | tail -60 >&2 || true
  _die "ASSERT: expected triggering event mismatch error in daemon log"
fi

# Dispatch must not have transitioned to "leased" (worker never launched).
leased_count="$(jq -s --arg d "$dispatch_id" \
  '[.[] | select((.dispatchId // .dispatch_id) == $d and (.status // .lifecycle_status) == "leased")] | length' \
  "$queue" 2>/dev/null)"
[[ "$leased_count" -eq 0 ]] || {
  echo "[scenario] dispatch rows:"
  jq -s --arg d "$dispatch_id" \
    '[.[] | select((.dispatchId // .dispatch_id) == $d)]' "$queue" >&2
  _die "ASSERT: dispatch transitioned to leased despite sidecar mismatch"
}
echo "[scenario]   no lease row appended ✓ (worker never launched)"

echo ""
echo "[scenario] PASS — scenario 3.7: dispatch input mismatch validation"
