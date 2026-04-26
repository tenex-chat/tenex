#!/usr/bin/env bash
# Test worker: sends a ready frame with an unsupported protocol version (99).
# Used by scenario 7.2 to trigger WorkerProtocolError::UnsupportedVersion.
# Invoked by the daemon as: $BUN_BIN run src/agents/execution/worker/agent-worker.ts

python3 - <<'PYEOF'
import sys
import struct
import json
import os

pid = os.getpid()
ready = {
    "version": 99,
    "type": "ready",
    "correlationId": "worker_boot",
    "sequence": 1,
    "timestamp": 1700000000000,
    "workerId": f"bad-proto-worker-{pid}",
    "pid": pid,
    "protocol": {
        "version": 99,
        "encoding": "length-prefixed-json",
        "maxFrameBytes": 1048576,
        "streamBatchMs": 250,
        "streamBatchMaxBytes": 8192
    }
}

payload = json.dumps(ready, separators=(',', ':')).encode('utf-8')
frame = struct.pack('>I', len(payload)) + payload

sys.stdout.buffer.write(frame)
sys.stdout.buffer.flush()

# Drain stdin so the daemon does not get SIGPIPE when writing the execute message.
try:
    sys.stdin.buffer.read()
except Exception:
    pass
PYEOF
