# daemon/ — Daemon Runtime (Layer 4)

Long-running background orchestration. Manages relay subscriptions, event processing, and project runtime lifecycle.

## Key Files

- `Daemon.ts` — Main daemon class, top-level orchestrator
- `ProjectRuntime.ts` — Per-project runtime (subscriptions, event handling)
- `SubscriptionManager.ts` — Relay subscription management
- `RuntimeLifecycle.ts` — Startup/shutdown coordination
- `RestartState.ts` — Restart state tracking
- `UnixSocketTransport.ts` — IPC via Unix sockets

## Subdirectories

- `filters/` — Nostr event filter construction
- `routing/` — Event routing to appropriate handlers
- `utils/` — Daemon-specific utilities

## Event Flow

Relay → SubscriptionManager → Filters → Routing → EventHandler → Dispatch

Always implement cleanup on shutdown — close subscriptions, flush pending work.
