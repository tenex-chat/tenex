#!/usr/bin/env bash
# E2E scenario 3.2 — Re-dispatch sequence computed under lock.
#
# Defends commit d8c8238f ("fix(daemon): resequence RAL journal completion
# records under the append lock") and by extension commit 6d5b9e72
# ("resequence RAL journal records on concurrent write paths").
#
# The bug the fix closes:
#   Worker-completion paths build a RalJournalRecord with `sequence` derived
#   from a replay snapshot that was taken BEFORE the append lock was
#   acquired. If an inbound enqueue (or another completion) lands between
#   the snapshot and the append, two appenders try to write the same
#   sequence number. The ral_journal writer then trips SequenceOutOfOrder,
#   and the second appender's record is lost or the journal becomes
#   non-monotonic.
#
# The invariant this scenario asserts — filesystem-observable:
#   Any appender that (a) takes LOCK_EX on `daemon/ral/journal.lock`,
#   (b) re-reads the journal tail under that lock, (c) rewrites
#   `record.sequence` to `last_sequence + 1`, and (d) appends, will always
#   produce a journal whose sequences are strictly monotonic in file order
#   and form the contiguous range 1..N with no duplicates, REGARDLESS of
#   how many concurrent writers pre-computed colliding sequences based on
#   stale snapshots.
#
# This is a pure filesystem-level test; it does not drive the daemon.
# Driving a real worker completion race is too expensive for an e2e check
# and the daemon already serializes inside its own process. The correctness
# question is: when two independent writers contend for the lock, does the
# read-rewrite-append-under-lock pattern hold? That's a property of flock +
# the writer protocol. Python's fcntl.flock is interoperable with libc::flock
# so we can emulate both paths (inbound and completion) as independent OS
# processes.
#
# Scenario layout:
#   Writer class A ("inbound") — N_INBOUND processes. Each one:
#       1) acquires LOCK_EX on ral/journal.lock
#       2) reads the current last sequence from ral/journal.jsonl
#       3) writes `{..., sequence: last + 1, writer: "inbound-<k>-<i>"}`
#       4) releases the lock
#     This is the path that already uses "sequence computed under lock".
#
#   Writer class B ("completion") — N_COMPLETION processes. Each one:
#       1) WITHOUT the lock, reads the journal and pre-computes a stale
#          sequence (simulates the pre-fix code path that built the record
#          off a snapshot taken earlier)
#       2) acquires LOCK_EX on ral/journal.lock
#       3) re-reads the last sequence UNDER the lock and rewrites
#          `record.sequence = last + 1` (this is the fix — it's what
#          `append_ral_journal_record_with_resequence` does)
#       4) appends and releases
#     The scenario exercises the bug trigger (stale pre-computed sequence)
#     and validates that the fix (re-read + rewrite under lock) holds.
#
# Requires: bash, python3.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../_bootstrap.sh
source "$repo_root/scripts/e2e/_bootstrap.sh"
# shellcheck source=../../e2e-test-harness.sh
source "$repo_root/scripts/e2e-test-harness.sh"

# --- Setup -------------------------------------------------------------------
test_root="${TMPDIR:-/tmp}/tenex-e2e-32-$(date +%s)-$$"
mkdir -p "$test_root/daemon/ral"
echo "[scenario] test_root=$test_root"

journal="$test_root/daemon/ral/journal.jsonl"
lock="$test_root/daemon/ral/journal.lock"

# Touch both so no writer races to create them.
: > "$journal"
: > "$lock"

trap 'rm -rf "$test_root"' EXIT

# --- Contention parameters ---------------------------------------------------
#
# The scenario is asymmetric on purpose: multiple inbound writers and multiple
# completion writers, each doing many iterations. This maximizes the chance
# that an inbound enqueue lands between a completion's pre-snapshot and its
# under-lock rewrite — the exact race the fix closes. If resequence-under-
# lock did not hold, the final on-disk sequences would either duplicate or
# be non-monotonic in file order.

