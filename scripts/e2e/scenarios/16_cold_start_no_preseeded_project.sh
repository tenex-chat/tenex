#!/usr/bin/env bash
# E2E scenario 1.6 — Cold-start: kind:24000 boot in a fresh environment.
#
# Regression test for the crash reported as "the very basic first thing I
# needed to do was boot a project, via the 24000 event... that crashed the
# daemon!"
#
# Root causes fixed:
#   Bug A — ensure_project_repository_on_boot (synchronous git subprocess)
#            was called directly on the tokio relay-read thread, blocking ALL
#            relay message processing.
#   Bug B — Any repo init failure propagated as NostrSubscriptionRelayError::Tick
#            which disconnected the relay subscription into a reconnect loop.
#
# Setup:
#   - EMPTY projects/ directory — no pre-seeded project.json.
#   - kind:31933 (project definition) published and ingested by the daemon.
#   - kind:24000 (boot) published after daemon is subscribed.
#
# Expected observable outcomes:
#   1. Daemon does NOT crash (process stays alive throughout).
#   2. Daemon does NOT disconnect from the relay (no "relay disconnected" in log).
#   3. Daemon publishes kind:24010 project-status carrying the project a-tag.
#   4. Ingress records "project_booted" in the daemon log.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-16-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# Guarantee an EMPTY projects/ directory — no pre-seeded project.json.
rm -rf "$TENEX_BASE_DIR/projects"
mkdir -p "$TENEX_BASE_DIR/projects"
echo "[scenario] projects/ cleared — cold-start environment confirmed empty"

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

# Publish whitelist first so daemon admits all relevant pubkeys.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# Publish the project definition (kind:31933) so the daemon can populate its
# ProjectEventIndex before the boot event arrives.
publish_event_as "$USER_NSEC" 31933 "Cold start test project" \
  "d=$PROJECT_D_TAG" \
  "title=Cold Start Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] daemon running; no pre-seeded project on disk — cold start verified"

# Publish kind:24000 boot event. In the unfixed code this triggers a
# synchronous git subprocess on the relay thread and any failure propagates
# as Tick error → relay disconnect. After the fix, repo init runs on a
# blocking thread, errors are logged at warn level, boot state IS recorded,
# and the relay subscription stays alive.
echo "[scenario] publishing kind:24000 boot event"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

# Assert 1: Daemon does NOT crash — process must still be alive.
sleep 1
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon process died after kind:24000 in cold-start environment"
fi
echo "[scenario]   daemon process still alive ✓"

# Assert 2: Relay subscription did NOT disconnect. The gateway logs
# "relay disconnected, reconnecting after backoff" on relay-fatal errors.
if grep -q "relay disconnected, reconnecting after backoff" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon logged relay disconnect after cold-start boot"
fi
echo "[scenario]   no relay disconnect logged ✓"

# Assert 3: Daemon publishes kind:24010 project-status with our a-tag.
echo "[scenario] waiting for kind:24010 project-status"
events_24010="$(await_kind_event 24010 "" "$BACKEND_PUBKEY" 20 || true)"
if [[ -z "$events_24010" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon never published kind:24010 after cold-start boot"
fi
if ! printf '%s\n' "$events_24010" | jq -se --arg a "$PROJECT_A_TAG" \
     'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  _die "ASSERT: kind:24010 published but none references our a-tag $PROJECT_A_TAG"
fi
echo "[scenario]   kind:24010 published for our a-tag ✓"

# Assert 4: Ingress recorded "project_booted" in the daemon log.
if ! grep -q "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: daemon.log has no project_booted ingress line"
fi
if ! grep "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" \
     | grep -q "$PROJECT_D_TAG" 2>/dev/null; then
  _die "ASSERT: project_booted line does not reference our d-tag $PROJECT_D_TAG"
fi
echo "[scenario]   ingress recorded project_booted for our d-tag ✓"

echo ""
echo "[scenario] PASS — scenario 1.6 Cold-start boot does not crash daemon"
