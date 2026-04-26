#!/usr/bin/env bash
# E2E scenario 12.7 — SIGHUP reloads NIP-46 owners configuration.
#
# Setup:
#   - Daemon starts with USER_PUBKEY as whitelisted owner and a bunker URI
#     pointing at wss://127.0.0.1:1 (unreachable bunker A, immediate refuse).
#     signingTimeoutMs = 2s so the first reconcile fails fast.
#   - During the run, config.json is updated: bunker URI → bunker B (real nak
#     bunker). SIGHUP is sent.
#   - A dummy agent file is added to disk immediately after SIGHUP to force the
#     agent-inventory poller to fire a fresh trigger (the poller only triggers
#     on inventory changes, and without a change it would wait idle_retry=300s).
#
# Trigger:
#   - SIGHUP causes reload_whitelist_from_handle (registry cleared, new config
#     loaded). Poller detects inventory change → trigger → reconciler fires via
#     bunker B → kind:14199 published.
#
# Expected:
#   - Daemon log contains "SIGHUP reload complete".
#   - A kind:14199 event appears on the relay (published via bunker B).
#
# Covers regression 58bfdfc9.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-127-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

# Pre-seed the whitelist so nak bunker (USER_PUBKEY) and the daemon can subscribe.
seed_whitelist_file "$USER_PUBKEY" "$BACKEND_PUBKEY"

# Register agent1 in the agents index so the reconciler sees a non-empty agent
# set after SIGHUP and fires. Without this byProject is empty and the
# reconciler has no agents to include, so it skips (backend-only guard).
agents_index="$TENEX_BASE_DIR/agents/index.json"
jq --arg pk "$AGENT1_PUBKEY" --arg proj "$PROJECT_D_TAG" \
   '.byProject[$proj] = [$pk]' \
   "$agents_index" > "$agents_index.tmp" && mv "$agents_index.tmp" "$agents_index"

# Start daemon with bunker A: unreachable endpoint, 2s timeout.
cfg="$TENEX_BASE_DIR/config.json"
jq \
  --arg owner "$USER_PUBKEY" \
  '.whitelistedPubkeys = [$owner] |
   .nip46 = {
     signingTimeoutMs: 2000,
     maxRetries: 0,
     owners: {
       ($owner): {bunkerUri: ("bunker://" + $owner + "?relay=wss://127.0.0.1:1")}
     }
   }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Wait for initial reconcile failure with bunker A.
