#!/usr/bin/env bash
# E2E scenario 1.4 — Stale boot state recovered on restart.
#
# Setup:
#   - Project ingested and booted once, kind:24010 publishing confirmed.
#   - Daemon is hard-killed (SIGKILL) leaving the stale lockfile and any
#     partial in-memory state behind.
#
# Restart:
#   - Relaunch the daemon with the same TENEX_BASE_DIR.
#   - The relay still has the kind:24000 boot event; historical query on
#     reconnect re-ingresses it.
#
# Expected observable outcomes:
#   1. Daemon starts without panicking on the stale lockfile.
#   2. Re-publishing kind:24000 after restart is accepted: `project_booted`
#      appears again; kind:24010 is published by the new daemon.
#   3. The restart itself does not crash-loop.
#
# Notes:
#   There is no on-disk `booted-projects.json` in the current daemon. Boot
#   state is purely in-memory (see project_boot_state.rs) and kind 24000 is
#   ephemeral (it ships with `limit: Some(0)` in subscription_filters.rs), so
#   a restarted daemon does NOT automatically rebuild boot state from relay
#   history — it waits for the next live boot event. The scenario exercises
#   this contract: stale state must clear (it does — in-memory state is gone)
#   and a fresh boot event must work (proves no infinite loop or lock
#   contention blocking ingestion).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-14-$(date +%s)-$$"
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

publish_event_as "$USER_NSEC" 31933 "Boot recovery test" \
  "d=$PROJECT_D_TAG" \
  "title=Boot Recovery" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# --- First daemon incarnation ------------------------------------------------
start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

echo "[scenario] publishing kind:24000 (boot) for first daemon"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

echo "[scenario] waiting for first-incarnation boot to be recorded (up to 8s)"
first_boot_deadline=$(( $(date +%s) + 8 ))
while [[ $(date +%s) -lt $first_boot_deadline ]]; do
  [[ -f "$DAEMON_DIR/daemon.log" ]] && \
    grep -q '"code":"project_booted"' "$DAEMON_DIR/daemon.log" 2>/dev/null && break
  sleep 0.2
done

# Confirm first boot: kind:24010 on relay + project_booted in log.
first_24010="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  --limit 20 "$HARNESS_RELAY_URL" 2>/dev/null || true)"
if [[ -z "$first_24010" ]] || [[ "$first_24010" == "[]" ]]; then
  _die "ASSERT: no kind:24010 after first boot — test pre-condition not met"
fi
if ! printf '%s\n' "$first_24010" | jq -se --arg a "$PROJECT_A_TAG" \
     'any(.[]; .tags[]? | select(.[0]=="a" and .[1]==$a))' >/dev/null 2>&1; then
  _die "ASSERT: first 24010 does not reference our a-tag — pre-condition not met"
fi
first_boot_lines="$(grep -c "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
[[ "$first_boot_lines" -ge 1 ]] || _die "ASSERT: no project_booted log in first incarnation"
echo "[scenario]   first daemon recorded boot ($first_boot_lines project_booted log lines) ✓"

# --- Crash + restart ---------------------------------------------------------
echo "[scenario] crashing daemon (SIGKILL)"
crash_daemon

# Stale lockfile should still be present after SIGKILL.
if [[ ! -f "$DAEMON_DIR/tenex.lock" ]]; then
  echo "[scenario]   NOTE: tenex.lock absent after SIGKILL (daemon cleaned up on exit path?)"
else
  echo "[scenario]   stale lockfile present at $DAEMON_DIR/tenex.lock ✓"
fi

# Preserve the old daemon log so we can diff against post-restart cleanly.
saved_log="$DAEMON_DIR/daemon.log.pre-restart"
cp "$DAEMON_DIR/daemon.log" "$saved_log" 2>/dev/null || true
saved_line_count="$(wc -l < "$saved_log" 2>/dev/null | tr -d '[:space:]' || echo 0)"
echo "[scenario]   pre-restart daemon.log line count: $saved_line_count"

echo "[scenario] restarting daemon"
start_daemon
await_daemon_subscribed 45 || _die "restarted daemon subscription never became live"

# After restart, in-memory boot state is empty. Kind:24000 is ephemeral so the
# relay did not store it. The daemon awaits a new boot event — that is the
# "stale state cleared" guarantee. Re-publish the boot event to re-activate.
echo "[scenario] re-publishing kind:24000 for restarted daemon"
boot2_evt="$(publish_event_as "$USER_NSEC" 24000 "boot-after-restart" "a=$PROJECT_A_TAG")"
boot2_id="$(printf '%s' "$boot2_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot2_id"

echo "[scenario] waiting for re-boot to be processed (up to 10s)"
reboot_deadline=$(( $(date +%s) + 10 ))
while [[ $(date +%s) -lt $reboot_deadline ]]; do
  [[ -f "$DAEMON_DIR/daemon.log" ]] && \
    grep -c '"code":"project_booted"' "$DAEMON_DIR/daemon.log" 2>/dev/null | \
    xargs -I{} test {} -gt "$first_boot_lines" && break || true
  sleep 0.2
done

# Assertion: post-restart, the daemon logs NEW project_booted lines. Because
# the log file is the same path and tracing appends, we compare counts.
post_boot_lines="$(grep -c "\"code\":\"project_booted\"" "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
echo "[scenario]   post-restart project_booted log lines: $post_boot_lines"
[[ "$post_boot_lines" -gt "$first_boot_lines" ]] || \
  _die "ASSERT: restarted daemon did not re-boot project (pre=$first_boot_lines post=$post_boot_lines)"

# Assertion: the restarted daemon publishes a fresh kind:24010 after re-boot.
# With 31-sec periodic tick, we wait up to that window.
echo "[scenario] waiting up to 15s for restarted daemon to publish a 24010"
saw_new_24010=0
# Check historical events first.
events="$(nak req -k 24010 -a "$BACKEND_PUBKEY" --auth --sec "$BACKEND_NSEC" \
  --limit 50 "$HARNESS_RELAY_URL" 2>/dev/null || true)"
all_count="$(printf '%s\n' "$events" | jq -s \
  --arg a "$PROJECT_A_TAG" '[.[] | select(.tags[]? | .[0]=="a" and .[1]==$a)] | length' 2>/dev/null || echo 0)"
if [[ "$all_count" -ge 2 ]]; then
  saw_new_24010=1
  echo "[scenario]   observed $all_count total 24010s for our a-tag ✓ (historical)"
else
  # Stream-wait for the next 24010 from the daemon.
  matched="$(timeout 15 nak req -k 24010 -a "$BACKEND_PUBKEY" --stream \
    --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null | head -1 || true)"
  if [[ -n "$matched" ]]; then
    saw_new_24010=1
    echo "[scenario]   observed new 24010 from restarted daemon ✓"
  fi
fi
if [[ "$saw_new_24010" -ne 1 ]]; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  _die "ASSERT: restarted daemon did not publish a new kind:24010"
fi

# Assertion: the daemon did not hang or crash-loop on the stale lockfile.
if ! kill -0 "$HARNESS_DAEMON_PID" 2>/dev/null; then
  _die "ASSERT: restarted daemon is not running"
fi
echo "[scenario]   restarted daemon still running (pid $HARNESS_DAEMON_PID) ✓"

echo ""
echo "[scenario] PASS — scenario 1.4 Stale boot state recovered on restart"
