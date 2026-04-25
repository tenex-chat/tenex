#!/usr/bin/env bash
# E2E scenario 2.1 — Agent hot-reload: add agent2 to a booted project.
#
# Setup:
#   - Project booted with only agent1 in the kind:31933 p-tags.
#   - kind:1 to agent1 dispatches normally (Phase A).
#
# Trigger:
#   - Publish a NEWER kind:31933 (higher created_at) adding agent2 to p-tags.
#
# Expected observable outcomes:
#   1. Daemon logs "project_updated" for the new 31933.
#   2. agents/index.json byProject entry for our project includes agent2's pubkey.
#   3. Daemon logs "nostr subscription filters refreshed" (subscription expanded).
#   4. kind:1 to agent2 is dispatched after the filter refresh.
#   5. agent1's pre-hot-reload dispatch queue entry is still present — regression
#      guard for commit 56fbae67 (re-ingressing kind:31933 must not blitz the
#      per-project index).
#
# No LLM output required. This is pure daemon plumbing.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

MOCK_FIXTURE_PATH="$repo_root/scripts/e2e/fixtures/mock-llm/21_agent_hot_reload.json"
MOCK_MODEL_ID="mock/agent-hot-reload-21"

[[ -f "$MOCK_FIXTURE_PATH" ]] || _die "mock fixture missing at $MOCK_FIXTURE_PATH"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-21-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

echo "[scenario] rewriting llms.json to use mock fixture model '$MOCK_MODEL_ID'"
llms_json="$BACKEND_BASE/llms.json"
jq --arg model "$MOCK_MODEL_ID" '
    .configurations = {
      "mock-hot-reload-21": { "provider": "mock", "model": $model }
    }
    | .default = "mock-hot-reload-21"
    | .summarization = "mock-hot-reload-21"
    | .supervision = "mock-hot-reload-21"
    | .search = "mock-hot-reload-21"
    | .promptCompilation = "mock-hot-reload-21"
  ' "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
chmod 600 "$llms_json"

export USE_MOCK_LLM=true
export TENEX_MOCK_LLM_FIXTURE="$MOCK_FIXTURE_PATH"
echo "[scenario] mock LLM enabled: fixture=$TENEX_MOCK_LLM_FIXTURE"

now="$(date +%s)"
ts_initial=$(( now - 60 ))   # 1 minute in the past — initial project revision
ts_updated=$(( now + 60 ))   # 1 minute in the future — unambiguously newer

start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT
point_daemon_config_at_local_relay

echo "[scenario] publishing kind:14199 (whitelist) with agent1 only for now"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

echo "[scenario] publishing initial kind:31933 (project) with agent1 ONLY in p-tags (ts=$ts_initial)"
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

initial_31933="$(publish_event_at "$USER_NSEC" 31933 "$ts_initial" "Hot-reload test project" \
  "d=$PROJECT_D_TAG" \
  "title=Hot-Reload Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY")"
initial_31933_id="$(printf '%s' "$initial_31933" | jq -r .id)"
echo "[scenario]   initial 31933 id=$initial_31933_id (agent1 only)"

start_daemon
await_daemon_subscribed 45 || {
  emit_result fail "daemon subscription never became live"
  exit 1
}

# ── Phase 1: boot the project and verify dispatch to agent1 ──────────────────
echo "[scenario] phase 1: booting project and dispatching to agent1"

echo "[scenario]   publishing kind:24000 (boot) as user"
boot_evt="$(publish_event_as "$USER_NSEC" 24000 "boot" "a=$PROJECT_A_TAG")"
boot_id="$(printf '%s' "$boot_evt" | jq -r .id)"
echo "[scenario]   boot event id=$boot_id"

