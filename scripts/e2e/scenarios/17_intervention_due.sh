#!/usr/bin/env bash
# E2E scenario 1.7 — Intervention arm driver + fire driver: end-to-end review event.
#
# What this tests:
#   The intervention_driver arm path and fire path work end-to-end. Given a
#   pre-seeded RAL journal Completed record and a valid project on the relay,
#   the arm driver catches up at daemon startup, arms a wakeup with a 2-second
#   timeout, and the fire driver fires that wakeup, enqueuing a kind:1 review
#   event. The publish runtime pushes it to the relay. The scenario asserts the
#   kind:1 with tag context=intervention-review arrives from the backend pubkey
#   within 20s.
#
# Setup approach:
#   - kind:14199 (whitelist) and kind:31933 (project) published to relay so the
#     daemon's ProjectEventIndex is populated on startup.
#   - RAL journal pre-seeded with a Completed record (completing_agent=agent2,
#     publishedUserVisibleEvent=true, pendingDelegationsRemain=false).
#   - Conversation file pre-seeded with user as root event author.
#   - agents/index.json byProject pre-seeded so the arm pass resolves agent1.
#   - config.json: intervention enabled, agent="agent1", timeoutSeconds=2.
#   - USER_PUBKEY added to whitelistedPubkeys.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-17-$(date +%s)-$$"
echo "[scenario] fixture_root=$fixture_root"

TENEX_INTEROP_FIXTURE_ROOT="$fixture_root" \
TENEX_INTEROP_SKIP_PUBLISH=1 \
TENEX_INTEROP_RELAY_URL="ws://placeholder" \
TENEX_INTEROP_CLI_REPO="${TENEX_INTEROP_CLI_REPO:-/Users/pablofernandez/Work/TENEX-TUI-Client-awwmtk}" \
"$repo_root/scripts/setup-nak-interop-fixture.sh" >/dev/null

harness_init "$fixture_root"

# ── Fake LLM config so the daemon won't crash on a missing model ──────────────
llms_json="$BACKEND_BASE/llms.json"
jq '.configurations = { "noop": { "provider": "mock", "model": "noop" } }
  | .default = "noop" | .summarization = "noop"
  | .supervision = "noop" | .search = "noop"
  | .promptCompilation = "noop"' \
  "$llms_json" > "$llms_json.tmp" && mv "$llms_json.tmp" "$llms_json"
chmod 600 "$llms_json"

# ── Resolve projects_base from config.json ────────────────────────────────────
projects_base="$(jq -r '.projectsBase // empty' "$BACKEND_BASE/config.json")"
if [[ -z "$projects_base" ]]; then
  projects_base="$fixture_root/projects"
fi

# ── Identifiers ───────────────────────────────────────────────────────────────
project_d_tag="$PROJECT_D_TAG"
# Synthetic 64-char hex conversation id (deterministic for the scenario).
conv_id="$(python3 -c "import hashlib; print(hashlib.sha256(b'e2e-17-conv').hexdigest())")"
# agent2 is the "completing" agent; agent1 is the intervention reviewer.
completing_agent_pubkey="$AGENT2_PUBKEY"

# ── Seed 1: RAL journal Completed record ──────────────────────────────────────
# Timestamp 10s in the past; wakeup = timestamp + 2000ms = already past due.
ral_dir="$DAEMON_DIR/ral"
mkdir -p "$ral_dir"
ts_ms=$(( ($(date +%s) - 10) * 1000 ))
cat > "$ral_dir/journal.jsonl" <<JSON
{"schemaVersion":1,"writer":"rust-daemon","writerVersion":"test","sequence":1,"timestamp":${ts_ms},"correlationId":"e2e-17-test","event":"completed","projectId":"${project_d_tag}","agentPubkey":"${completing_agent_pubkey}","conversationId":"${conv_id}","ralNumber":1,"workerId":"w-test","claimToken":"ct-test","publishedUserVisibleEvent":true,"pendingDelegationsRemain":false,"accumulatedRuntimeMs":1000,"finalEventIds":[],"keepWorkerWarm":false}
JSON
echo "[scenario] seeded RAL journal (sequence=1, completed, ts=${ts_ms}ms)"

# ── Seed 2: conversation file (user as root event author) ─────────────────────
project_base="$projects_base/$project_d_tag"
conv_dir="$project_base/.tenex/conversations"
mkdir -p "$conv_dir"
cat > "$conv_dir/${conv_id}.json" <<JSON
{
  "messages": [
    {
      "eventId": "${conv_id}",
      "senderPubkey": "${USER_PUBKEY}",
      "timestamp": $((ts_ms - 60000))
    }
  ]
}
JSON
echo "[scenario] seeded conversation file (root author=${USER_PUBKEY})"

