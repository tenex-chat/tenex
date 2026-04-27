#!/usr/bin/env bash
# E2E scenario 3.9 — RAL number exhaustion guard.
#
# Validates that when a (project, agent, conversation) namespace has a RAL
# record at ralNumber = u64::MAX, the scheduler refuses to allocate a new
# RAL number for any subsequent event in that namespace.
#
# Contract under test (crates/tenex-daemon/src/ral_scheduler.rs:105,335):
#   On replay, if any journal entry's identity.ral_number == u64::MAX the
#   namespace state's ral_number_exhausted flag is set to true.
#   On allocate(), if ral_number_exhausted the call returns
#   RalSchedulerError::RalNumberExhausted { namespace }.
#
# That error propagates up through `enqueue_inbound_dispatch` ->
# `resolve_and_enqueue_inbound_dispatch` -> `NostrSubscriptionRelayError`, and
# the subscription loop logs "relay disconnected, reconnecting after backoff"
# with the error message in the `error` field. The daemon reconnects and the
# cycle repeats; no dispatch record is written for the exhausted namespace.
#
# Flow:
#   1. Start relay. Publish whitelist + project + boot events so the daemon's
#      inventory and routing for agent1 are ready.
#   2. Start the daemon briefly, let it ingest the project + boot, then stop.
#      (We need the routing catalog on disk before we seed the journal
#      because the project id that the router emits must match what we write
#      into the journal identity.)
#   3. Derive project_id the same way the scheduler does (it comes from the
#      route → project.project_id which is the d-tag suffix string) and
#      compute the expected conversation_id.
#   4. Seed the RAL journal with one Allocated record at
#      ralNumber = 18446744073709551615 (u64::MAX). Use a contrived
#      conversation_id that we will then hit from the inbound.
#   5. Restart the daemon.
#   6. Publish an inbound kind:1 from a dedicated user key such that the
#      computed conversation_id matches the seeded record. The daemon
#      replays the journal, sees the exhausted flag, and refuses to allocate.
#   7. Assert: no dispatch row ever appears for the triggering event, and the
#      daemon log contains the RalNumberExhausted error.
#
# The easiest way to make the inbound's derived conversation_id match the
# seeded namespace is to seed every plausible conversation_id that the
# route would compute — but the scheduler exhausts by *namespace*, i.e.
# (project_id, agent_pubkey, conversation_id). So we must know the exact
# conversation_id the daemon will derive.
#
# Strategy: the inbound routing derives conversation_id from the event's
# own identity (typically `user_pubkey:event_id` for a top-level message).
# Rather than predict that, we seed at `ralNumber=u64::MAX` for the TRUE
# namespace the daemon will compute — we drive the conversation_id
# deterministically by first publishing a message, letting the daemon route
# it and write a RAL allocation, and then REWRITING that allocation's
# ralNumber to u64::MAX and restarting.
#
# This "capture actual namespace, then overwrite" approach survives changes
# in how the daemon derives conversation ids because we observe the actual
# derivation before corrupting.
#
# No LLM required.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Setup --------------------------------------------------------------------
fixture_root="${TMPDIR:-/tmp}/tenex-e2e-39-$(date +%s)-$$"
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

await_kind_event 24010 "" "$BACKEND_PUBKEY" 15 >/dev/null \
  || { tail -40 "$HARNESS_DAEMON_LOG" >&2 || true; _die "ASSERT: daemon never published kind:24010 within 15s"; }
echo "[scenario] daemon published kind:24010 ✓"

# --- Step A: seed a real allocation, then capture its namespace --------------
queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
journal="$DAEMON_DIR/ral/journal.jsonl"

first_msg_id=""
for attempt in 1 2 3; do
  first_evt="$(publish_event_as "$USER_NSEC" 1 \
    "RAL exhaustion priming message." \
    "p=$AGENT1_PUBKEY" "a=$PROJECT_A_TAG")"
  first_msg_id="$(printf '%s' "$first_evt" | jq -r .id)"
  echo "[scenario] priming event id=$first_msg_id (attempt $attempt)"

  deadline=$(( $(date +%s) + 15 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -f "$queue" ]] && \
       jq -e --arg e "$first_msg_id" \
         '(.triggeringEventId // .triggering_event_id) == $e' "$queue" \
         >/dev/null 2>&1; then
      break 2
    fi
    sleep 0.2
  done