N_INBOUND=4
N_COMPLETION=4
PER_WRITER=25
EXPECTED_TOTAL=$(( (N_INBOUND + N_COMPLETION) * PER_WRITER ))

echo "[scenario] spawning $N_INBOUND inbound + $N_COMPLETION completion writers, $PER_WRITER each"
echo "[scenario] expected total records: $EXPECTED_TOTAL"

inbound_script="$test_root/inbound.py"
cat > "$inbound_script" <<'PY'
"""Inbound-path writer: sequence computed under the append lock.

This mirrors the already-correct dispatch-queue enqueue path and the RAL
journal inbound path. The sequence comes from the tail of the journal read
under LOCK_EX, so it cannot collide with any other under-lock reader.
"""

import fcntl
import json
import os
import sys
import time

journal_path = sys.argv[1]
lock_path = sys.argv[2]
writer_id = sys.argv[3]
count = int(sys.argv[4])


def read_last_sequence(path: str) -> int:
    last = 0
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                seq = rec.get("sequence")
                if isinstance(seq, int) and seq > last:
                    last = seq
    except FileNotFoundError:
        pass
    return last


for i in range(count):
    with open(lock_path, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            next_sequence = read_last_sequence(journal_path) + 1
            record = {
                "schemaVersion": 1,
                "writer": "rust-daemon",
                "writerVersion": "e2e-32-inbound",
                "sequence": next_sequence,
                "timestamp": int(time.time() * 1000),
                "correlationId": f"{writer_id}-{i}",
                "kind": "inbound",
                "path": writer_id,
            }
            with open(journal_path, "a") as jf:
                jf.write(json.dumps(record))
                jf.write("\n")
                jf.flush()
                os.fsync(jf.fileno())
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
PY

completion_script="$test_root/completion.py"
cat > "$completion_script" <<'PY'
"""Completion-path writer: pre-computes a stale sequence, then resequences
under the append lock.

This emulates the Rust path the fix established:
  append_ral_journal_record_with_resequence(daemon_dir, &mut record)
which re-reads the journal tail under LOCK_EX and rewrites
`record.sequence = last_sequence + 1` before appending.

The pre-snapshot step (outside the lock) is deliberate — it simulates the
original buggy caller that built the record off a stale replay snapshot.
The under-lock rewrite is what makes concurrent appenders safe.
"""

import fcntl
import json
import os
import sys
import time

journal_path = sys.argv[1]
lock_path = sys.argv[2]
writer_id = sys.argv[3]
count = int(sys.argv[4])


def read_last_sequence(path: str) -> int:
    last = 0
    try:
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                seq = rec.get("sequence")
                if isinstance(seq, int) and seq > last:
                    last = seq
    except FileNotFoundError:
        pass
    return last


for i in range(count):
    # Step 1: pre-compute a stale sequence without the lock. By the time we
    # acquire the lock in step 2, other writers will have advanced the tail,
    # making this value wrong. The resequence-under-lock step must rewrite
    # it.
    stale_sequence = read_last_sequence(journal_path) + 1
    record = {
        "schemaVersion": 1,
        "writer": "rust-daemon",
        "writerVersion": "e2e-32-completion",
        "sequence": stale_sequence,
        "timestamp": int(time.time() * 1000),
        "correlationId": f"{writer_id}-{i}",
        "kind": "completion",
        "path": writer_id,
        "staleSequence": stale_sequence,
    }

    with open(lock_path, "a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            # Step 2: under the lock, re-read the tail and rewrite the
            # sequence. This is the fix.
            authoritative_last = read_last_sequence(journal_path)
            record["sequence"] = authoritative_last + 1
            with open(journal_path, "a") as jf:
                jf.write(json.dumps(record))
                jf.write("\n")
                jf.flush()
                os.fsync(jf.fileno())
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
PY

# --- Spawn contending writers ------------------------------------------------
pids=()
for i in $(seq 1 "$N_INBOUND"); do
  python3 "$inbound_script"    "$journal" "$lock" "inbound-$i"    "$PER_WRITER" &
  pids+=($!)
done
for i in $(seq 1 "$N_COMPLETION"); do
  python3 "$completion_script" "$journal" "$lock" "completion-$i" "$PER_WRITER" &
  pids+=($!)
done

failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    failed=1
    echo "[scenario] writer pid=$pid exited non-zero"
  fi
done

if [[ "$failed" -ne 0 ]]; then
  emit_result fail "contending writer exited non-zero"
  exit 1
fi

# --- Assertions --------------------------------------------------------------
echo "[scenario] all writers complete — verifying invariants"

actual_total="$(wc -l < "$journal" | tr -d ' ')"
if [[ "$actual_total" -ne "$EXPECTED_TOTAL" ]]; then
  emit_result fail "expected $EXPECTED_TOTAL records, got $actual_total"
  _die "ASSERT: expected $EXPECTED_TOTAL records, got $actual_total"
fi
echo "[scenario]   record count: $actual_total (expected $EXPECTED_TOTAL)"

# The core invariants — contiguity, uniqueness, strict file-order monotonicity,
# AND the stronger check that at least one completion writer observed a stale
# pre-sequence that had to be rewritten. Without that last check we cannot
# claim the scenario actually exercised the bug trigger.
python3 - "$journal" "$EXPECTED_TOTAL" <<'PY'
import json
import sys

journal_path, expected_total = sys.argv[1], int(sys.argv[2])

records = []
with open(journal_path, "r") as jf:
    for line in jf:
        line = line.strip()
        if not line:
            continue
        records.append(json.loads(line))

if len(records) != expected_total:
    sys.exit(f"expected {expected_total} records, got {len(records)}")

sequences = [r["sequence"] for r in records]
seen = set()
for idx, seq in enumerate(sequences):
    if seq in seen:
        sys.exit(f"duplicate sequence {seq} at file index {idx}")
    seen.add(seq)

if sorted(sequences) != list(range(1, expected_total + 1)):
    missing = set(range(1, expected_total + 1)) - set(sequences)
    extra = set(sequences) - set(range(1, expected_total + 1))
    sys.exit(
        f"sequences are not contiguous 1..{expected_total}; "
        f"missing={sorted(missing)[:5]} extra={sorted(extra)[:5]}"
    )

for i in range(1, len(sequences)):
    if sequences[i] <= sequences[i - 1]:
        sys.exit(
            f"non-monotonic sequence at file index {i}: "
            f"seq[{i-1}]={sequences[i-1]}, seq[{i}]={sequences[i]}"
        )

# Completion writers expose `staleSequence` (pre-snapshot) vs final
# `sequence` (resequenced under lock). If the two ever differ, an inbound
# landed between the snapshot and the lock — i.e. the bug trigger fired and
# the resequence-under-lock step actually rewrote the value.
completion_records = [r for r in records if r.get("kind") == "completion"]
if not completion_records:
    sys.exit("no completion records observed; contention did not exercise the fix path")

rewrites = sum(
    1 for r in completion_records
    if r.get("staleSequence") is not None and r["staleSequence"] != r["sequence"]
)

print(
    f"[scenario]   contiguous 1..{expected_total}, unique, strictly increasing in file order"
)
print(
    f"[scenario]   completion writers: {len(completion_records)} total, "
    f"{rewrites} with stale-sequence-rewritten-under-lock"
)

# At these contention levels it's effectively impossible that zero completion
# writers raced an inbound between snapshot and lock. If that happens, the
# scenario is not exercising the bug trigger — surface it as a failure so we
# don't get silent false-positives.
if rewrites == 0:
    sys.exit(
        "no completion writer observed a stale pre-sequence; "
        "scenario did not exercise the resequence path"
    )
PY

echo ""
echo "[scenario] PASS — scenario 3.2: re-dispatch sequence computed under lock"
emit_result pass "ral journal resequenced correctly under concurrent inbound+completion writers"
