#!/usr/bin/env bash
# Test worker: delays forever before sending the ready frame.
# Used by scenario 7.1 to trigger WorkerProcessError::BootTimeout.
# Invoked by the daemon as: $BUN_BIN run src/agents/execution/worker/agent-worker.ts
# This script ignores all arguments and sleeps indefinitely.

sleep 300
