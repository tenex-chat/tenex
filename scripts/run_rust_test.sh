#!/usr/bin/env bash
# TENEX Rust Agent Test Harness
# Runs a single test scenario against the tenex-agent binary using a local ollama model.
# Usage: run_rust_test.sh <test_name> <prompt> [root_id]
#   root_id: optional, reuse a prior conversation ID to test history replay
# Outputs NDJSON to stdout, test summary to stderr.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY="$REPO_ROOT/target/debug/tenex-agent"
AGENT_JSON="$HOME/.tenex/agents/79c8c7e3d3946e286e345263abc2d96d8847e4e25f0b60bc63b233e3d9b10a57.json"
PROJECT_ID="TEST-RUST"
CONV_DB="$HOME/.tenex/projects/$PROJECT_ID/conversation.db"

# Owner nsec (used only for signing trigger events; this is a test-only key)
OWNER_NSEC="nsec17dgdm2g80zvua87mdjmgzxktmrdswef79mx47x09tmd6jyutdc7smlgf94"
OWNER_PUBKEY="09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7"

TEST_NAME="${1:-basic}"
PROMPT="${2:-Say hello and tell me what tools you have available.}"
# Optional: pass an existing root_id to continue a prior conversation
FIXED_ROOT_ID="${3:-}"

if [[ ! -f "$BINARY" ]]; then
    echo "[ERROR] Binary not found: $BINARY" >&2
    echo "[INFO]  Run: cargo build -p tenex-agent" >&2
    exit 1
fi

# Use fixed root ID if given (history replay), otherwise generate fresh
if [[ -n "$FIXED_ROOT_ID" ]]; then
    ROOT_ID="$FIXED_ROOT_ID"
    echo "[INFO] Reusing root ID: $ROOT_ID" >&2
else
    ROOT_ID=$(python3 -c "import secrets; print(secrets.token_hex(32))")
fi

# Build and sign the trigger event using nak
# kind:1, content=PROMPT, e-tag pointing to root
TRIGGER_EVENT=$(nak event \
    --sec "$OWNER_NSEC" \
    --kind 1 \
    --content "$PROMPT" \
    -t "e=${ROOT_ID};;root" \
    2>/dev/null)

if [[ -z "$TRIGGER_EVENT" ]]; then
    echo "[ERROR] Failed to generate trigger event" >&2
    exit 1
fi

EVENT_ID=$(echo "$TRIGGER_EVENT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" 2>/dev/null)
EVENT_TS=$(echo "$TRIGGER_EVENT" | python3 -c "import json,sys; print(json.load(sys.stdin)['created_at'])" 2>/dev/null)
NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")

echo "[TEST] $TEST_NAME" >&2
echo "[PROMPT] $PROMPT" >&2
echo "[EVENT] ${EVENT_ID:0:8}..." >&2
echo "[ROOT]  ${ROOT_ID:0:8}..." >&2
echo "---" >&2

# Write the user message into the messages table before invoking the agent.
# In production the TypeScript daemon does this when it ingests the inbound
# Nostr event. In the standalone harness we simulate that write so that
# project_messages() picks it up as conversation history on re-invocation.
python3 - <<PYEOF
import sqlite3, time, sys

db = sqlite3.connect("$CONV_DB")
now_ms = $NOW_MS
root_id = "$ROOT_ID"
event_id = "$EVENT_ID"
owner = "$OWNER_PUBKEY"
prompt = """$PROMPT"""

db.execute("""
    INSERT OR IGNORE INTO conversations
        (id, owner_pubkey, metadata_json, runtime_state_json, updated_at, created_at, last_activity)
    VALUES (?, ?, '{}', '{}', ?, ?, ?)
""", (root_id, owner, now_ms, now_ms, now_ms))

seq = db.execute(
    "SELECT COALESCE(MAX(sequence)+1,0) FROM messages WHERE conversation_id=?",
    (root_id,)
).fetchone()[0]

db.execute("""
    INSERT OR IGNORE INTO messages
        (conversation_id, record_id, nostr_event_id, sequence,
         author_pubkey, message_type, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, 'text', 'user', ?, ?)
""", (root_id, event_id, event_id, seq, owner, prompt, now_ms))

db.commit()
db.close()
PYEOF

# Run the agent and collect NDJSON output with a timeout
TMPFILE=$(mktemp /tmp/tenex_test_XXXXXX.ndjson)
trap "rm -f $TMPFILE" EXIT

START_SECS=$SECONDS
TIMEOUT=120

set +e
echo "$TRIGGER_EVENT" | timeout $TIMEOUT env TENEX_PROJECT_ID="$PROJECT_ID" \
    "$BINARY" "$AGENT_JSON" \
    > "$TMPFILE" 2>&1