# ── Seed 3: agents/index.json byProject entry ─────────────────────────────────
# Pre-populate so the arm pass resolves agent1's slug in this project without
# waiting for the daemon to process a 31933 event.
agents_dir="$BACKEND_BASE/agents"
jq --arg proj "$project_d_tag" \
   --arg pubkey "$AGENT1_PUBKEY" \
   '.byProject[$proj] = [$pubkey]' \
   "$agents_dir/index.json" > "$agents_dir/index.json.tmp" \
&& mv "$agents_dir/index.json.tmp" "$agents_dir/index.json"
echo "[scenario] pre-seeded agents/index.json: byProject[$project_d_tag] = [$AGENT1_PUBKEY]"

# ── Seed 4: config.json — enable intervention with 2s timeout ────────────────
cfg="$BACKEND_BASE/config.json"
jq --arg user_pubkey "$USER_PUBKEY" \
   '
   .intervention = { "enabled": true, "agent": "agent1", "timeoutSeconds": 2 }
   | .whitelistedPubkeys = ((.whitelistedPubkeys // []) + [$user_pubkey] | unique)
   ' \
   "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
echo "[scenario] configured intervention (enabled, agent=agent1, timeoutSeconds=2, user whitelisted)"

# ── Start relay ───────────────────────────────────────────────────────────────
start_local_relay --admin "$BACKEND_PUBKEY"
trap harness_cleanup EXIT

point_daemon_config_at_local_relay

# ── Publish kind:14199 and kind:31933 so the daemon builds its project index ──
echo "[scenario] publishing kind:14199 (whitelist)"
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

echo "[scenario] publishing kind:31933 (project)"
publish_event_as "$USER_NSEC" 31933 "Intervention e2e test" \
  "d=$PROJECT_D_TAG" \
  "title=Intervention E2E" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# ── Start daemon ──────────────────────────────────────────────────────────────
start_daemon

await_daemon_subscribed 45 || _die "daemon subscription never became live"

# ── Wait for the intervention review kind:1 from backend pubkey ───────────────
echo ""
echo "[scenario] waiting up to 10s for intervention review event (kind:1, context=intervention-review, author=backend)..."

saw_review=0

# Poll for the intervention review event (no GNU timeout needed; use deadline loop).
events=""
poll_deadline=$(( $(date +%s) + 20 ))
lim=20
while [[ $(date +%s) -lt $poll_deadline ]]; do
  events="$(nak req -k 1 -a "$BACKEND_PUBKEY" --tag "context=intervention-review" \
    --limit "$lim" --auth --sec "$BACKEND_NSEC" "$HARNESS_RELAY_URL" 2>/dev/null || true)"
  [[ -n "$events" ]] && [[ "$events" != "[]" ]] && break
  lim=$(( lim + 1 ))
  sleep 0.5
done

if [[ -n "$events" ]] && [[ "$events" != "[]" ]]; then
  echo "[scenario]   received intervention review event ✓"
  printf '%s\n' "$events" | head -1 | jq -r '"[scenario]   event id=\(.id) pubkey=\(.pubkey) kind=\(.kind)"'
  printf '%s\n' "$events" | head -1 | jq -e \
    --arg pk "$BACKEND_PUBKEY" '.pubkey == $pk' \
    >/dev/null 2>&1 \
    || _die "ASSERT: event pubkey is not BACKEND_PUBKEY"
  printf '%s\n' "$events" | head -1 | jq -e '.kind == 1' \
    >/dev/null 2>&1 \
    || _die "ASSERT: event kind is not 1"
  printf '%s\n' "$events" | head -1 | jq -e \
    'any(.tags[]; .[0] == "context" and .[1] == "intervention-review")' \
    >/dev/null 2>&1 \
    || _die "ASSERT: event does not have context=intervention-review tag"
  saw_review=1
fi

if [[ "$saw_review" -ne 1 ]]; then
  echo "[scenario] daemon log (last 80 lines):"
  tail -80 "$HARNESS_DAEMON_LOG" >&2 || true
  _die "ASSERT: intervention review kind:1 from backend never appeared on relay within 20s"
fi

echo ""
echo "[scenario] PASS — scenario 1.7 (intervention arm driver + fire driver)"
emit_result pass "intervention review kind:1 published to relay within 20s of daemon start"