done

# Read the exact namespace the daemon picked.
record="$(jq -s --arg e "$first_msg_id" \
  '[.[] | select((.triggeringEventId // .triggering_event_id) == $e)][0]' "$queue" 2>/dev/null)"
[[ -n "$record" && "$record" != "null" ]] || {
  tail -60 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: priming event never produced a dispatch row"
}
project_id="$(printf '%s' "$record" | jq -r '.ral.projectId // .ral.project_id')"
agent_pubkey="$(printf '%s' "$record" | jq -r '.ral.agentPubkey // .ral.agent_pubkey')"
conversation_id="$(printf '%s' "$record" | jq -r '.ral.conversationId // .ral.conversation_id')"
[[ -n "$project_id" && -n "$agent_pubkey" && -n "$conversation_id" ]] || {
  _die "ASSERT: could not extract namespace from dispatch row: $record"
}
echo "[scenario] namespace captured:"
echo "[scenario]   project_id      = $project_id"
echo "[scenario]   agent_pubkey    = $agent_pubkey"
echo "[scenario]   conversation_id = $conversation_id"

# --- Step B: stop daemon and seed journal with u64::MAX allocation -----------
echo "[scenario] stopping daemon to seed RAL journal with u64::MAX"
stop_daemon

# Wipe the queue and journal, then seed a single Allocated record at
# ralNumber = u64::MAX (18446744073709551615). On restart the scheduler
# replay will set ral_number_exhausted=true for this namespace.
U64_MAX=18446744073709551615

python3 - "$journal" "$project_id" "$agent_pubkey" "$conversation_id" "$U64_MAX" <<'PY'
"""Seed a journal with a single Allocated record at u64::MAX.

Mirrors RalJournalRecord serialization (see
crates/tenex-daemon/src/ral_journal.rs:305 — record has schemaVersion,
writer, writerVersion, sequence, timestamp, correlationId, then
event-tagged variant fields flattened in).
"""
import json
import os
import sys
import time

journal_path, project_id, agent_pubkey, conversation_id, u64_max = sys.argv[1:6]
ral_number = int(u64_max)

record = {
    "schemaVersion": 1,
    "writer": "scenario-39-seed",
    "writerVersion": "e2e",
    "sequence": 1,
    "timestamp": int(time.time() * 1000),
    "correlationId": "scenario-39-seed",
    # RalJournalEvent::Allocated
    "event": "allocated",
    "projectId": project_id,
    "agentPubkey": agent_pubkey,
    "conversationId": conversation_id,
    "ralNumber": ral_number,
    "triggeringEventId": "scenario39-seed-trigger",
}

os.makedirs(os.path.dirname(journal_path), exist_ok=True)
with open(journal_path, "w") as f:
    f.write(json.dumps(record))
    f.write("\n")

# Also clear any lingering snapshot so the replay must go through our seed.
snapshot_path = os.path.join(os.path.dirname(journal_path), "snapshot.json")
if os.path.exists(snapshot_path):
    os.unlink(snapshot_path)

print(f"[scenario]   wrote seed record to {journal_path}")
PY

# Also wipe the dispatch queue and dispatch-inputs from the priming so the
# daemon sees a clean slate at the queue layer and the ONLY ambient state is
# the exhausted RAL namespace.
rm -f "$queue"
rm -rf "$DAEMON_DIR/workers/dispatch-inputs"

echo "[scenario] queue + dispatch-inputs wiped; journal seeded"

# --- Step C: restart daemon and publish an inbound that hits the namespace ---
daemon_json_log="$DAEMON_DIR/daemon.log"
log_bytes_before="$(wc -c < "$daemon_json_log" 2>/dev/null || echo 0)"

echo "[scenario] restarting daemon"
start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live after restart"

# Wait for routing to rehydrate — poll for the daemon's boot log.
rehydrate_deadline=$(( $(date +%s) + 5 ))
while [[ $(date +%s) -lt $rehydrate_deadline ]]; do
  [[ -f "$daemon_json_log" ]] && \
    grep -q '"relay authenticated, resubscribed"' "$daemon_json_log" 2>/dev/null && break
  sleep 0.2
