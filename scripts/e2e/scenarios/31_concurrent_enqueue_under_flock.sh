#!/usr/bin/env bash
# E2E scenario 3.1 — Concurrent enqueue under flock.
#
# Validates the on-disk invariant the Rust daemon relies on: the
# `dispatch-queue.lock` file (acquired via libc::flock(LOCK_EX) in
# crates/tenex-daemon/src/dispatch_queue.rs) serializes read-compute-write
# cycles on `dispatch-queue.jsonl`. Regardless of how many concurrent enqueue
# paths (inbound, completion, scheduled) contend, the emitted record sequence
# numbers must be strictly monotonic and there must be no duplicate sequence
# numbers or interleaved records.
#
# This is a pure filesystem-level test of the flock invariant. It does not
# require the daemon or a relay — spawning the daemon just to contend for its
# own lock would give a single writer (the one daemon task that holds the
# lock), which is the exact case the daemon already serializes internally.
# Testing flock correctness requires multiple independent writers.
#
# Approach:
#   - Prepare an empty daemon/workers/ directory.
#   - Spawn N python workers in parallel. Each one does, in a loop:
#       1) open dispatch-queue.lock, acquire LOCK_EX
#       2) read the last sequence from dispatch-queue.jsonl
#       3) compute sequence = last + 1
#       4) append a record with that sequence
#       5) release the lock
#   - After all workers finish, verify:
#       (a) total records == N * iterations per worker
#       (b) sequence numbers are a contiguous range starting at 1
#       (c) no duplicate dispatch ids (each writer uses a unique prefix)
#
# Requires: bash, python3.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Setup -------------------------------------------------------------------
test_root="${TMPDIR:-/tmp}/tenex-e2e-31-$(date +%s)-$$"
mkdir -p "$test_root/workers"
echo "[scenario] test_root=$test_root"

queue="$test_root/workers/dispatch-queue.jsonl"
lock="$test_root/workers/dispatch-queue.lock"

# Touch both so the workers don't race to create them.
: > "$queue"
: > "$lock"

trap 'rm -rf "$test_root"' EXIT

# --- Spawn contending writers ------------------------------------------------
N_WRITERS=5
PER_WRITER=20
EXPECTED_TOTAL=$((N_WRITERS * PER_WRITER))

echo "[scenario] spawning $N_WRITERS writers, $PER_WRITER appends each (total=$EXPECTED_TOTAL)"

writer_script="$test_root/writer.py"
cat > "$writer_script" <<'PY'
"""Single contending writer process for the flock e2e test.

Each writer repeatedly:
  - acquires LOCK_EX on the lock file (blocking)
  - reads the last line of the queue file, decodes its sequence number
  - computes next = last + 1
  - appends a new record with that sequence and a writer-unique dispatch id
  - releases the lock

This is the exact read-compute-write pattern the Rust daemon uses in
`enqueue_inbound_dispatch` (see crates/tenex-daemon/src/dispatch_queue.rs).
If flock does not serialize, concurrent writers will read the same tail and
emit duplicate sequence numbers.
"""

import fcntl
import json
import os
import sys
import time

queue_path = sys.argv[1]
lock_path = sys.argv[2]
writer_id = sys.argv[3]
count = int(sys.argv[4])

for i in range(count):
    with open(lock_path, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            last_sequence = 0
            try:
                with open(queue_path, "r") as qf:
                    for line in qf:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        seq = record.get("sequence")
                        if isinstance(seq, int) and seq > last_sequence:
                            last_sequence = seq
            except FileNotFoundError:
                pass
            next_sequence = last_sequence + 1
            record = {
                "schemaVersion": 1,
                "sequence": next_sequence,
                "timestamp": int(time.time() * 1000),
                "correlationId": f"{writer_id}-{i}",
                "dispatchId": f"inbound-{writer_id}-{i:04d}",
                "writer": writer_id,
                "status": "queued",
            }
            with open(queue_path, "a") as qf:
                qf.write(json.dumps(record))
                qf.write("\n")
                qf.flush()
                os.fsync(qf.fileno())
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
PY

pids=()
for i in $(seq 1 "$N_WRITERS"); do
  python3 "$writer_script" "$queue" "$lock" "writer-$i" "$PER_WRITER" &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid" || _die "writer pid=$pid failed"
done

# --- Assertions ---------------------------------------------------------------
echo "[scenario] all writers complete — verifying invariants"

actual_total="$(wc -l < "$queue" | tr -d ' ')"
[[ "$actual_total" -eq "$EXPECTED_TOTAL" ]] || \
  _die "ASSERT: expected $EXPECTED_TOTAL records, got $actual_total"
echo "[scenario]   record count: $actual_total ✓"

# Sequence numbers are strictly increasing along the file and form 1..EXPECTED_TOTAL.
python3 - "$queue" "$EXPECTED_TOTAL" <<'PY'
import json
import sys

queue_path, expected_total = sys.argv[1], int(sys.argv[2])
sequences = []
with open(queue_path, "r") as qf:
    for line in qf:
        line = line.strip()
        if not line:
            continue
        record = json.loads(line)
        sequences.append(record["sequence"])

if len(sequences) != expected_total:
    sys.exit(f"expected {expected_total} sequences, got {len(sequences)}")

seen = set()
for idx, seq in enumerate(sequences):
    if seq in seen:
        sys.exit(f"duplicate sequence {seq} at record index {idx}")
    seen.add(seq)

if sorted(sequences) != list(range(1, expected_total + 1)):
    sys.exit(f"sequences are not the contiguous range 1..{expected_total}")

# In file order (= commit order under flock), sequences must be strictly
# increasing. flock serializes, so each subsequent record saw the previous
# writer's commit.
for i in range(1, len(sequences)):
    if sequences[i] <= sequences[i - 1]:
        sys.exit(
            f"non-monotonic sequence at index {i}: "
            f"seq[{i-1}]={sequences[i-1]}, seq[{i}]={sequences[i]}"
        )

print("[scenario]   sequences contiguous 1..{} and strictly increasing in file order ✓".format(expected_total))
PY

# Dispatch ids are all unique (each writer used a unique prefix).
dup_ids="$(python3 -c '
import json, sys
seen = set()
dups = []
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        r = json.loads(line)
        did = r["dispatchId"]
        if did in seen:
            dups.append(did)
        else:
            seen.add(did)
print(len(dups))
' "$queue")"
[[ "$dup_ids" -eq 0 ]] || _die "ASSERT: found $dup_ids duplicate dispatchIds"
echo "[scenario]   dispatchIds all unique ✓"

echo ""
echo "[scenario] PASS — scenario 3.1: concurrent enqueue under flock"