echo "[scenario]   waiting for project_booted log line..."
boot_deadline=$(( $(date +%s) + 30 ))
saw_boot=0
while [[ $(date +%s) -lt $boot_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -q '"code":"project_booted"' "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_boot=1
    break
  fi
  sleep 0.2
done
if [[ "$saw_boot" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "daemon.log has no project_booted line after boot event"
  exit 1
fi
echo "[scenario]   project_booted logged ✓"

echo "[scenario]   publishing kind:1 to agent1"
agent1_msg_evt="$(publish_event_as "$USER_NSEC" 1 "hello agent1 pre-reload" \
  "p=$AGENT1_PUBKEY" \
  "a=$PROJECT_A_TAG")"
agent1_msg_id="$(printf '%s' "$agent1_msg_evt" | jq -r .id)"
echo "[scenario]   agent1 kind:1 id=$agent1_msg_id"

echo "[scenario]   waiting for agent1 dispatch to appear in queue..."
queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
agent1_dispatch_deadline=$(( $(date +%s) + 20 ))
saw_agent1_dispatch=0
while [[ $(date +%s) -lt $agent1_dispatch_deadline ]]; do
  if [[ -f "$queue" ]] && jq -se --arg e "$agent1_msg_id" \
       'any(.[]; (.triggeringEventId // .triggering_event_id) == $e)' "$queue" \
       >/dev/null 2>&1; then
    saw_agent1_dispatch=1
    break
  fi
  sleep 0.2
done
if [[ "$saw_agent1_dispatch" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "ASSERT: no dispatch for agent1 kind:1 before hot-reload"
  exit 1
fi
echo "[scenario]   agent1 dispatch enqueued ✓"

echo "[scenario] === Phase 1 complete: initial dispatch to agent1 OK ==="

# ── Phase 2: hot-reload — publish updated kind:31933 adding agent2 ───────────
echo "[scenario] phase 2: publishing NEWER kind:31933 adding agent2 (ts=$ts_updated)"

pre_update_log_count="$(grep -c '"code":"project_updated"' "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"

updated_31933="$(publish_event_at "$USER_NSEC" 31933 "$ts_updated" "Hot-reload test project (updated)" \
  "d=$PROJECT_D_TAG" \
  "title=Hot-Reload Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY")"
updated_31933_id="$(printf '%s' "$updated_31933" | jq -r .id)"
echo "[scenario]   updated 31933 id=$updated_31933_id (agent1 + agent2)"

echo "[scenario]   waiting for daemon to log project_updated for the new 31933..."
project_update_deadline=$(( $(date +%s) + 30 ))
saw_project_updated=0
while [[ $(date +%s) -lt $project_update_deadline ]]; do
  post_count="$(grep -c '"code":"project_updated"' "$DAEMON_DIR/daemon.log" 2>/dev/null || echo 0)"
  if [[ "$post_count" -gt "$pre_update_log_count" ]]; then
    saw_project_updated=1
    break
  fi
  sleep 0.2
done
if [[ "$saw_project_updated" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "ASSERT: daemon never logged project_updated after newer 31933"
  exit 1
fi
echo "[scenario]   project_updated logged for new 31933 ✓"

# ── Phase 3: verify agents/index.json contains agent2 ────────────────────────
echo "[scenario] phase 3: verifying agents/index.json byProject contains agent2"

index_deadline=$(( $(date +%s) + 10 ))
saw_agent2_in_index=0
while [[ $(date +%s) -lt $index_deadline ]]; do
  if [[ -f "$BACKEND_BASE/agents/index.json" ]] && \
     jq -e --arg d "$PROJECT_D_TAG" --arg p "$AGENT2_PUBKEY" \
       '.byProject[$d] | arrays | index($p) != null' \
       "$BACKEND_BASE/agents/index.json" >/dev/null 2>&1; then
    saw_agent2_in_index=1
    break
  fi
  sleep 0.2
done
if [[ "$saw_agent2_in_index" -ne 1 ]]; then
  echo "[scenario] agents/index.json current contents:"
  jq . "$BACKEND_BASE/agents/index.json" >&2 || true
  emit_result fail "ASSERT: agents/index.json byProject[$PROJECT_D_TAG] does not contain agent2 pubkey"
  exit 1
fi
echo "[scenario]   agents/index.json byProject[$PROJECT_D_TAG] contains agent2 ✓"

# Also verify agent1 is still in the index (regression: 56fbae67)
if ! jq -e --arg d "$PROJECT_D_TAG" --arg p "$AGENT1_PUBKEY" \
     '.byProject[$d] | arrays | index($p) != null' \
     "$BACKEND_BASE/agents/index.json" >/dev/null 2>&1; then
  echo "[scenario] agents/index.json current contents:"
  jq . "$BACKEND_BASE/agents/index.json" >&2 || true
  emit_result fail "ASSERT: regression 56fbae67 — agent1 dropped from index after re-ingress of 31933"
  exit 1
fi
echo "[scenario]   agents/index.json still contains agent1 (regression guard ✓)"

echo "[scenario] === Phase 3 complete: index updated correctly ==="

# ── Phase 4: verify subscription filter refresh ───────────────────────────────
echo "[scenario] phase 4: verifying subscription filter refresh in daemon log"

filter_refresh_deadline=$(( $(date +%s) + 20 ))
saw_filter_refresh=0
while [[ $(date +%s) -lt $filter_refresh_deadline ]]; do
  if [[ -f "$DAEMON_DIR/daemon.log" ]] && \
     grep -q "nostr subscription filters refreshed" "$DAEMON_DIR/daemon.log" 2>/dev/null; then
    saw_filter_refresh=1
    break
  fi
  sleep 0.2
done
if [[ "$saw_filter_refresh" -ne 1 ]]; then
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "ASSERT: daemon never logged 'nostr subscription filters refreshed' after 31933 update"
  exit 1
fi
echo "[scenario]   subscription filter refresh logged ✓"

echo "[scenario] === Phase 4 complete: filter refresh confirmed ==="

# ── Phase 5: wait for daemon to subscribe to agent2, then dispatch kind:1 ────
# After a filter refresh, the daemon sends CLOSE + new REQ. There is a brief
# window (Khatru per-filter addListener race) between REQ-sent and
# listener-registered. We use the same probe-and-poll strategy as
# await_daemon_subscribed to confirm agent2's filter is live.
echo "[scenario] phase 5: probing for agent2 filter liveness before publishing"

agent2_filter_live=0
for attempt in 1 2 3 4 5 6; do
  probe_evt="$(nak event --sec "$USER_NSEC" -k 14199 \
    -c "harness probe agent2 filter a=$attempt t=$(date +%s%N)" \
    --tag "p=$AGENT2_PUBKEY" \
    "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  probe_id="$(printf '%s' "$probe_evt" | jq -r '.id // empty' 2>/dev/null)"
  if [[ -z "$probe_id" ]]; then
    sleep 1
    continue
  fi

  for poll in 1 2 3 4 5 6 7 8; do
    if [[ -f "$DAEMON_DIR/daemon.log" ]] && grep -q "$probe_id" "$DAEMON_DIR/daemon.log"; then
      echo "[scenario]   agent2 filter live (probe #$attempt round-tripped)"
      agent2_filter_live=1
      break 2
    fi
    sleep 0.2
  done
done

if [[ "$agent2_filter_live" -ne 1 ]]; then
  echo "[scenario] WARN: agent2 filter probe did not round-trip — known Khatru race; proceeding"
  echo "[scenario]   (this is the ~18% harness flake documented in websocket-disconnect-investigation.md)"
fi

echo "[scenario]   publishing kind:1 to agent2"
agent2_msg_evt="$(publish_event_as "$USER_NSEC" 1 "hello agent2 post-reload" \
  "p=$AGENT2_PUBKEY" \
  "a=$PROJECT_A_TAG")"
agent2_msg_id="$(printf '%s' "$agent2_msg_evt" | jq -r .id)"
echo "[scenario]   agent2 kind:1 id=$agent2_msg_id"

echo "[scenario]   waiting for agent2 dispatch to appear in queue..."
agent2_dispatch_deadline=$(( $(date +%s) + 30 ))
saw_agent2_dispatch=0
while [[ $(date +%s) -lt $agent2_dispatch_deadline ]]; do
  if [[ -f "$queue" ]] && jq -se --arg e "$agent2_msg_id" \
       'any(.[]; (.triggeringEventId // .triggering_event_id) == $e)' "$queue" \
       >/dev/null 2>&1; then
    saw_agent2_dispatch=1
    break
  fi
  sleep 0.2
done

if [[ "$saw_agent2_dispatch" -ne 1 ]]; then
  # Check if this looks like the Khatru subscription race
  if [[ "$agent2_filter_live" -ne 1 ]]; then
    tail -20 "$DAEMON_DIR/daemon.log" >&2 || true
    emit_result fail "harness flake: agent2 filter never became live (Khatru per-filter addListener race) — see websocket-disconnect-investigation.md"
    exit 1
  fi
  tail -40 "$DAEMON_DIR/daemon.log" >&2 || true
  emit_result fail "ASSERT: no dispatch for agent2 kind:1 after hot-reload"
  exit 1
fi
echo "[scenario]   agent2 dispatch enqueued ✓"

echo "[scenario] === Phase 5 complete: agent2 dispatches after hot-reload ==="

# ── Phase 6: regression guard — agent1's pre-reload dispatch is unchanged ─────
echo "[scenario] phase 6: regression guard (commit 56fbae67) — agent1 dispatch still in queue"
if ! jq -se --arg e "$agent1_msg_id" \
     'any(.[]; (.triggeringEventId // .triggering_event_id) == $e)' "$queue" \
     >/dev/null 2>&1; then
  echo "[scenario] dispatch queue contents:"
  jq . "$queue" >&2 || true
  emit_result fail "ASSERT: regression 56fbae67 — agent1 pre-reload dispatch vanished from queue after 31933 re-ingest"
  exit 1
fi
echo "[scenario]   agent1 pre-reload dispatch still in queue ✓"

echo ""
echo "[scenario] PASS — scenario 2.1 Agent hot-reload"
emit_result pass "agent2 added to index; filter refreshed; agent2 dispatched; agent1 index/dispatch unchanged"
