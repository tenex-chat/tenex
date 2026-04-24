#!/usr/bin/env bash
# E2E scenario 1.5 — Boot event reordering.
#
# Setup:
#   - Relay + daemon started fresh. kind:14199 whitelisted.
#
# Trigger (out-of-order delivery):
#   1. Publish a kind:31933 with a FUTURE created_at (the "project update" /
#      newer revision). Daemon ingests it into ProjectEventIndex.
#   2. Publish a kind:31933 with an OLDER created_at for the same d-tag. Per
#      addressable-event rules (ProjectEventIndex::upsert) the in-memory index
#      discards the older event. The daemon still logs "project_updated" (the
#      disk agent-index write happens regardless of upsert result), but the
#      relay retains only the newer revision — the authoritative consistency
#      check is what the relay stores, not the log count.
#   3. Publish kind:24000 to boot the project so the daemon reaches a stable
#      booted state.
#
# Expected observable outcomes:
#   1. Daemon does NOT crash (process is still alive throughout).
#   2. The newer 31933 is accepted: daemon logs "project_updated" for it.
#   3. Relay retains only the newer kind:31933 (addressable-event semantics:
#      highest created_at per (author, d-tag) wins).
#   4. Boot (kind:24000) succeeds: "project_booted" appears in daemon log
#      and a kind:24010 is published within the periodic tick window.
#
# No LLM output is required. This is pure daemon plumbing.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-15-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# publish_event_at <nsec> <kind> <created_at> <content> [tag-spec...]
# Like publish_event_as but accepts an explicit unix timestamp.
publish_event_at() {
  local nsec="${1:?nsec}"; shift
  local kind="${1:?kind}"; shift
  local created_at="${1:?created_at}"; shift
  local content="${1:-}"; shift || true

  local nak_args=(event --sec "$nsec" -k "$kind" --created-at "$created_at" -c "$content")
  for tag in "$@"; do
    nak_args+=(--tag "$tag")
  done
  nak_args+=("$HARNESS_RELAY_URL")

  nak "${nak_args[@]}"
}

now="$(date +%s)"
ts_newer=$(( now + 3600 ))   # 1 hour in the future — unambiguously newer
ts_older=$(( now - 3600 ))   # 1 hour in the past  — unambiguously older

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

# Pre-publish kind:14199 so the daemon's whitelist admission accepts events
# from our user key.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || {
  emit_result fail "daemon subscription never became live"
  exit 1
}

# ── Phase 1: publish the NEWER kind:31933 first ──────────────────────────────
echo "[scenario] phase 1: publishing NEWER kind:31933 (created_at=$ts_newer)"
newer_evt="$(publish_event_at "$USER_NSEC" 31933 "$ts_newer" "Newer project revision" \
  "d=$PROJECT_D_TAG" \
  "title=Reorder Test (newer)" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY")"
newer_id="$(printf '%s' "$newer_evt" | jq -r .id)"
echo "[scenario]   newer 31933 id=$newer_id created_at=$ts_newer"

# Give the daemon time to ingest the newer event.
sleep 3

