#!/usr/bin/env bash
# Test worker: boots successfully, sends execution_started, then runs indefinitely.
# Used by scenario 7.4 to provide a live worker that can be killed externally.
# The daemon session loop detects EOF when this process is SIGKILLed.

python3 - <<'PYEOF'
import sys
import struct
import json
import os
import time

AGENT_WORKER_PROTOCOL_VERSION = 1
AGENT_WORKER_MAX_FRAME_BYTES = 1048576

pid = os.getpid()

def send_frame(obj):
    payload = json.dumps(obj, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('>I', len(payload)) + payload)
    sys.stdout.buffer.flush()

def read_frame():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack('>I', header)[0]
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode('utf-8'))

# Step 1: send valid ready frame.
send_frame({
    "version": AGENT_WORKER_PROTOCOL_VERSION,
    "type": "ready",
    "correlationId": "worker_boot",
    "sequence": 1,
    "timestamp": int(time.time() * 1000),
    "workerId": f"long-running-worker-{pid}",
    "pid": pid,
    "protocol": {
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "encoding": "length-prefixed-json",
        "maxFrameBytes": AGENT_WORKER_MAX_FRAME_BYTES,
        "streamBatchMs": 250,
        "streamBatchMaxBytes": 8192
    }
})

# Step 2: read the execute message.
execute = read_frame()
if not execute:
    sys.exit(1)

# Extract identity from the execute message for execution_started.
project_id = execute.get("projectId", "unknown")
agent_pubkey = execute.get("agentPubkey", "0" * 64)
conversation_id = execute.get("conversationId", "unknown")
ral_number = execute.get("ralNumber", 1)

# Step 3: send execution_started to advance the RAL state.
send_frame({
    "version": AGENT_WORKER_PROTOCOL_VERSION,
    "type": "execution_started",
    "correlationId": "execution",
    "sequence": 2,
    "timestamp": int(time.time() * 1000),
    "projectId": project_id,
    "agentPubkey": agent_pubkey,
    "conversationId": conversation_id,
    "ralNumber": ral_number
})

# Step 4: sleep indefinitely, simulating a long-running LLM call.
# The harness will SIGKILL this process, causing EOF on the daemon's frame pump.
while True:
    time.sleep(60)
PYEOF
