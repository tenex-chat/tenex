#!/usr/bin/env bash
# E2E scenario 14.4 — Telegram outbox drain round-trip.
#
# Setup:
#   - Agent1's config has a botToken + apiBaseUrl pointing at a local mock
#     Telegram HTTP server (so no real bot API is needed).
#   - A TelegramOutboxRecord is written directly to the pending outbox dir,
#     mimicking what the worker's send_message tool produces.
#
# Trigger:
#   - Daemon boots. The TelegramOutboxDriverDeps wires Agent1's publisher
#     registry. The driver drains the pending record immediately.
#
# Expected:
#   - The mock Telegram server receives a sendMessage POST request.
#   - The pending outbox record moves to the delivered/ dir.
#   - No daemon panic.
#
# This directly exercises the wiring added in d9191539 (fix: wire
# TelegramPublisherRegistry into outbox driver).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$repo_root/scripts/e2e/_bootstrap.sh"
source "$repo_root/scripts/e2e-test-harness.sh"

fixture_root="${TMPDIR:-/tmp}/tenex-e2e-144-$(date +%s)-$$"
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

# Seed the whitelist file so the relay accepts probe events from USER_NSEC,
# allowing await_daemon_subscribed to confirm the daemon's subscription is live.
seed_whitelist_file "$USER_PUBKEY" "$BACKEND_PUBKEY"

# Whitelist all participants.
publish_event_as "$USER_NSEC" 14199 "" \
  "p=$USER_PUBKEY" \
  "p=$BACKEND_PUBKEY" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

publish_event_as "$USER_NSEC" 31933 "Telegram outbox test" \
  "d=$PROJECT_D_TAG" \
  "title=Telegram Outbox Test" \
  "p=$TRANSPARENT_PUBKEY" \
  "p=$AGENT1_PUBKEY" \
  "p=$AGENT2_PUBKEY" >/dev/null

# --- Start a minimal mock Telegram HTTP server using Python ---
mock_port="$(_pick_free_port)"
mock_log="$fixture_root/mock-telegram.log"
mock_received="$fixture_root/mock-received.txt"

python3 <<PYEOF >"$mock_log" 2>&1 &
import http.server, json, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        with open('$mock_received', 'a') as f:
            f.write(self.path + '\n')
            f.write(body.decode('utf-8', errors='replace') + '\n')
        resp = json.dumps({
            'ok': True,
            'result': {'message_id': 42, 'chat': {'id': -100123, 'type': 'supergroup'}}
        }).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def do_GET(self):
        resp = b'mock telegram server'
        self.send_response(200)
        self.send_header('Content-Length', str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, fmt, *args):
        pass

http.server.HTTPServer(('127.0.0.1', $mock_port), Handler).serve_forever()
PYEOF
MOCK_TELEGRAM_PID=$!

# Wait for mock server to be ready.
mock_deadline=$(( $(date +%s) + 5 ))
while [[ $(date +%s) -lt $mock_deadline ]]; do
  status_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$mock_port/" 2>/dev/null || echo 0)"
  if [[ "$status_code" != "0" ]]; then
    break
  fi
  sleep 0.2
done
echo "[scenario] mock Telegram server on port $mock_port (pid $MOCK_TELEGRAM_PID)"

# Patch Agent1's config to include a Telegram bot token pointing at the mock.
agent1_config="$TENEX_BASE_DIR/agents/${AGENT1_PUBKEY}.json"
[[ -f "$agent1_config" ]] || _die "agent1 config not found at $agent1_config"
jq --arg token "12345:TESTTOKEN" \
   --arg url "http://127.0.0.1:$mock_port" \
   '. + {telegram: {botToken: $token, apiBaseUrl: $url}}' \
   "$agent1_config" > "$agent1_config.tmp" && mv "$agent1_config.tmp" "$agent1_config"

# Write a TelegramOutboxRecord directly to the pending dir. This is exactly
# what the worker's send_message tool produces via accept_telegram_delivery_request.
pending_dir="$DAEMON_DIR/transport-outbox/telegram/pending"
mkdir -p "$pending_dir"

nostr_event_id="$(printf 'e2e144test%054d' 1)"
record_id="tg-$(printf '%s' "$nostr_event_id" | sha256sum | cut -c1-32)"
now_ms="$(date +%s)000"

jq -n \
  --argjson schema_version 2 \
  --arg writer "rust-daemon" \
  --arg writer_version "test@0" \
  --arg record_id "$record_id" \
  --arg nostr_event_id "$nostr_event_id" \
  --argjson created_at "$now_ms" \
  --argjson updated_at "$now_ms" \
  --arg project_d_tag "$PROJECT_D_TAG" \
  --arg backend_pubkey "$BACKEND_PUBKEY" \
  --arg agent_pubkey "$AGENT1_PUBKEY" \
  --argjson chat_id -100123 \
  '{
    schemaVersion: $schema_version,
    writer: $writer,
    writerVersion: $writer_version,
    recordId: $record_id,
    status: "pending",
    createdAt: $created_at,
    updatedAt: $updated_at,
    nostrEventId: $nostr_event_id,
    correlationId: ("corr-" + $record_id),
    projectBinding: {
      projectDTag: $project_d_tag,
      backendPubkey: $backend_pubkey
    },
    channelBinding: {
      chatId: $chat_id
    },
    senderIdentity: {
      agentPubkey: $agent_pubkey
    },
    deliveryReason: "proactive_send",
    payload: {kind: "plain_text", text: "hello from e2e scenario 14.4"},
    attempts: []
  }' > "$pending_dir/${record_id}.json"

echo "[scenario] pending outbox record written: $record_id"

start_daemon
await_daemon_subscribed 45 || _die "daemon subscription never became live"

# Wait for the record to be drained (moved to delivered/).
delivered_dir="$DAEMON_DIR/transport-outbox/telegram/delivered"
echo "[scenario] waiting up to 15s for outbox record to be delivered"
drain_deadline=$(( $(date +%s) + 15 ))
saw_delivered=0
while [[ $(date +%s) -lt $drain_deadline ]]; do
  if [[ -f "$delivered_dir/${record_id}.json" ]]; then
    saw_delivered=1
    break
  fi
  sleep 0.5
done

kill "$MOCK_TELEGRAM_PID" 2>/dev/null || true

if [[ "$saw_delivered" -ne 1 ]]; then
  echo "[scenario] daemon log (last 50 lines):"
  tail -50 "$DAEMON_DIR/daemon.log" >&2 || true
  echo "[scenario] pending dir contents:"
  ls -la "$pending_dir" 2>/dev/null >&2 || echo "(empty)" >&2
  echo "[scenario] mock telegram log:"
  cat "$mock_log" >&2 || true
  emit_result fail "outbox record not delivered within 15s"
  _die "ASSERT: outbox record not drained to delivered/"
fi

echo "[scenario]   outbox record delivered ✓"

# Verify the mock server received a sendMessage POST.
if [[ ! -f "$mock_received" ]] || ! grep -q "sendMessage" "$mock_received" 2>/dev/null; then
  echo "[scenario] mock received log:"
  cat "$mock_received" 2>/dev/null >&2 || echo "(empty)" >&2
  emit_result fail "mock Telegram server did not receive sendMessage call"
  _die "ASSERT: sendMessage was not called on mock Telegram server"
fi

echo "[scenario]   mock Telegram server received sendMessage ✓"

echo ""
echo "[scenario] PASS — scenario 14.4 Telegram outbox drain round-trip"
emit_result pass "outbox record delivered and sendMessage confirmed"
