#!/usr/bin/env bash
# Test worker: sends a valid ready frame, reads the execute message, then
# emits a frame whose declared payload length exceeds AGENT_WORKER_MAX_FRAME_BYTES
# (1 MiB = 1048576 bytes). The length prefix alone signals the oversize condition;
# the daemon rejects it without allocating a buffer.
# Used by scenario 7.9.

python3 - <<'PYEOF'
import sys
import struct
import json
import os

AGENT_WORKER_PROTOCOL_VERSION = 1
AGENT_WORKER_MAX_FRAME_BYTES = 1048576
AGENT_WORKER_MAX_PAYLOAD_BYTES = AGENT_WORKER_MAX_FRAME_BYTES - 4  # minus length prefix

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
    return json.loads(body.decode('utf-8'))

# Step 1: send valid ready frame.
send_frame({
    "version": AGENT_WORKER_PROTOCOL_VERSION,
    "type": "ready",
    "correlationId": "worker_boot",
    "sequence": 1,
    "timestamp": 1700000000000,
    "workerId": f"oversized-frame-worker-{pid}",
    "pid": pid,
    "protocol": {
        "version": AGENT_WORKER_PROTOCOL_VERSION,
        "encoding": "length-prefixed-json",
        "maxFrameBytes": AGENT_WORKER_MAX_FRAME_BYTES,
        "streamBatchMs": 250,
        "streamBatchMaxBytes": 8192
    }
})

# Step 2: read the execute message from the daemon.
read_frame()

# Step 3: send a frame whose declared payload length exceeds the cap.
# The daemon reads the 4-byte prefix, sees payload_byte_length > MAX_PAYLOAD_BYTES,
# and returns FramePayloadTooLarge without reading any more bytes.
oversized_length = AGENT_WORKER_MAX_PAYLOAD_BYTES + 1
sys.stdout.buffer.write(struct.pack('>I', oversized_length))
sys.stdout.buffer.flush()

# The daemon will now reject and close the connection. Drain stdin.
try:
    sys.stdin.buffer.read()
except Exception:
    pass
PYEOF
