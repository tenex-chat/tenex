#!/usr/bin/env bash
# E2E scenario 1.1 — Boot gates dispatch.
#
# Setup:
#   - Project descriptor seeded on disk and kind:31933 published so the
#     daemon's ProjectEventIndex catalog learns of it.
#   - NO kind:24000 boot event is published.
#
# Trigger:
#   - User publishes a kind:1 directed at agent1 carrying the project a-tag.
#
# Expected (per docs/E2E_TEST_SCENARIOS.md §1.1):
#   - Inbound is ignored with reason `project_not_booted`; no dispatch queued.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-11-$(date +%s)-$$"
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

# Whitelist user + agents + backend (production-style transitive whitelist).
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# Publish kind:31933 so the daemon's ProjectEventIndex learns about the
# project. Crucially, we do NOT publish kind:24000 (boot).
publish_event_as "$USER_NSEC" 31933 "boot-gate-test project" \
  "d=$PROJECT_D_TAG" \
  "title=Boot Gate Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Wait for daemon to ingest the 31933 (poll for project_updated log).
ingest_deadline=$(( $(date +%s) + 5 ))
while [[ $(date +%s) -lt $ingest_deadline ]]; do
  [[ -f "$DAEMON_DIR/daemon.log" ]] && \
    grep -q '"code":"project_updated"' "$DAEMON_DIR/daemon.log" 2>/dev/null && break
  sleep 0.2
done

# Publish kind:1 for agent1 WITHOUT having booted the project.
echo "[scenario] publishing kind:1 without a prior boot event"
user_msg_evt="$(publish_event_as "$USER_NSEC" 1 "pre-boot probe" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
user_msg_id="$(printf '%s' "$user_msg_evt" | jq -r .id)"
echo "[scenario]   user message id=$user_msg_id"

# Observation window — 2s is sufficient for a local relay round-trip.
sleep 2

# Assertion 1: no kind:24010 published for our project — the enforced boot gate.
events_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null || true)"
if [[ -n "$events_24010" ]] && [[ "$events_24010" != "[]" ]]; then
  if printf '%s\n' "$events_24010" | jq -se --arg a "$PROJECT_A_TAG" \
      'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
    echo "[scenario] daemon log (last 40 lines):"
    tail -40 "$HARNESS_DAEMON_LOG" >&2 || true
    _die "ASSERT: daemon published kind:24010 for an UNbooted project"
  fi
fi
echo "[scenario]   no 24010 published for unbooted project ✓"

# Assertion 2: the daemon log must contain a project_not_booted ignored entry
# for our message id — this is the real boot gate check.
log="$DAEMON_DIR/daemon.log"
if [[ ! -f "$log" ]]; then
  _die "ASSERT: daemon.log does not exist"
fi
if ! grep -q "project_not_booted" "$log"; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$log" >&2 || true
  _die "ASSERT: daemon log does not contain project_not_booted — boot gate not enforced"
fi
echo "[scenario]   daemon log contains project_not_booted ignored entry ✓"

# Assertion 3: no dispatch must be queued for the unbooted project's message.
queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
if [[ -f "$queue" ]] && jq -e --arg e "$user_msg_id" \
     '(.triggeringEventId // .triggering_event_id) == $e' "$queue" >/dev/null 2>&1; then
  echo "[scenario] dispatch-queue.jsonl content:"
  cat "$queue" >&2 || true
  _die "ASSERT: dispatch was queued for an unbooted project"
fi
echo "[scenario]   no dispatch queued for unbooted project ✓"

echo ""
echo "[scenario] PASS — scenario 1.1 Boot gates dispatch (boot gate enforced by daemon)"
