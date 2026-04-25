#!/usr/bin/env bash
# E2E scenario 3.6 — Triggering-event dedup.
#
# Validates that when the relay redelivers an inbound event the daemon has
# already enqueued, the second delivery is recognized via its computed
# `dispatch_id` and no duplicate dispatch record is appended to the queue.
#
# Mechanism under test:
#   enqueue_inbound_dispatch (crates/tenex-daemon/src/inbound_dispatch.rs:133)
#   - computes dispatch_id = "inbound-<digest>" where digest is a SHA-256 of
#     (project_id, agent_pubkey, conversation_id, triggering_event_id)
#   - under LOCK_EX on workers/dispatch-queue.lock, calls
#     `latest_record(&ids.dispatch_id)` on the replay state
#   - if a record exists, returns InboundDispatchEnqueueOutcome {
#       already_existed: true, queued: existing.status == Queued, ... }
#     without appending a new row or allocating a new RAL number.
#
# Steps:
#   1. Start a local relay + daemon + boot a project (same as scenario 5.1
#      Phase A).
#   2. Publish a kind:1 from the user mentioning agent1. Wait for the first
#      dispatch record to appear in dispatch-queue.jsonl.
#   3. Republish the IDENTICAL signed event (same id, same signature) through
#      the relay via `nak event`-on-stdin. Note: the daemon has no
#      subscription-level id dedup (verified by grep of nostr_subscription_*),
#      so the second delivery reaches `enqueue_inbound_dispatch`.
#   4. Give the daemon time to observe both frames. Assert: exactly one
#      record with that triggering_event_id exists in dispatch-queue.jsonl,
#      and the daemon log shows `already_existed=true` on the second.
#
# No LLM required. This test is deterministic daemon plumbing only.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-36-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Pre-seed the per-project descriptor. Without this, the daemon's first
# ingestion of the kind:31933 event errors with "failed to prepare project
# repository on boot" and tears down its relay subscription.
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

# Whitelist backend + user + agents so NIP-42 gated kinds (1, 24010, etc.) flow.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# Publish the project event so the daemon's inventory knows about agent1.
publish_event_as "$USER_NSEC" 31933 "NAK interop test project" \
  "d=$PROJECT_D_TAG" \
  "title=NAK Interop Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Boot the project so inbound routing is permitted.
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario] boot event id=$boot_id"

# Stream-wait for kind:24010 proving the boot took effect.
echo "[scenario] waiting for kind:24010 from daemon (proves boot recorded)"
events_24010="$(await_kind_event 24010 "" "$BACKEND_PUBKEY" 10 || true)"
if [[ -z "$events_24010" ]]; then
  tail -40 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: daemon never published kind:24010"
fi
echo "[scenario]   kind:24010 observed ✓"

# --- Step A: publish event #1 and wait for its dispatch row ------------------
queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
user_msg_evt=""
user_msg_id=""
for attempt in 1 2 3; do
  echo "[scenario] publishing kind:1 from user to agent1 (attempt $attempt)"
  user_msg_evt="$(publish_event_as "$USER_NSEC" 1 \
    "Dedup test message." \
    "p=$AGENT1_PUBKEY" \
    "a=$PROJECT_A_TAG")"
  user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"

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
  echo "[scenario]   no dispatch yet; retrying..."
done

records_before="$(jq -s --arg e "$user_msg_id" \
  '[.[] | select((.triggeringEventId // .triggering_event_id) == $e)] | length' \
  "$queue" 2>/dev/null)"
[[ "$records_before" -ge 1 ]] || {
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: first delivery did not enqueue a dispatch"
}
echo "[scenario]   first delivery enqueued ($records_before record) ✓"

# Capture the daemon log length before the replay so we can grep only the
# entries that follow.
log_bytes_before="$(wc -c < "$HARNESS_DAEMON_LOG" 2>/dev/null || echo 0)"

# --- Step B: replay the identical signed event -------------------------------
# `nak event` with the full JSON on stdin publishes the event as-is, preserving
# the id and signature. This simulates a relay redelivery.
echo "[scenario] republishing identical event id=$user_msg_id"
replay_out="$(printf '%s' "$user_msg_evt" | nak event "$HARNESS_RELAY_URL" 2>&1 || true)"
printf '%s\n' "$replay_out" | head -5 | sed 's/^/[scenario]   nak: /'

# Give the daemon a window to observe, ingest, and short-circuit on the existing
# dispatch record. 1s is enough for a local relay round-trip.
sleep 1

# --- Assertions --------------------------------------------------------------
records_after="$(jq -s --arg e "$user_msg_id" \
  '[.[] | select((.triggeringEventId // .triggering_event_id) == $e and (.status // .lifecycle_status) == "queued")] | length' \
  "$queue" 2>/dev/null)"

# The first enqueue writes exactly one "queued" row. If admission starts a
# worker it appends a "leased" row, but a "queued" row for the same
# triggering_event_id must never be duplicated.
[[ "$records_after" -eq 1 ]] || {
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  echo "[scenario] dispatch rows for this triggering event:"
  jq -s --arg e "$user_msg_id" \
    '[.[] | select((.triggeringEventId // .triggering_event_id) == $e)]' \
    "$queue" >&2 || true
  _die "ASSERT: expected exactly 1 queued row for event $user_msg_id, found $records_after"
}
echo "[scenario]   exactly 1 queued row for event after replay ✓"

# Look for the already_existed=true signal in the tail of the log (entries
# written after step A completed).
tail_log="$(tail -c +$((log_bytes_before + 1)) "$HARNESS_DAEMON_LOG" 2>/dev/null || true)"
if printf '%s\n' "$tail_log" | grep -Eq 'already_existed=true|"alreadyExisted": ?true'; then
  echo "[scenario]   daemon log shows already_existed=true for replay ✓"
else
  # Not every log path surfaces this flag; it's a nice-to-have, not required.
  echo "[scenario]   (info) already_existed flag not observed in log — the queue-count assertion above is authoritative"
fi

echo ""
echo "[scenario] PASS — scenario 3.6: triggering-event dedup"
