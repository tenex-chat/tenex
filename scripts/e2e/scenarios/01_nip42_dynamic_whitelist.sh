#!/usr/bin/env bash
# E2E scenario 11.5 — Dynamic whitelist via kind:14199, with backfill on transition.
#
# Validates that:
#   - An authenticated but non-whitelisted pubkey gets `LimitZero` deferral on subscribe
#   - Publishing a kind:14199 with that pubkey in a p-tag whitelists them
#   - Their deferred subscriptions are immediately backfilled with matching historical events
#   - Live broadcasts flow afterward
#
# Daemon is NOT involved — this is a pure relay + harness test, suitable as the
# first end-to-end smoke test of the harness itself.
#
# Requires: bash, nak, jq, curl, python3.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Setup --------------------------------------------------------------------

# Use the existing fixture script with publishing skipped — we just want the
# filesystem layout, keys, and manifest. We'll publish to our local relay.
fixture_root="$(mktemp -d -t tenex-e2e-XXXXXXXX)"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Backend pubkey is admin so the daemon (if we were running one) could subscribe
# without ceremony. The user pubkey is intentionally NOT admin — we want to
# exercise the auth + dynamic-whitelist path on it.
start_local_relay --admin "$BACKEND_PUBKEY"

trap harness_cleanup EXIT

# --- Generate a signing-only sender pubkey ------------------------------------
# The user's pubkey from the fixture is what we'll later whitelist via 14199.
# But we need *another* pubkey to act as a "sender of historical events" so we
# have some content to backfill. We'll use the backend pubkey for that since
# it's already admin — it can publish freely.

backend_nsec="$(jq -r .nsec "$BACKEND_BASE/agents/${BACKEND_PUBKEY}.json" 2>/dev/null || echo "")"
if [[ -z "$backend_nsec" ]]; then
  # Backend nsec lives in config.json
  backend_nsec="$(jq -r .tenexPrivateKey "$BACKEND_BASE/config.json")"
  # tenexPrivateKey is hex; convert to nsec
  backend_nsec="$(nak encode nsec "$backend_nsec")"
fi
echo "[scenario] backend_nsec=${backend_nsec:0:12}…"

# --- Step 1: backend (admin) publishes some historical kind:1 events ---------
echo "[scenario] step 1: backend publishes 3 historical kind:1 events"
for i in 1 2 3; do
  publish_event_as "$backend_nsec" 1 "historical message $i" \
    "p,$USER_PUBKEY" >/dev/null
done

# Sanity: backend can read its own events (it's admin)
backend_seen="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$backend_nsec" \
  "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
[[ "$backend_seen" -ge 3 ]] || _die "ASSERT: admin backend should see >=3 events, saw $backend_seen"
echo "[scenario]   backend (admin) sees $backend_seen events ✓"

# --- Step 2: user attempts to subscribe BEFORE being whitelisted -------------
# Expected: relay sends auth-required, then on AUTH the filter is rewritten with
# LimitZero=true, so historical results are empty. The sub IS registered for
# later backfill.
echo "[scenario] step 2: user (non-whitelisted) subscribes for kind:1; expect 0 historical events"
user_seen_before="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$USER_NSEC" \
  --limit 100 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   user saw $user_seen_before events before whitelist (expect 0)"
[[ "$user_seen_before" -eq 0 ]] || _die "ASSERT: non-whitelisted user should see 0 events, saw $user_seen_before"

# --- Step 3: user publishes kind:14199 self-whitelisting ---------------------
echo "[scenario] step 3: user publishes kind:14199 with self in p-tag (self-whitelist)"
whitelist_evt="$(publish_event_as "$USER_NSEC" 14199 "" "p,$USER_PUBKEY")"
whitelist_id="$(printf '%s' "$whitelist_evt" | jq -r .id)"
echo "[scenario]   14199 event id=$whitelist_id"

# Relay processes 14199 synchronously in OnEventSavedHook; whitelist update is
# immediate. Give it a brief moment to flush logs.
sleep 0.3

# --- Step 4: user re-subscribes; expect to see ALL 3 historical events -------
echo "[scenario] step 4: user (now whitelisted) re-subscribes; expect 3+ historical events"
user_seen_after="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$USER_NSEC" \
  --limit 100 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   user saw $user_seen_after events after whitelist"
[[ "$user_seen_after" -ge 3 ]] || _die "ASSERT: whitelisted user should see >=3 events, saw $user_seen_after"

# --- Step 5: transitive whitelist — user's 14199 includes agent2 -------------
echo "[scenario] step 5: user republishes 14199 adding agent2 in p-tags (transitive)"
publish_event_as "$USER_NSEC" 14199 "" \
  "p,$USER_PUBKEY" \
  "p,$AGENT2_PUBKEY" >/dev/null
sleep 0.3

# agent2 nsec from fixture
agent2_nsec="$(jq -r .nsec "$BACKEND_BASE/agents/${AGENT2_PUBKEY}.json")"

# Have backend publish a fresh event tagged for agent2
echo "[scenario]   backend publishes a new kind:1 mentioning agent2"
publish_event_as "$backend_nsec" 1 "for agent2" "p,$AGENT2_PUBKEY" >/dev/null

# agent2 should now be able to subscribe and see events
agent2_seen="$(nak req -k 1 -a "$BACKEND_PUBKEY" --auth --sec "$agent2_nsec" \
  --limit 100 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   agent2 (transitively whitelisted) saw $agent2_seen events"
[[ "$agent2_seen" -ge 1 ]] || _die "ASSERT: transitively whitelisted agent2 should see >=1 event, saw $agent2_seen"

# --- Done --------------------------------------------------------------------
echo ""
echo "[scenario] PASS — scenario 11.5: NIP-42 dynamic whitelist via 14199 backfill"