done

# Project boot state is in-memory only and lost across daemon restarts.
# Publish a fresh kind:24000 boot event so the restarted daemon will accept
# inbound dispatches for this project.
echo "[scenario] re-booting project for restarted daemon"
publish_event_as "$USER_NSEC" 24000 "boot-post-restart" "a=$PROJECT_A_TAG" >/dev/null
await_kind_event 24010 "" "$BACKEND_PUBKEY" 15 >/dev/null \
  || _die "ASSERT: restarted daemon never published kind:24010 within 15s"
echo "[scenario]   project re-booted (kind:24010 published) ✓"

# The routing derives conversation_id from the inbound envelope's identity.
# For a top-level event (no reply), conversation_id = the event's own id. For a
# reply event (e-tag referencing a known event), the daemon looks up which
# conversation already contains that referenced event and routes to that
# conversation.
#
# We cannot republish the original priming event because the second daemon's
# subscription has a `since` filter set to its startup time, and the old event
# pre-dates that filter. Khatru will not re-deliver stored events outside the
# since window.
#
# Instead, publish a FRESH kind:1 reply that references first_msg_id via an
# e-tag. The daemon finds the existing conversation file for first_msg_id and
# assigns conversation_id = first_msg_id — exactly the exhausted namespace.
# The fresh event passes the since filter and enters the ingress normally.
echo "[scenario] publishing fresh reply to priming event to hit exhausted namespace"
publish_event_as "$USER_NSEC" 1 \
  "follow-up to exhaustion test" \
  "p=$AGENT1_PUBKEY" "a=$PROJECT_A_TAG" \
  "e=$first_msg_id" >/dev/null

# The scheduler error (RalNumberExhausted) propagates up through
# enqueue_inbound_dispatch -> resolve_and_enqueue_inbound_dispatch ->
# NostrSubscriptionTickError -> NostrSubscriptionRelayError and causes the
# relay session to disconnect and reconnect. Each reconnect attempt will log
# the error in the daemon JSON log at $DAEMON_DIR/daemon.log.
echo "[scenario] polling for RalNumberExhausted in daemon log (up to 10s)"
exhaust_deadline=$(( $(date +%s) + 10 ))
saw_exhausted=0
while [[ $(date +%s) -lt $exhaust_deadline ]]; do
  tail_log="$(tail -c +$((log_bytes_before + 1)) "$daemon_json_log" 2>/dev/null || true)"
  if printf '%s\n' "$tail_log" | grep -Eq 'RAL number space exhausted'; then
    saw_exhausted=1
    break
  fi
  sleep 0.2
done

# --- Assertions --------------------------------------------------------------
tail_log="$(tail -c +$((log_bytes_before + 1)) "$daemon_json_log" 2>/dev/null || true)"

if [[ "$saw_exhausted" -eq 1 ]]; then
  echo "[scenario]   RalNumberExhausted error observed in daemon log ✓"
else
  echo "[scenario] daemon log (post-restart tail, $daemon_json_log):"
  printf '%s\n' "$tail_log" | tail -80 >&2 || true
  _die "ASSERT: expected RalNumberExhausted error in daemon log"
fi

# No dispatch row may be written for the exhausted namespace.
if [[ -f "$queue" ]]; then
  rows="$(jq -s --arg c "$conversation_id" \
    '[.[] | select((.ral.conversationId // .ral.conversation_id) == $c)] | length' \
    "$queue" 2>/dev/null)"
  [[ "$rows" -eq 0 ]] || {
    echo "[scenario] unexpected dispatch rows for exhausted namespace:"
    jq -s --arg c "$conversation_id" \
      '[.[] | select((.ral.conversationId // .ral.conversation_id) == $c)]' \
      "$queue" >&2
    _die "ASSERT: exhausted namespace produced $rows dispatch row(s)"
  }
fi
echo "[scenario]   no dispatch row for exhausted namespace ✓"

echo ""
echo "[scenario] PASS — scenario 3.9: RAL number exhaustion guard"