echo "[scenario] waiting up to 12s for initial reconcile failure with bunker A"
fail_deadline=$(( $(date +%s) + 12 ))
saw_fail=0
while [[ $(date +%s) -lt $fail_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -qiE "timed out|sign.*timeout|reconcil.*fail|nip.46.*timeout" \
       "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_fail=1
    break
  fi
  sleep 0.5
done
echo "[scenario]   initial bunker-A timeout (saw_fail=$saw_fail)"

# Start nak bunker B (the real bunker using the local relay).
bunker_log="$fixture_root/bunker.log"
nak bunker \
  --sec "$USER_NSEC" \
  --authorized-keys "$BACKEND_PUBKEY" \
  "$HARNESS_RELAY_URL" \
  >"$bunker_log" 2>&1 &
BUNKER_PID=$!
echo "[scenario] nak bunker B pid=$BUNKER_PID"
sleep 1

# Update config: point bunker URI at the real local bunker with a longer timeout.
jq \
  --arg owner "$USER_PUBKEY" \
  --arg relay "$HARNESS_RELAY_URL" \
  '.nip46.signingTimeoutMs = 15000 |
   .nip46.owners[($owner)].bunkerUri = ("bunker://" + $owner + "?relay=" + $relay)' \
  "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

# Send SIGHUP to the actual daemon PID from the lockfile. HARNESS_DAEMON_PID
# is the cargo-run subshell wrapper; SIGHUP to the subshell kills the process
# group rather than being caught by the daemon's signal handler. The lockfile
# always contains the daemon's own PID.
daemon_pid="$(jq -r .pid "$DAEMON_DIR/tenex.lock" 2>/dev/null || echo "")"
if [[ -z "$daemon_pid" ]]; then
  kill "$BUNKER_PID" 2>/dev/null || true
  _die "could not read daemon PID from lockfile"
fi
echo "[scenario] sending SIGHUP to daemon pid=$daemon_pid (lockfile PID)"
kill -HUP "$daemon_pid"

# Wait for "SIGHUP reload complete" in daemon log.
reload_deadline=$(( $(date +%s) + 10 ))
saw_reload=0
while [[ $(date +%s) -lt $reload_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -q "SIGHUP reload complete" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_reload=1
    break
  fi
  sleep 0.3
done

if [[ "$saw_reload" -ne 1 ]]; then
  echo "[scenario] daemon log (last 40 lines):"
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  kill "$BUNKER_PID" 2>/dev/null || true
  emit_result fail "SIGHUP reload complete not logged within 10s"
  _die "ASSERT: SIGHUP did not trigger whitelist reload"
fi
echo "[scenario]   SIGHUP reload complete logged ✓"

# The agent-inventory poller fires on inventory changes. The poller reads from
# byProject in index.json (individual agent files are ignored when index.json
# exists). Add AGENT2_PUBKEY to byProject to force a detectable inventory
# change, which triggers the reconciler via the poller. Without a change the
# poller won't fire for 300s (idle_retry after bunker-A timeout).
agents_index="$TENEX_BASE_DIR/agents/index.json"
jq --arg pk1 "$AGENT1_PUBKEY" --arg pk2 "$AGENT2_PUBKEY" --arg proj "$PROJECT_D_TAG" \
   '.byProject[$proj] = [$pk1, $pk2]' \
   "$agents_index" > "$agents_index.tmp" && mv "$agents_index.tmp" "$agents_index"
echo "[scenario]   agent2 added to byProject to force poller trigger"

# Now wait for a successful kind:14199 (bunker B responds) that contains
# AGENT1_PUBKEY in p-tags, confirming the reconciler fired via bunker B.
# Flow: poller detects inventory change (~2s) → trigger → debounce 5s →
#       reconcile → client_for_owner (fresh, bunker B) → connect+sign → publish.
echo "[scenario] waiting up to 20s for kind:14199 via bunker B with agent1 p-tag"
deadline=$(( $(date +%s) + 20 ))
event_json=""
lim=20
while [[ $(date +%s) -lt $deadline ]]; do
  candidates="$(nak req -k 14199 --limit "$lim" --auth --sec "$BACKEND_NSEC" \
    -a "$USER_PUBKEY" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  event_json="$(printf '%s\n' "$candidates" | \
    jq -s --arg pk "$AGENT1_PUBKEY" \
      '[.[] | select(.tags[] | select(.[0]=="p" and .[1]==$pk))] | last' \
    2>/dev/null || true)"
  if [[ -n "$event_json" ]] && [[ "$event_json" != "null" ]]; then
    break
  fi
  event_json=""
  lim=$(( lim + 1 ))
  sleep 1
done

kill "$BUNKER_PID" 2>/dev/null || true

if [[ -z "$event_json" ]]; then
  echo "[scenario] daemon log (last 60 lines):"
  tail -60 "$DAEMON_DIR/daemon.log" >&2 || true
  echo "[scenario] bunker log:"
  cat "$bunker_log" >&2 || true
  emit_result fail "kind:14199 not published after SIGHUP within 20s"
  _die "ASSERT: SIGHUP did not restore bunker B path"
fi

echo "[scenario]   kind:14199 published after SIGHUP ✓"
echo ""
echo "[scenario] PASS — scenario 12.7 SIGHUP reloads NIP-46 owners"
emit_result pass "SIGHUP cleared registry; kind:14199 published via bunker B"
