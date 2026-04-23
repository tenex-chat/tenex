#!/usr/bin/env bash
# TENEX e2e test harness
#
# Source this from a test script after the test has invoked
# scripts/setup-nak-interop-fixture.sh and obtained a fixture root.
# Then call `harness_init <fixture_root>` to load fixture state into
# the environment, followed by `start_local_relay`, `start_daemon`, etc.
#
# All harness functions log to stderr with the prefix "[harness]".
# Functions return non-zero on timeout or assertion failure.
#
# Required external tools: nak, jq, curl, python3 (for free-port pick).

set -uo pipefail

# === Configuration ============================================================

HARNESS_RELAY_BIN="${HARNESS_RELAY_BIN:-/Users/pablofernandez/Work/tenex-launcher/relay/tenex-relay}"
HARNESS_REPO_ROOT="${HARNESS_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Models pre-configured in the fixture's llms.json
HARNESS_DEFAULT_MODEL="${HARNESS_DEFAULT_MODEL:-qwen3.5}"

# Default polling intervals (seconds)
HARNESS_POLL_INTERVAL="${HARNESS_POLL_INTERVAL:-0.5}"
HARNESS_DEFAULT_TIMEOUT="${HARNESS_DEFAULT_TIMEOUT:-30}"

# === Logging ==================================================================

_log() { printf '[harness] %s\n' "$*" >&2; }
_die() { _log "FATAL: $*"; exit 1; }

# === Fixture loading ==========================================================

# harness_init <fixture_root>
# Reads <fixture_root>/backend/interop-fixture.json and exports keys/pubkeys/IDs
# as environment variables. Sets TENEX_BASE_DIR.
harness_init() {
  local fixture_root="${1:?fixture_root required}"
  local manifest="$fixture_root/backend/interop-fixture.json"
  [[ -f "$manifest" ]] || _die "fixture manifest not found at $manifest"

  export FIXTURE_ROOT="$fixture_root"
  export BACKEND_BASE
  BACKEND_BASE="$(jq -r .backendBaseDir "$manifest")"
  export TENEX_BASE_DIR="$BACKEND_BASE"
  export DAEMON_DIR="$BACKEND_BASE/daemon"

  export USER_PUBKEY BACKEND_PUBKEY TRANSPARENT_PUBKEY AGENT1_PUBKEY AGENT2_PUBKEY
  export PROJECT_D_TAG PROJECT_A_TAG WHITELIST_14199_EVENT_ID PROJECT_31933_EVENT_ID

  USER_PUBKEY="$(jq -r .userPubkey "$manifest")"
  BACKEND_PUBKEY="$(jq -r .backendPubkey "$manifest")"
  TRANSPARENT_PUBKEY="$(jq -r .agentPubkeys.transparent "$manifest")"
  AGENT1_PUBKEY="$(jq -r .agentPubkeys.agent1 "$manifest")"
  AGENT2_PUBKEY="$(jq -r .agentPubkeys.agent2 "$manifest")"
  PROJECT_D_TAG="$(jq -r .projectDTag "$manifest")"
  PROJECT_A_TAG="$(jq -r .projectATag "$manifest")"
  WHITELIST_14199_EVENT_ID="$(jq -r '.publishedEvents.whitelist14199 // empty' "$manifest")"
  PROJECT_31933_EVENT_ID="$(jq -r '.publishedEvents.project31933 // empty' "$manifest")"

  # nsecs are not in the manifest (chmod 600 manifest doesn't include them).
  # The fixture writes them into the cli config and individual agent files.
  export USER_NSEC BACKEND_NSEC AGENT1_NSEC AGENT2_NSEC TRANSPARENT_NSEC
  USER_NSEC="$(jq -r .credentials.key "$BACKEND_BASE/cli/config.json")"
  AGENT1_NSEC="$(jq -r .nsec "$BACKEND_BASE/agents/${AGENT1_PUBKEY}.json")"
  AGENT2_NSEC="$(jq -r .nsec "$BACKEND_BASE/agents/${AGENT2_PUBKEY}.json")"
  TRANSPARENT_NSEC="$(jq -r .nsec "$BACKEND_BASE/agents/${TRANSPARENT_PUBKEY}.json")"

  # Backend key is stored hex in backend/config.json; convert to nsec via nak.
  local backend_hex
  backend_hex="$(jq -r .tenexPrivateKey "$BACKEND_BASE/config.json")"
  BACKEND_NSEC="$(nak encode nsec "$backend_hex")"

  _log "fixture loaded from $fixture_root"
  _log "  backend pubkey:  $BACKEND_PUBKEY"
  _log "  user pubkey:     $USER_PUBKEY"
  _log "  agent1 pubkey:   $AGENT1_PUBKEY"
  _log "  agent2 pubkey:   $AGENT2_PUBKEY"
  _log "  project a-tag:   $PROJECT_A_TAG"
}

