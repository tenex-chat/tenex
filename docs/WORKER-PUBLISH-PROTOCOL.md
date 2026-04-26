# Worker↔Daemon Publish Protocol

The Bun worker process communicates with the Rust daemon through a line-delimited JSON protocol over stdin/stdout. This document covers the publish sub-protocol: how workers request event publication, how the daemon responds, and how the session loop handles the pipe lifecycle around terminal events.

## Message taxonomy

Worker frames sent to the daemon (`stdout` of the worker, `stdin` of the daemon) fall into three categories:

### Control/telemetry (daemon observes, does not relay)

| `type` | Meaning |
|---|---|
| `ready` | Worker finished boot, ready for dispatch |
| `boot_error` | Worker failed to boot (session terminates) |
| `heartbeat` | Periodic liveness snapshot (worker state snapshot) |
| `execution_started` | Worker began processing a dispatch |
| `stream_delta` | LLM token delta (telemetry only) |
| `reasoning_delta` | LLM reasoning token delta |
| `tool_call_started` / `tool_call_completed` / `tool_call_failed` | Tool lifecycle telemetry |
| `delegation_registered` / `delegation_killed` | RAL delegation lifecycle |
| `silent_completion_requested` | Worker requests a no-op completion path |
| `published` | Acknowledgment that a prior `publish_request` was confirmed by the relay |
| `pong` | Response to a daemon ping |

### Publish requests (daemon accepts, enqueues, confirms back)

| `type` | Meaning |
|---|---|
| `publish_request` | Worker wants the daemon to publish a Nostr event |
| `nip46_publish_request` | Worker wants a NIP-46 bunker-signed event published |

### Terminal results (session-ending)

| `type` | Meaning |
|---|---|
| `waiting_for_delegation` | Worker delegated work and is exiting |
| `complete` | Worker finished and published its final result |
| `no_response` | Worker determined no response was warranted |
| `aborted` | Worker aborted the execution |
| `error` | Worker encountered a fatal error |

## Publish request/result handshake

When a worker wants to publish an event, the sequence is:

1. Worker sends `{ "type": "publish_request", "runtimeEventClass": "<class>", ... }` on stdout.
2. Daemon validates, routes to the publish outbox, and writes a `publish_outbox` record to disk.
3. Daemon sends `{ "type": "publish_result", "sequence": N, ... }` back to the worker on stdin.
4. Worker receives the result and continues (or exits for terminal classes).

The `runtimeEventClass` field determines routing and session behavior:

| `runtimeEventClass` | Terminal? | Behavior on pipe-closed-after-accept |
|---|---|---|
| `complete` | Yes | Synthesize terminal result; end session |
| `delegation` | Yes | Synthesize `waiting_for_delegation`; end session |
| `stream_text_delta`, `conversation_update`, `error`, etc. | No | Fire-and-forget: skip the unsendable result, continue draining frames |

## Pipe lifecycle

When a worker publishes a terminal event (`complete` or `delegation`) and then immediately exits:

- The daemon may have already accepted and enqueued the event before the worker closes stdin.
- The daemon's `send_worker_message(publish_result)` call may fail with "broken pipe."
- This is expected. The session loop synthesizes the correct terminal state from the publish acceptance record and the on-disk outbox, without requiring the worker to receive the `publish_result`.
- If a delegation-completion injection arrives in the window between acceptance and the broken-pipe detection, it stays queued and is delivered to the next worker that handles the conversation.

## NIP-46 publish path

`nip46_publish_request` follows the same overall handshake but routes through the NIP-46 bunker signing path (`nip46_flow.rs`). The `result_sequence` is tracked separately from the main publish sequence and is incremented after each NIP-46 result is delivered.

## Navigation

- `crates/tenex-daemon/src/worker_message.rs` — message type dispatch table
- `crates/tenex-daemon/src/worker_publish/flow.rs` — main publish flow
- `crates/tenex-daemon/src/worker_publish/acceptance.rs` — outbox write + result construction
- `crates/tenex-daemon/src/worker_publish/nip46_flow.rs` — NIP-46 bunker path
- `crates/tenex-daemon/src/worker_session/session_loop.rs` — pipe lifecycle handling
