#!/usr/bin/env bash
# E2E scenario 11.2 — Backend publish through admin path.
#
# Validates that:
#   - The daemon (backend pubkey = admin) starts, authenticates, and publishes
#     kind:24010 project-status after ingesting a boot event.
#   - The published event is signed by the backend key and verifiable on the relay.
#   - The publish goes through the NIP-42 AUTH path (no 14199 required for admin).
#
# Daemon log checked for: "relay authenticated, resubscribed" and
# "nostr event published" (from relay_publisher.rs).
# Relay checked for: presence of kind:24010 authored by BACKEND_PUBKEY.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"
# shellcheck source=../helpers/await_file.sh
source "$repo_root/scripts/e2e/helpers/await_file.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-112-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Backend is admin; no 14199 needed for the daemon to publish.
start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

# Publish enough context so the daemon can process a boot event:
# kind:14199 to whitelist user+agents (for later subscribe), and kind:31933.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

publish_event_as "$USER_NSEC" 31933 "Admin publish test project" \
  "d=$PROJECT_D_TAG" \
  "title=Admin Publish Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Assert: relay authenticated — daemon authenticated via admin path, no 14199.
if ! grep -q '"relay authenticated, resubscribed"' "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  tail -30 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon never logged 'relay authenticated, resubscribed'"
fi
echo "[scenario]   daemon authenticated as admin ✓"

# Trigger boot so the daemon publishes kind:24010 status.
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario] boot event id=$boot_id"

# Assert: daemon publishes kind:24010 for the project — admin publish path.
echo "[scenario] waiting for kind:24010 on relay (backend admin publish)"
event_24010="$(await_kind_event 24010 "" "$BACKEND_PUBKEY" 20)"
if [[ -z "$event_24010" ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon never published kind:24010 through admin path"
fi

# Verify the event carries our a-tag.
if ! printf '%s\n' "$event_24010" | jq -se --arg a "$PROJECT_A_TAG" \
    'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  _die "ASSERT: kind:24010 on relay does not reference our project a-tag $PROJECT_A_TAG"
fi
echo "[scenario]   kind:24010 published with project a-tag ✓"

# Assert: daemon log records the publish.
if ! grep -q '"nostr event published"' "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  _die "ASSERT: daemon.log has no 'nostr event published' line"
fi
echo "[scenario]   daemon.log confirms 'nostr event published' ✓"

echo ""
echo "[scenario] PASS — scenario 11.2: backend publishes via admin path"
emit_result pass