# === Relay lifecycle ==========================================================

# start_local_relay --admin <hex>...
# Starts tenex-relay on a free port with isolated data dir. Disables upstream sync.
# Sets HARNESS_RELAY_URL and HARNESS_RELAY_PID.
start_local_relay() {
  local admins=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --admin) admins+=("$2"); shift 2 ;;
      *) _die "start_local_relay: unknown arg: $1" ;;
    esac
  done

  [[ -x "$HARNESS_RELAY_BIN" ]] || _die "relay binary not executable at $HARNESS_RELAY_BIN"

  HARNESS_RELAY_PORT="$(_pick_free_port)"
  HARNESS_RELAY_DATA="$FIXTURE_ROOT/relay-data"
  HARNESS_RELAY_CONFIG="$FIXTURE_ROOT/relay-config.json"
  HARNESS_RELAY_LOG="$FIXTURE_ROOT/relay.log"

  mkdir -p "$HARNESS_RELAY_DATA"

  local admin_json
  if [[ ${#admins[@]} -gt 0 ]]; then
    admin_json="$(printf '%s\n' "${admins[@]}" | jq -R . | jq -sc .)"
  else
    admin_json='[]'
  fi

  jq -n \
    --argjson port "$HARNESS_RELAY_PORT" \
    --arg data_dir "$HARNESS_RELAY_DATA" \
    --argjson admins "$admin_json" \
    '{
      port: $port,
      bind_address: "127.0.0.1",
      data_dir: $data_dir,
      nip11: {
        name: "tenex-test", description: "test relay", pubkey: "", contact: "",
        supported_nips: [1,2,4,9,11,12,16,20,22,33,40,42,77],
        software: "tenex-khatru-relay", version: "test"
      },
      limits: {
        max_message_length: 2097152, max_subscriptions: 200, max_filters: 50,
        max_event_tags: 8192, max_content_length: 1048576,
        default_query_limit: 100, max_query_limit: 500, max_query_window_hours: 168
      },
      sync: { relays: [], kinds: [] },
      admin_pubkeys: $admins
    }' > "$HARNESS_RELAY_CONFIG"

  _log "starting relay on 127.0.0.1:$HARNESS_RELAY_PORT (admins=${#admins[@]})"
  TENEX_BASE_DIR="$BACKEND_BASE" \
    "$HARNESS_RELAY_BIN" -config "$HARNESS_RELAY_CONFIG" \
    >"$HARNESS_RELAY_LOG" 2>&1 &
  HARNESS_RELAY_PID=$!

  if ! _await_url "http://127.0.0.1:$HARNESS_RELAY_PORT/health" 10; then
    _log "relay log tail:"; tail -20 "$HARNESS_RELAY_LOG" >&2 || true
    _die "relay never became healthy"
  fi

  export HARNESS_RELAY_URL="ws://127.0.0.1:$HARNESS_RELAY_PORT"
  _log "relay ready at $HARNESS_RELAY_URL"
}

stop_local_relay() {
  if [[ -n "${HARNESS_RELAY_PID:-}" ]]; then
    _log "stopping relay pid $HARNESS_RELAY_PID"
    kill -TERM "$HARNESS_RELAY_PID" 2>/dev/null || true
    wait "$HARNESS_RELAY_PID" 2>/dev/null || true
    unset HARNESS_RELAY_PID
  fi
}

# point_daemon_config_at_local_relay
# Rewrites $BACKEND_BASE/config.json so .relays = [HARNESS_RELAY_URL].
# Call after start_local_relay and before start_daemon.
point_daemon_config_at_local_relay() {
  [[ -n "${HARNESS_RELAY_URL:-}" ]] || _die "HARNESS_RELAY_URL unset; call start_local_relay first"
  local cfg="$BACKEND_BASE/config.json"
  [[ -f "$cfg" ]] || _die "backend config.json missing at $cfg"
  jq --arg url "$HARNESS_RELAY_URL" '.relays = [$url]' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"
  _log "daemon config relays -> [$HARNESS_RELAY_URL]"
}

# === Daemon lifecycle =========================================================

# start_daemon
# Starts the daemon with TENEX_BASE_DIR, waits for the lockfile to appear.
# Sets HARNESS_DAEMON_PID.
start_daemon() {
  HARNESS_DAEMON_LOG="$FIXTURE_ROOT/daemon.log"
  _log "starting daemon (TENEX_BASE_DIR=$TENEX_BASE_DIR)"

  ( cd "$HARNESS_REPO_ROOT" && \
    TENEX_BASE_DIR="$TENEX_BASE_DIR" \
    cargo run --release -p tenex-daemon --bin daemon -- \
      --tenex-base-dir "$TENEX_BASE_DIR" \
      >"$HARNESS_DAEMON_LOG" 2>&1 ) &
  HARNESS_DAEMON_PID=$!

  if ! _await_file "$DAEMON_DIR/tenex.lock" 60; then
    _log "daemon log tail:"; tail -30 "$HARNESS_DAEMON_LOG" >&2 || true
    _die "daemon never wrote lockfile"
  fi
  _log "daemon ready (pid $HARNESS_DAEMON_PID, lock at $DAEMON_DIR/tenex.lock)"
}

stop_daemon() {
  if [[ -n "${HARNESS_DAEMON_PID:-}" ]]; then
    _log "stopping daemon pid $HARNESS_DAEMON_PID (SIGTERM)"
    kill -TERM "$HARNESS_DAEMON_PID" 2>/dev/null || true
    wait "$HARNESS_DAEMON_PID" 2>/dev/null || true
    unset HARNESS_DAEMON_PID
  fi
}

# crash_daemon: SIGKILL — leaves stale lockfile, in-flight RAL/dispatch state
crash_daemon() {
  if [[ -n "${HARNESS_DAEMON_PID:-}" ]]; then
    _log "crashing daemon pid $HARNESS_DAEMON_PID (SIGKILL)"
    kill -9 "$HARNESS_DAEMON_PID" 2>/dev/null || true
    wait "$HARNESS_DAEMON_PID" 2>/dev/null || true
    unset HARNESS_DAEMON_PID
  fi
}

# kill_worker <pid>: targeted SIGKILL on a worker process
kill_worker() {
  local pid="${1:?pid required}"
  _log "killing worker pid $pid (SIGKILL)"
  kill -9 "$pid" 2>/dev/null || true
}

# list_worker_pids: emit currently running worker PIDs (one per line)
list_worker_pids() {
  pgrep -f "tenex-daemon-worker|agent-worker" 2>/dev/null || true
}

# === Whitelist management =====================================================

# seed_whitelist_file <pubkey>...
# Writes pubkeys to <DAEMON_DIR>/whitelist.txt — picked up by the relay's ACL
# poller within ~2s. Useful for tests that need a pubkey whitelisted before any
# kind:14199 is published.
seed_whitelist_file() {
  local path="$DAEMON_DIR/whitelist.txt"
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$@" > "$path"
  _log "wrote $# pubkey(s) to $path"
}

clear_whitelist_file() {
  rm -f "$DAEMON_DIR/whitelist.txt"
}

# === Event publishing (uses HARNESS_RELAY_URL) ================================

# publish_event_as <nsec> <kind> <content> [tag-spec...]
# Each tag-spec uses nak's --tag syntax: "<name>=<value>", e.g. "p=<pubkey>"
# or "a=31933:<owner>:<dtag>". For multi-value tags use semicolons:
# "e=<id>;<relay>;<marker>". Echoes the event JSON.
publish_event_as() {
  local nsec="${1:?nsec}"; shift
  local kind="${1:?kind}"; shift
  local content="${1:-}"; shift || true

  local nak_args=(event --sec "$nsec" -k "$kind" -c "$content")
  for tag in "$@"; do
    nak_args+=(--tag "$tag")
  done
  nak_args+=("$HARNESS_RELAY_URL")

  nak "${nak_args[@]}"
}

# === Polling helpers ==========================================================

# await_dispatch_status <dispatch_id> <status> [timeout_seconds]
# Polls the dispatch queue JSONL until a record with the given dispatch_id has
# the given status, or until timeout.
await_dispatch_status() {
  local dispatch_id="${1:?dispatch_id}"
  local status="${2:?status}"
  local timeout="${3:-$HARNESS_DEFAULT_TIMEOUT}"
  local queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"

  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -f "$queue" ]] && jq -e \
        --arg id "$dispatch_id" --arg s "$status" \
        'select((.dispatchId // .dispatch_id) == $id and (.status // .lifecycle_status) == $s)' \
        "$queue" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HARNESS_POLL_INTERVAL"
  done
  _log "TIMEOUT: dispatch_id=$dispatch_id never reached status=$status"
  return 1
}

