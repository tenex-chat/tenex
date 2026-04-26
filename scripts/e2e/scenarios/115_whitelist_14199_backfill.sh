#!/usr/bin/env bash
# E2E scenario 11.5 — Dynamic whitelist via kind:14199, with backfill on transition.
#
# Validates that the daemon ingests a kind:14199 event and the relay ACL
# backfills deferred subscriptions for newly whitelisted pubkeys.
#
# Steps:
#   1. Start relay (only backend admin). Daemon connects and authenticates.
#   2. Backend (admin) publishes 3 kind:1 historical events.
#   3. User (not whitelisted) subscribes — expects 0 events (LimitZero).
#   4. User publishes kind:14199 with self + agent2 in p-tags.
#   5. Relay ACL processes 14199, whitelists user + agent2, backfills.
#   6. User re-subscribes (distinct --limit) — expects >=3 events.
#   7. Agent2 (transitively whitelisted) also gets access.
#
# IMPORTANT: We confirm daemon authentication WITHOUT calling await_daemon_subscribed,
# because that function publishes kind:14199 probe events (USER_NSEC) which would
# inadvertently whitelist the user before step 3. Instead we wait for the AUTH log
# line directly and then wait for a brief settle.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"
# shellcheck source=../helpers/await_file.sh
source "$repo_root/scripts/e2e/helpers/await_file.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-115-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Only backend is admin. User and agents are NOT whitelisted initially.
start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

# Publish kind:31933 as backend (admin) so the daemon can index the project.
# Do NOT publish any kind:14199 — that would whitelist pubkeys before step 3.
publish_event_as "$BACKEND_NSEC" 31933 "Whitelist backfill test project" \
  "d=$PROJECT_D_TAG" \
  "title=Whitelist Backfill Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon

# Wait for daemon to authenticate with the relay (AUTH log line).
# We explicitly do NOT call await_daemon_subscribed because its probe events
# are kind:14199 signed by USER_NSEC, which would whitelist the user prematurely.
echo "[scenario] waiting for daemon to authenticate with relay"
await_file_contains "$DAEMON_DIR/daemon.log" \
  '"relay authenticated, resubscribed"' 45 || \
  _die "daemon never authenticated with relay"
echo "[scenario]   daemon authenticated ✓"

# --- Step 1: backend (admin) publishes 3 historical kind:1 events ------------
echo "[scenario] step 1: backend publishes 3 historical kind:1 events"
for i in 1 2 3; do
  publish_event_as "$BACKEND_NSEC" 1 "historical event $i" "p=$USER_PUBKEY" >/dev/null
done

# --- Step 2: user subscribes BEFORE being whitelisted — expect 0 events ------
echo "[scenario] step 2: user subscribes before whitelist — expect 0 historical events"
# The replay guard key includes (kinds + authors + tags + limit). Use --limit 100.
# Step 4 will use --limit 50 for a distinct cache signature.
user_before="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$USER_NSEC" \
  --limit 100 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   user_before=$user_before (expect 0)"
[[ "$user_before" -eq 0 ]] || \
  _die "ASSERT: non-whitelisted user should see 0 events, saw $user_before"
echo "[scenario]   relay correctly deferred non-whitelisted user ✓"

# --- Step 3: user publishes kind:14199 to whitelist self + agent2 ------------
echo "[scenario] step 3: user publishes kind:14199 whitelisting self and agent2"
whitelist_evt="$(publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$AGENT2_PUBKEY")"
whitelist_id="$(printf '%s' "$whitelist_evt" | jq -r .id)"
echo "[scenario]   whitelist event id=$whitelist_id"

# Relay processes 14199 in its OnEventSavedHook. Wait for the ACL log line.
await_file_contains "$HARNESS_RELAY_LOG" '\[acl\] whitelisted' 8

# --- Step 4: user re-subscribes — expect >=3 historical events (backfill) ----
echo "[scenario] step 4: user re-subscribes after whitelist — expect >=3 events"
# Use --limit 50 (distinct from step 2's 100) to bypass the replay guard cache.
user_after="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$USER_NSEC" \
  --limit 50 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   user_after=$user_after (expect >=3)"
[[ "$user_after" -ge 3 ]] || \
  _die "ASSERT: whitelisted user should see >=3 events, saw $user_after"
echo "[scenario]   user backfill received ✓"

# --- Step 5: transitive whitelist — agent2 gets access via p-tag --------------
echo "[scenario] step 5: agent2 (transitively whitelisted via p-tag) subscribes"
publish_event_as "$BACKEND_NSEC" 1 "for agent2" "p=$AGENT2_PUBKEY" >/dev/null
# Use --limit 25 for a fresh cache signature.
agent2_count="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$AGENT2_NSEC" \
  --limit 25 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   agent2_count=$agent2_count (expect >=1)"
[[ "$agent2_count" -ge 1 ]] || \
  _die "ASSERT: transitively whitelisted agent2 should see >=1 event, saw $agent2_count"
echo "[scenario]   transitive whitelist (agent2) confirmed ✓"

echo ""
echo "[scenario] PASS — scenario 11.5: dynamic whitelist via 14199 with backfill"
emit_result pass
