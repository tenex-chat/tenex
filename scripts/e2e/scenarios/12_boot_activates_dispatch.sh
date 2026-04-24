#!/usr/bin/env bash
# E2E scenario 1.2 — Boot event activates project-status dispatch.
#
# Setup:
#   - Project descriptor pre-seeded on disk.
#   - kind:14199 (whitelist) + kind:31933 (project definition) published BEFORE
#     daemon boot — daemon ingests them into ProjectEventIndex.
#
# Trigger:
#   - Publish kind:24000 boot event for the project.
#   - Then publish a kind:1 inbound for agent1.
#
# Expected observable outcomes:
#   1. Daemon publishes kind:24010 project-status carrying the project a-tag
#      (the only enforced boot gate — see daemon_maintenance.rs::
#      filter_booted_project_descriptors).
#   2. Daemon logs a "project_booted" ingress outcome naming the d-tag.
#   3. Subsequent kind:1 inbound is enqueued (observable as a record in
#      dispatch-queue.jsonl tagged with our triggering event id).
#
# Notes on the doc's `booted-projects.json`:
#   Boot state lives only in memory (ProjectBootState); there is no on-disk
#   representation. The canonical "boot recorded" signal is the kind:24010
#   publication, reused from scenario 02.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-12-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Pre-seed the per-project descriptor on disk (same shape scenario 02 uses).
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

publish_event_as "$USER_NSEC" 31933 "Boot activation test" \
  "d=$PROJECT_D_TAG" \
  "title=Boot Activates Dispatch" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Phase 1: pre-boot. Daemon has seen the 31933 (ProjectEventIndex populated)
# but has NOT seen a kind:24000 — boot state is empty.
echo "[scenario] phase 1: verifying no 24010 is published before boot"
sleep 3
pre_boot_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null || true)"
if [[ -n "$pre_boot_24010" ]] && [[ "$pre_boot_24010" != "[]" ]]; then
  if printf '%s\n' "$pre_boot_24010" | jq -se --arg a "$PROJECT_A_TAG" \
      'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
    _die "ASSERT: daemon published kind:24010 for our project before boot"
  fi
fi
echo "[scenario]   pre-boot: no 24010 for our project ✓"

# Phase 2: publish kind:24000 boot event.
echo "[scenario] phase 2: publishing kind:24000 boot event"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

# Wait for the daemon to process the boot event. Its periodic tick publishes
# kind:24010 for booted projects only.
echo "[scenario]   waiting 8s for boot + first periodic project-status publish"
sleep 8

# Phase 2a: observe kind:24010 on the relay.
events_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null || true)"
if [[ -z "$events_24010" ]] || [[ "$events_24010" == "[]" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon never published kind:24010 after boot"
fi
if ! printf '%s\n' "$events_24010" | jq -se --arg a "$PROJECT_A_TAG" \
     'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  _die "ASSERT: kind:24010 present on relay but none references our a-tag $PROJECT_A_TAG"
fi
echo "[scenario]   post-boot: 24010 published for our a-tag ✓"

# Phase 2b: the ingress classifies the kind:24000 as `project_booted`.
if ! grep -q "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log"; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon.log has no project_booted ingress line"
fi
if ! grep "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" \
     | grep -q "$PROJECT_D_TAG"; then
  _die "ASSERT: project_booted line does not reference our d-tag $PROJECT_D_TAG"
fi
echo "[scenario]   ingress recorded project_booted for our d-tag ✓"

# Phase 3: post-boot inbound. Dispatch must still be queued (the daemon does
# not gate conversation dispatch on boot, but the test documents that boot
# does not BREAK dispatch either).
sleep 3  # let project-agent membership hydrate
echo "[scenario] phase 3: publishing kind:1 after boot"
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 "post-boot kind:1" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"

queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
deadline=$(( $(date +%s) + 15 ))
saw_dispatch=0
while [[ $(date +%s) -lt $deadline ]]; do
  if [[ -f "$queue" ]] && jq -e --arg e "$user_msg_id" \
       '(.triggeringEventId // .triggering_event_id) == $e' "$queue" \
       >/dev/null 2>&1; then
    saw_dispatch=1
    break
  fi
  sleep 0.5
done
if [[ "$saw_dispatch" -ne 1 ]]; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: no dispatch for kind:1 after boot"
fi
echo "[scenario]   post-boot dispatch enqueued ✓"

echo ""
echo "[scenario] PASS — scenario 1.2 Boot activates dispatch"