# await_kind_event <kind> [d-tag] [author] [timeout_seconds]
# Polls the relay (over websocket via nak req) until at least one matching event
# is returned. Echoes the first event JSON.
#
# Authenticates as BACKEND_NSEC (admin on the harness relay).
# Varies --limit per iteration to dodge the relay's historicalQueryReplayGuard,
# which short-circuits repeated identical filters within ~5s with LimitZero.
await_kind_event() {
  local kind="${1:?kind}"
  local d_tag="${2:-}"
  local author="${3:-}"
  local timeout="${4:-$HARNESS_DEFAULT_TIMEOUT}"

  [[ -n "${HARNESS_RELAY_URL:-}" ]] || _die "HARNESS_RELAY_URL unset"
  [[ -n "${BACKEND_NSEC:-}" ]] || _die "BACKEND_NSEC unset; call harness_init first"

  local deadline=$(( $(date +%s) + timeout ))
  local lim=20
  while [[ $(date +%s) -lt $deadline ]]; do
    local args=(req -k "$kind" --limit "$lim" --auth --sec "$BACKEND_NSEC")
    [[ -n "$d_tag" ]] && args+=(-d "$d_tag")
    [[ -n "$author" ]] && args+=(-a "$author")
    args+=("$HARNESS_RELAY_URL")
    local out
    out="$(nak "${args[@]}" 2>/dev/null || true)"
    if [[ -n "$out" ]] && [[ "$out" != "[]" ]]; then
      printf '%s\n' "$out" | head -1
      return 0
    fi
    lim=$((lim + 1))
    sleep "$HARNESS_POLL_INTERVAL"
  done
  _log "TIMEOUT: no kind=$kind d=$d_tag author=$author event seen"
  return 1
}

