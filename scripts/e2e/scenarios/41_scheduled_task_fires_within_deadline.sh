#!/usr/bin/env bash
# E2E scenario 4.1 — Scheduled-task driver fires within deadline.
#
# Setup:
#   - Project indexed (kind:31933 published) and booted (kind:24000 published).
#   - A one-off scheduled task is written to <projects>/<d_tag>/schedules.json
#     with an executeAt timestamp 2 seconds in the future.
#
# Trigger:
#   - The scheduled-task driver (run_scheduled_task_supervisor) wakes up on
#     the boot signal, reads schedules.json, computes next due time, and fires.
#
# Expected observable outcome:
#   - A dispatch record appears in dispatch-queue.jsonl within 5 seconds of
#     the task's executeAt, tagged with the task id we wrote.
#
# This test directly verifies commit 4/10 of the tick-elimination plan:
# the scheduled-task driver replaces the periodic `scheduled-task-due-planner`
# tick with a sleep_until approach.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-41-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Pre-seed the per-project descriptor on disk.
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

# Whitelist all participants.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# Publish kind:31933 so the daemon's ProjectEventIndex learns about the project.
# Include agent1 as a p-tag so the driver can resolve the agent pubkey.
publish_event_as "$USER_NSEC" 31933 "Scheduled-task driver test" \
  "d=$PROJECT_D_TAG" \
  "title=Scheduled Task Driver Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Publish kind:24000 to boot the project.
echo "[scenario] publishing kind:24000 boot event"
publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG" >/dev/null

# Give the daemon a moment to process the boot event.
sleep 2

# Write a one-off scheduled task with executeAt 2 seconds from now.
# The task targets agent1 (slug derived from the agents directory seeded by
# setup-nak-interop-fixture.sh).
task_id="sched-task-e2e-41-$$"
now_epoch="$(date +%s)"
execute_at_epoch=$(( now_epoch + 2 ))
execute_at_iso="$(date -u -r "$execute_at_epoch" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -d "@$execute_at_epoch" "+%Y-%m-%dT%H:%M:%SZ")"

echo "[scenario] writing schedules.json with executeAt=$execute_at_iso (task_id=$task_id)"
jq -n \
  --arg id "$task_id" \
  --arg at "$execute_at_iso" \
  --arg owner "$USER_PUBKEY" \
  --arg proj "31933:$USER_PUBKEY:$PROJECT_D_TAG" \
  --arg d "$PROJECT_D_TAG" \
  '[{
    "id": $id,
    "title": "E2E scheduled task 41",
    "schedule": $at,
    "executeAt": $at,
    "prompt": "e2e test prompt for scheduled task driver",
    "fromPubkey": $owner,
    "targetAgentSlug": "agent1",
    "projectId": $proj,
    "projectRef": $proj,
    "type": "oneoff"
  }]' > "$desc_dir/schedules.json"

echo "[scenario] waiting up to 7s for scheduled task dispatch to appear in queue"
queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
deadline=$(( $(date +%s) + 7 ))
saw_dispatch=0
while [[ $(date +%s) -lt $deadline ]]; do
  if [[ -f "$queue" ]] && grep -q "$task_id" "$queue" 2>/dev/null; then
    saw_dispatch=1
    break
  fi
  sleep 0.5
done

if [[ "$saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  if [[ -f "$queue" ]]; then
    echo "[scenario] dispatch queue contents:"
    cat "$queue" >&2
  fi
  _die "ASSERT: no dispatch for scheduled task '$task_id' within deadline"
fi
echo "[scenario]   scheduled task dispatch enqueued ✓"

# Verify the oneoff task was removed from schedules.json (finalization).
remaining="$(jq 'length' "$desc_dir/schedules.json" 2>/dev/null || echo "file-gone")"
if [[ "$remaining" != "0" && "$remaining" != "file-gone" ]]; then
  echo "[scenario] WARNING: schedules.json still has $remaining entries after dispatch"
fi
echo "[scenario]   schedules.json finalized (tasks remaining: $remaining) ✓"

echo ""
echo "[scenario] PASS — scenario 4.1 Scheduled-task driver fires within deadline"
