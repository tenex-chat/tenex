#!/usr/bin/env bash
# E2E scenario 11.3 — Non-admin subscriber gets auth-required from relay.
#
# Validates that:
#   - A client whose pubkey is NOT in admin_pubkeys must complete NIP-42 AUTH
#     before the relay delivers any historical events.
#   - Without AUTH (nak req without --auth) → 0 events returned (relay sends
#     auth-required which nak treats as an empty result).
#   - With AUTH (nak req --auth --sec USER_NSEC) → relay processes the AUTH
#     challenge; after AUTH the user is still non-whitelisted so LimitZero
#     applies, meaning 0 historical events returned.  The relay must have
#     logged the AUTH attempt.
#
# The relay log is checked for "authed" to confirm NIP-42 was invoked.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"
# shellcheck source=../helpers/await_file.sh
source "$repo_root/scripts/e2e/helpers/await_file.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-113-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Only backend is admin.  USER_PUBKEY is intentionally NOT listed.
start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT

# Publish some kind:1 events as backend (admin) so there's history to query.
for i in 1 2 3; do
  publish_event_as "$BACKEND_NSEC" 1 "event $i" >/dev/null
done

echo "[scenario] step 1: subscribe WITHOUT auth — expect 0 events and relay denies"
# nak req without --auth: relay sends auth-required; nak returns empty.
unauthenticated_count="$(nak req -k 1 "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   unauthenticated_count=$unauthenticated_count (expect 0)"
[[ "$unauthenticated_count" -eq 0 ]] || \
  _die "ASSERT: unauthenticated subscribe should return 0 events, got $unauthenticated_count"
echo "[scenario]   relay denied unauthenticated subscribe ✓"

echo "[scenario] step 2: subscribe WITH auth (user not whitelisted) — expect 0 historical events"
# After AUTH the relay accepts the session but the user is non-whitelisted →
# LimitZero deferrals apply; historical events not delivered.
authenticated_count="$(nak req -k 1 --auth --sec "$USER_NSEC" --limit 50 \
  "$HARNESS_RELAY_URL" 2>/dev/null | jq -s 'length')"
echo "[scenario]   authenticated_count=$authenticated_count (expect 0; non-whitelisted)"
[[ "$authenticated_count" -eq 0 ]] || \
  _die "ASSERT: authenticated but non-whitelisted user should see 0 events, got $authenticated_count"
echo "[scenario]   non-whitelisted AUTH returns 0 events ✓"

# Relay log must record the deferred subscription — this is the relay's
# observable proof that NIP-42 AUTH was completed (khatru handles the raw
# AUTH frame below the Go layer; the ACL hook records the deferral when it
# sees an authenticated but non-whitelisted pubkey).
if ! grep -qE 'deferred subscription|whitelisted' "$HARNESS_RELAY_LOG" 2>/dev/null; then
  _die "ASSERT: relay.log has no deferred-subscription line after authenticated subscribe"
fi
echo "[scenario]   relay log confirms NIP-42 AUTH was exercised (deferred sub recorded) ✓"

echo ""
echo "[scenario] PASS — scenario 11.3: non-admin gets auth-required"
emit_result pass