pre_updated_count="$(grep -c '"code":"project_updated"' "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
echo "[scenario]   daemon log project_updated count after newer 31933: $pre_updated_count"
if [[ "$pre_updated_count" -lt 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "daemon did not log project_updated after newer 31933"
  exit 1
fi
echo "[scenario]   newer 31933 accepted (project_updated logged) ✓"

# ── Phase 2: publish the OLDER kind:31933 ────────────────────────────────────
echo "[scenario] phase 2: publishing OLDER kind:31933 (created_at=$ts_older)"
older_evt="$(publish_event_at "$USER_NSEC" 31933 "$ts_older" "Older project revision" \
  "d=$PROJECT_D_TAG" \
  "title=Reorder Test (older)" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY")"
older_id="$(printf '%s' "$older_evt" | jq -r .id)"
echo "[scenario]   older 31933 id=$older_id created_at=$ts_older"

# Give the daemon time to process (or correctly discard) the older event.
sleep 3

post_updated_count="$(grep -c '"code":"project_updated"' "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
echo "[scenario]   daemon log project_updated count after older 31933: $post_updated_count (informational)"

# The daemon's nostr_ingress always calls handle_project_nostr_event and logs
# "project_updated" regardless of whether the ProjectEventIndex upsert is a
# no-op (the disk write happens unconditionally). So a second project_updated
# log line is expected. The authoritative consistency check is the relay: for
# addressable events (kind 31933) the relay keeps only the event with the
# highest created_at per (author, d-tag).
relay_project="$(nak req -k 31933 -d "$PROJECT_D_TAG" -a "$USER_PUBKEY" \
  --limit 1 --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
relay_created_at="$(printf '%s' "$relay_project" | jq -r '.created_at // empty' 2>/dev/null || true)"
echo "[scenario]   relay stored 31933 created_at=$relay_created_at (expected=$ts_newer)"
if [[ "$relay_created_at" != "$ts_newer" ]]; then
  emit_result fail "relay discarded newer 31933 in favour of older one (got created_at=$relay_created_at want=$ts_newer)"
  exit 1
fi
echo "[scenario]   relay correctly retains the newer revision ✓"

# ── Phase 3: daemon is still alive ───────────────────────────────────────────
echo "[scenario] phase 3: checking daemon process is still alive"
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  emit_result fail "daemon crashed after out-of-order 31933 delivery"
  exit 1
fi
echo "[scenario]   daemon still running (pid $HARNESS_DAEMON_PID) ✓"

# ── Phase 4: boot the project via kind:24000 ─────────────────────────────────
# The older 31933 triggers an in-session subscription refresh on the daemon.
# Publishing the boot event immediately after the refresh risks landing in
# Khatru's (REQ-sent, addListener-pending) window and being lost. To avoid
# this race, we use a publish-and-poll loop: publish the boot event, poll for
# the project_booted log line, and if it doesn't appear, republish (since the
# daemon may have reconnected and re-subscribed). This is robust to both the
# subscription-refresh window and relay reconnect cycles.
echo "[scenario] phase 4: polling-boot kind:24000 for project $PROJECT_D_TAG"
boot_deadline=$(( $(date +%s) + 60 ))
saw_boot=0
attempt=0
while [[ $(date +%s) -lt $boot_deadline ]]; do
  attempt=$(( attempt + 1 ))
  boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot-attempt-$attempt" "a=$PROJECT_A_TAG" 2>/dev/null || true)"
  boot_id="$(printf '%s' "$boot_evt" | jq -r '.id // empty' 2>/dev/null || true)"
  [[ -n "$boot_id" ]] && echo "[scenario]   boot attempt #$attempt id=$boot_id"

  # Poll for project_booted up to 10s per attempt before republishing.
  poll_deadline=$(( $(date +%s) + 10 ))
  while [[ $(date +%s) -lt $poll_deadline ]]; do
    if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
       grep -q '"code":"project_booted"' "$DAEMON_DIR/daemon.log" 2>/dev/null; then
      saw_boot=1
      break 2
    fi
    sleep 0.5
  done

  [[ $(date +%s) -ge $boot_deadline ]] && break
done

if [[ "$saw_boot" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "daemon.log has no project_booted line after boot event (tried $attempt time(s))"
  exit 1
fi
if ! grep '"code":"project_booted"' "$DAEMON_DIR/daemon.log" | grep -q "$PROJECT_D_TAG"; then
  emit_result fail "project_booted log line does not reference our d-tag $PROJECT_D_TAG"
  exit 1
fi
echo "[scenario]   project_booted logged for our d-tag ✓"

# Allow the periodic maintenance tick to publish the project-status (kind:24010).
sleep 8

# Assertion: daemon published kind:24010 for the project a-tag.
events_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null || true)"
if [[ -z "$events_24010" ]] || [[ "$events_24010" == "[]" ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "daemon never published kind:24010 after boot"
  exit 1
fi
if ! printf '%s\n' "$events_24010" | jq -se --arg a "$PROJECT_A_TAG" \
     'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  emit_result fail "kind:24010 on relay does not reference our project a-tag $PROJECT_A_TAG"
  exit 1
fi
echo "[scenario]   kind:24010 published for our project a-tag ✓"

# ── Phase 5: verify relay retains the newer 31933 ────────────────────────────
echo "[scenario] phase 5: verifying relay retains the newer kind:31933"
relay_project="$(nak req -k 31933 -d "$PROJECT_D_TAG" -a "$USER_PUBKEY" \
  --limit 1 --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
relay_created_at="$(printf '%s' "$relay_project" | jq -r '.created_at // empty' 2>/dev/null || true)"
if [[ "$relay_created_at" != "$ts_newer" ]]; then
  emit_result fail "relay does not retain newer 31933 (got created_at=$relay_created_at want=$ts_newer)"
  exit 1
fi
echo "[scenario]   relay retains newer kind:31933 (created_at=$relay_created_at) ✓"

echo ""
echo "[scenario] PASS — scenario 1.5 Boot event reordering"
emit_result pass "newer 31933 wins; older discarded; boot succeeded; no crash"