EXIT_CODE=$?
set -e

ELAPSED=$((SECONDS - START_SECS))

if [[ $EXIT_CODE -eq 124 ]]; then
    echo "[TIMEOUT] Test timed out after ${TIMEOUT}s" >&2
elif [[ $EXIT_CODE -ne 0 ]]; then
    echo "[FAIL] Exit code: $EXIT_CODE after ${ELAPSED}s" >&2
else
    echo "[OK] Completed in ${ELAPSED}s" >&2
fi

# Summarize output — events are NDJSON with "kind" numbers:
#   kind:1 = final conversation response
#   kind:24135 = stream delta
#   kind:1 with tool tag = tool use
LINES=$(wc -l < "$TMPFILE")
CONV_COUNT=$(python3 -c "
import json, sys
n = 0
for line in open('$TMPFILE'):
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        if d.get('kind') == 1 and not any(t[0] == 'tool' for t in d.get('tags', [])):
            n += 1
    except: pass
print(n)
" 2>/dev/null || echo 0)
TOOL_COUNT=$(python3 -c "
import json, sys
n = 0
for line in open('$TMPFILE'):
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        tags = d.get('tags', [])
        if any(t[0] == 'tool' for t in tags):
            n += 1
    except: pass
print(n)
" 2>/dev/null || echo 0)
DELTA_COUNT=$(python3 -c "
import json, sys
n = 0
for line in open('$TMPFILE'):
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        if d.get('kind') == 24135:
            n += 1
    except: pass
print(n)
" 2>/dev/null || echo 0)
ERROR_COUNT=$(grep -ic 'Failed\|panic\!\|error\[' "$TMPFILE" 2>/dev/null || true)

echo "[STATS] lines=$LINES conv=$CONV_COUNT tools=$TOOL_COUNT deltas=$DELTA_COUNT errors=$ERROR_COUNT" >&2

# Print last conversation content if available
LAST_CONV=$(python3 -c "
import json
last = None
for line in open('$TMPFILE'):
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        if d.get('kind') == 1 and not any(t[0] == 'tool' for t in d.get('tags', [])):
            last = d.get('content', '')
    except: pass
if last:
    print(last[:500])
" 2>/dev/null || true)

if [[ -n "$LAST_CONV" ]]; then
    echo "[RESPONSE] $LAST_CONV" >&2
fi

# Print errors if any
if [[ $ERROR_COUNT -gt 0 ]]; then
    echo "[ERRORS]" >&2
    grep -i '"error"\|"FAIL"\|panic\!' "$TMPFILE" 2>/dev/null | head -5 >&2 || true
fi

# Print the root ID so callers can reuse it for history replay tests
echo "[ROOT_ID] $ROOT_ID" >&2

# Write the agent's final response back to the messages table.
# In production the TypeScript daemon ingests the agent's outbound kind:1 Nostr
# event and writes it as role='assistant' in messages. Without this step,
# project() would only see user messages on re-invocation, omitting prior
# assistant turns from the history projection.
if [[ $EXIT_CODE -eq 0 && -n "$LAST_CONV" ]]; then
python3 - <<PYEOF
import sqlite3, json, time

db = sqlite3.connect("$CONV_DB")
root_id = "$ROOT_ID"
agent_pubkey = "79c8c7e3d3946e286e345263abc2d96d8847e4e25f0b60bc63b233e3d9b10a57"
now_ms = int(time.time() * 1000)

# Collect all final (non-tool) conversation responses from the NDJSON output,
# in emission order. This handles supervision re-engagement turns correctly —
# each turn's response is a separate kind:1 event.
responses = []
try:
    with open("$TMPFILE") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                if d.get("kind") == 1 and not any(
                    t[0] == "tool" for t in d.get("tags", [])
                ):
                    content = d.get("content", "").strip()
                    if content:
                        responses.append(content)
            except Exception:
                pass
except Exception:
    pass

for content in responses:
    seq = db.execute(
        "SELECT COALESCE(MAX(sequence)+1, 0) FROM messages WHERE conversation_id=?",
        (root_id,),
    ).fetchone()[0]
    record_id = f"agent-resp-{root_id[:8]}-{seq}"
    db.execute(
        """INSERT OR IGNORE INTO messages
               (conversation_id, record_id, nostr_event_id, sequence,
                author_pubkey, message_type, role, content, created_at)
           VALUES (?, ?, NULL, ?, ?, 'text', 'assistant', ?, ?)""",
        (root_id, record_id, seq, agent_pubkey, content, now_ms),
    )

db.commit()
db.close()
PYEOF
fi

cat "$TMPFILE"
exit $EXIT_CODE
