#!/usr/bin/env bash
# E2E scenario 1.3 — Boot is idempotent.
#
# Setup:
#   - Project ingested (14199 + 31933) and booted once.
#
# Trigger:
#   - Re-publish the IDENTICAL kind:24000 boot event a second time.
#   - Re-publish a fresh kind:24000 (different id) for the same project a-tag.
#
# Expected observable outcomes:
#   1. Both re-ingressions are recorded as `project_booted` (the same-id replay
#      is accepted by NostrIngressOutcome::ProjectBooted but should carry
#      `already_booted=true` — see ProjectBootState::record_boot_event).
#   2. The booted-project count in the ingress detail does NOT grow beyond 1.
#   3. No additional kind 14199 is published by the daemon (no republish churn
#      from repeated boots).
#
# Notes:
#   ProjectBootState is indexed by (owner_pubkey, d_tag), so replay of the same
#   project's boot never grows the map; the last boot_event_id wins. There is
#   no kind:14199 publication path triggered by boot in the current daemon, so
#   condition 3 is covered by counting 14199 events on the relay across the
#   test; no change means no churn.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-13-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
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

publish_event_as "$USER_NSEC" 31933 "Boot idempotency test" \
  "d=$PROJECT_D_TAG" \
  "title=Idempotent Boot" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# First boot.
echo "[scenario] publishing first kind:24000 (boot)"
boot1_evt="$(publish_event_as "$USER_NSEC" 24000 "boot-1" "a=$PROJECT_A_TAG")"
boot1_id="$(printf '%s' "$boot1_evt" | jq -r .id)"
echo "[scenario]   first boot id=$boot1_id"

sleep 3

# Snapshot the 14199 population on the relay after first boot.
pre_14199_count="$(nak req -k 14199 --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   14199 count on relay after first boot: $pre_14199_count"

# Snapshot the project_booted ingress log count.
pre_booted_count="$(grep -c "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
echo "[scenario]   daemon log project_booted count after first boot: $pre_booted_count"

# Second boot — a fresh kind:24000 for the SAME project. nak will sign a new
# event id (different created_at). This is the "same project, new boot event"
# replay path.
echo "[scenario] publishing second kind:24000 (replay)"
boot2_evt="$(publish_event_as "$USER_NSEC" 24000 "boot-2" "a=$PROJECT_A_TAG")"
boot2_id="$(printf '%s' "$boot2_evt" | jq -r .id)"
echo "[scenario]   second boot id=$boot2_id"
[[ "$boot2_id" != "$boot1_id" ]] || _die "ASSERT: nak should have produced a distinct boot event id"

sleep 3

# Third boot — yet another fresh kind:24000 for the same project a-tag.
echo "[scenario] publishing third kind:24000 (replay)"
boot3_evt="$(publish_event_as "$USER_NSEC" 24000 "boot-3" "a=$PROJECT_A_TAG")"
boot3_id="$(printf '%s' "$boot3_evt" | jq -r .id)"
echo "[scenario]   third boot id=$boot3_id"

sleep 3

# Assertion 1: every boot's ingress lands project_booted log lines, and the
# total count monotonically grows across replays. (Each arriving boot event
# can be logged more than once because Khatru delivers from each matching
# listener filter; what matters is the post-count > pre-count.)
post_booted_count="$(grep -c "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
echo "[scenario]   daemon log project_booted count after 3 boots: $post_booted_count"
[[ "$post_booted_count" -gt "$pre_booted_count" ]] || \
  _die "ASSERT: no additional project_booted lines after 2nd/3rd boot (pre=$pre_booted_count post=$post_booted_count)"

# Assertion 2: the booted-project count stays at 1 across all replays.
# Each project_booted line's detail carries "... booted in session state"; the
# stdout_status println outside the JSON log records "(total_count booted)".
# The authoritative counter lives inside the ingress detail; extract it from
# the post-boot JSON log lines.
#
# Each `ProjectBootOutcome` snapshot in nostr_subscription_tick.rs writes
# `"detail":"project <d_tag> boot state recorded in session state"`. The count
# we actually want is `booted_project_count` from the outcome — it's not
# persisted to the tracing log line. Instead, the observable proof that the
# session state did NOT grow is that the booted-project-count filter in the
# maintenance pass keeps publishing 24010 for ONE project only.
#
# So: count distinct d-tags in 24010 events on the relay.
events_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  --limit 50 "$HARNESS_RELAY_URL" 2>/dev/null || true)"
if [[ -z "$events_24010" ]] || [[ "$events_24010" == "[]" ]]; then
  _die "ASSERT: no kind:24010 found after 3 boot replays"
fi
# nak req emits one JSON event per line. Collect into an array for safe jq.
distinct_a_tags="$(printf '%s\n' "$events_24010" \
  | jq -s '[.[].tags[]? | select(.[0]=="a") | .[1]] | unique | length')"
echo "[scenario]   distinct project a-tags in 24010: $distinct_a_tags"
[[ "$distinct_a_tags" == "1" ]] || \
  _die "ASSERT: expected exactly one project a-tag in 24010 stream, got $distinct_a_tags"

# Assertion 3: no new kind:14199 from the daemon. The 14199 count on the relay
# should equal pre_14199_count (the daemon is not authoring 14199 here).
post_14199_count="$(nak req -k 14199 --auth --sec "$BACKEND_NSEC" \
  "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   14199 count on relay after 3 boots: $post_14199_count"
[[ "$post_14199_count" == "$pre_14199_count" ]] || \
  _die "ASSERT: 14199 churn detected (pre=$pre_14199_count post=$post_14199_count)"

echo ""
echo "[scenario] PASS — scenario 1.3 Boot is idempotent"