# await_ral_journal <jq-filter> [timeout_seconds]
# Polls the RAL journal until a record matching the jq filter exists.
# Example: await_ral_journal '.event == "delegationCompleted" and .conversationId == "abc"'
await_ral_journal() {
  local filter="${1:?jq filter}"
  local timeout="${2:-$HARNESS_DEFAULT_TIMEOUT}"
  local journal="$DAEMON_DIR/ral/journal.jsonl"

  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if [[ -f "$journal" ]] && jq -e "select($filter)" "$journal" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HARNESS_POLL_INTERVAL"
  done
  _log "TIMEOUT: RAL journal predicate did not match: $filter"
  return 1
}

# === Filesystem assertions ====================================================

# assert_dispatch_state <dispatch_id> <expected_status>
assert_dispatch_state() {
  local dispatch_id="${1:?dispatch_id}"
  local expected="${2:?expected status}"
  local queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
  [[ -f "$queue" ]] || _die "ASSERT FAIL: dispatch queue missing at $queue"

  local actual
  actual="$(jq -r --arg id "$dispatch_id" \
    'select((.dispatchId // .dispatch_id) == $id) | (.status // .lifecycle_status)' \
    "$queue" 2>/dev/null | tail -1)"
  [[ "$actual" == "$expected" ]] || \
    _die "ASSERT FAIL: dispatch $dispatch_id has status=$actual, expected=$expected"
}

