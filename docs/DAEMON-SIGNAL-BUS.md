# Daemon Signal Bus

The daemon uses an internal signal bus for event-driven coordination between its subsystem drivers. Each driver subscribes to exactly the signals it needs; the `DaemonSignals` struct is never passed whole to any consumer — callers extract only the senders they need at construction time in `run_cli`.

## Signals

| Signal | Type | Producer | Consumer(s) |
|---|---|---|---|
| `project_index_changed` | `Arc<Notify>` | `nostr_ingress` | `project_status_supervisor` |
| `project_schedules_changed` | `Arc<Notify>` | schedule file watcher | all per-project scheduled-task drivers |
| `project_booted` | mpsc channel | `nostr_ingress` (on 24000 receipt) | worker admission driver |
| `dispatch_enqueued` | mpsc channel | dispatch queue writer | worker admission driver |
| `session_completed` | mpsc channel | worker session task | worker admission driver |
| `publish_enqueued` | mpsc channel | publish outbox writer | publish outbox driver |
| `ral_completed` | mpsc channel | RAL journal writer | intervention driver |
| `telegram_enqueued` | mpsc channel | Telegram outbox writer | Telegram outbox driver |

## Design constraints

**All mpsc channels are unbounded.** Every producer is gated by an on-disk write that bounds throughput, so a bounded `try_send` would have no sane fallback — the event has already been persisted, so dropping the wake produces silent data loss.

**`project_index_changed` and `project_schedules_changed` use `tokio::sync::Notify`** (broadcast-style wake-all) rather than mpsc because multiple drivers need to observe the same notification, and a queued count does not matter — only the fact that *something* changed.

**`ral_completed` carries a sequence number** (`RalCompletion { sequence: u64 }`) so the intervention driver can detect if additional completions arrived while it was processing a prior one, rather than relying on polling.

## Schedule file watcher

A background OS thread watches `<tenex_base_dir>/projects/` for `schedules.json` changes using `notify::PollWatcher` with a 1-second interval. The kqueue backend was avoided because `kqueue-1.1.1` has a known panic during e2e runs when the watched directory is removed and recreated. When a `schedules.json` change is detected, `project_schedules_changed.notify_waiters()` wakes all per-project scheduled-task drivers.

## Navigation

- `crates/tenex-daemon/src/daemon_signals.rs` — signal types, `DaemonSignals`, `DaemonSignalReceivers`, `create_daemon_signals()`
- `crates/tenex-daemon/src/bin/daemon.rs` `run_cli()` — where signals are created and distributed to drivers