# assert_no_dispatch <dispatch_id>
assert_no_dispatch() {
  local dispatch_id="${1:?dispatch_id}"
  local queue="$DAEMON_DIR/workers/dispatch-queue.jsonl"
  [[ -f "$queue" ]] || return 0
  if jq -e --arg id "$dispatch_id" \
      'select((.dispatchId // .dispatch_id) == $id)' "$queue" >/dev/null 2>&1; then
    _die "ASSERT FAIL: dispatch $dispatch_id should not exist"
  fi
}

# assert_ral_journal_contains <jq-filter>
assert_ral_journal_contains() {
  local filter="${1:?jq filter}"
  local journal="$DAEMON_DIR/ral/journal.jsonl"
  [[ -f "$journal" ]] || _die "ASSERT FAIL: RAL journal missing at $journal"
  if ! jq -e "select($filter)" "$journal" >/dev/null 2>&1; then
    _die "ASSERT FAIL: RAL journal does not contain match for: $filter"
  fi
}

# assert_event_on_relay <kind> [d-tag] [author]
# Asserts at least one matching event exists on the relay (no timeout — instant check).
assert_event_on_relay() {
  local kind="${1:?kind}"
  local d_tag="${2:-}"
  local author="${3:-}"
  local args=(req -k "$kind" --limit 1)
  [[ -n "$d_tag" ]] && args+=(-d "$d_tag")
  [[ -n "$author" ]] && args+=(-a "$author")
  args+=("$HARNESS_RELAY_URL")
  local out
  out="$(nak "${args[@]}" 2>/dev/null || true)"
  [[ -n "$out" && "$out" != "[]" ]] || \
    _die "ASSERT FAIL: no kind=$kind d=$d_tag author=$author event on relay"
}

# === Cleanup ==================================================================

# Use: trap harness_cleanup EXIT
harness_cleanup() {
  local rc=$?
  _log "cleanup (script exit code=$rc)"
  stop_daemon || true
  stop_local_relay || true
  return $rc
}

# === Internal helpers =========================================================

_pick_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

_await_url() {
  local url="${1:?url}"
  local timeout="${2:-10}"
  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  return 1
}

_await_file() {
  local path="${1:?path}"
  local timeout="${2:-30}"
  local deadline=$(( $(date +%s) + timeout ))
  while [[ $(date +%s) -lt $deadline ]]; do
    [[ -e "$path" ]] && return 0
    sleep "$HARNESS_POLL_INTERVAL"
  done
  return 1
}

# Sanity check on source
for tool in nak jq curl python3; do
  command -v "$tool" >/dev/null 2>&1 || _log "WARN: required tool '$tool' not found on PATH"
done
