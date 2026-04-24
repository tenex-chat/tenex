# M9 TS Shim Audit — 2026-04-24

## Scope
Branch: rust-agent-worker-publishing, commit: cf38cacb

## Status by target

| Target | Status | Importers | Notes |
|---|---|---|---|
| `Daemon` class (`src/daemon/Daemon.ts`) | EXISTS_AND_LIVE | `src/wrapper.ts` (comment-only, no real import), `src/daemon/index.ts` (re-exports `getDaemon`), `src/tools/implementations/project_list.ts`, `src/tools/implementations/delegate_crossproject.ts`, `src/commands/daemon.ts` | `getDaemon()` exported from `src/daemon/index.ts` and called in 3 live non-daemon files |
| `RuntimeLifecycle` (`src/daemon/RuntimeLifecycle.ts`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts`, `src/daemon/ShutdownCoordinator.ts`, `src/daemon/EventHandlerRegistry.ts`, `src/daemon/SubscriptionSyncCoordinator.ts` | Only imported within daemon subtree; orphaned relative to the rest of the app but indirectly live through Daemon |
| `ProjectRuntime` (`src/daemon/ProjectRuntime.ts`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts`, `src/daemon/RuntimeLifecycle.ts`, `src/daemon/routing/DaemonRouter.ts`, `src/daemon/SubscriptionSyncCoordinator.ts`, `src/services/AgentDefinitionMonitor.ts` | Cross-module importer: `AgentDefinitionMonitor` in services |
| `SubscriptionManager` (`src/daemon/SubscriptionManager.ts`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts`, `src/daemon/ShutdownCoordinator.ts`, `src/daemon/SubscriptionSyncCoordinator.ts` | All importers within daemon subtree |
| `DaemonRouter` (`src/daemon/routing/DaemonRouter.ts`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts` | Only imported by Daemon |
| Status publisher loops (`statusInterval` in `Daemon.ts`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts` | `setInterval`/`clearInterval` pattern at lines 197–200, 1104–1106 |
| `OperationsStatusService` (`src/services/status/OperationsStatusService.ts`) | EXISTS_AND_LIVE | `src/daemon/ProjectRuntime.ts` | Instantiated inside ProjectRuntime |
| Agent config watcher (`AgentConfigWatcher`) | EXISTS_AND_LIVE | `src/daemon/ProjectRuntime.ts` | Instantiated inside ProjectRuntime at line 287 |
| Skill whitelist subscription (`SkillWhitelistService`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts`, `src/services/skill/SkillIdentifierResolver.ts`, `src/services/skill/SkillService.ts`, `src/services/skill/skill-blocking.ts` | Live across daemon and services; not a pure shim |
| Conversation indexing job (`ConversationIndexingJob`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts`, `src/daemon/ShutdownCoordinator.ts` | Started/stopped inside daemon lifecycle |
| Daemon-level agent definition monitor (`AgentDefinitionMonitor`) | EXISTS_AND_LIVE | `src/daemon/Daemon.ts`, `src/daemon/ShutdownCoordinator.ts` | Instantiated in Daemon, passed to ShutdownCoordinator |
| `TelegramGatewayService` | EXISTS_AND_LIVE | `src/daemon/ProjectRuntime.ts`, `src/test-utils/test-setup.ts` | `getTelegramGatewayService()` called in ProjectRuntime |
| `TelegramDeliveryService` | EXISTS_AND_LIVE | `src/daemon/ProjectRuntime.ts`, `src/tools/implementations/send_message.ts`, `src/services/runtime/runtime-publisher-factory.ts` | Live tool importer: `send_message.ts` |
| `dispatch-adapter.ts` | ALREADY_REMOVED | — | File does not exist; no imports found |
| `ral-bridge.ts` | ALREADY_REMOVED | — | File does not exist; no imports found |
| `RALRegistry` call sites | EXISTS_AND_LIVE | Pervasive across `src/agents/execution/`, `src/tools/implementations/`, `src/event-handler/`, `src/services/dispatch/`, `src/nostr/`, `src/prompts/` | Not a transition shim — actively used as core runtime state |

## Migration feature flags

- `TENEX_RUST_DAEMON`: **not found** in any `.ts` or `.rs` file
- `TENEX_AGENT_WORKER`: **not found** in any `.ts` or `.rs` file
- No other `TENEX_*_RUST` or `USE_RUST` flags found anywhere in the tree

## Orphaned but undeleted

None found. Every daemon file that exists is transitively imported by something live (`Daemon.ts` → `getDaemon()` → `commands/daemon.ts`, tools).

`dispatch-adapter.ts` and `ral-bridge.ts` are already gone.

## Still-live that block M9

All items below are in active use and must be removed/replaced before M9 can be declared:

| File | Live importers |
|---|---|
| `src/daemon/Daemon.ts` | `src/daemon/index.ts`, `src/commands/daemon.ts`, `src/tools/implementations/project_list.ts`, `src/tools/implementations/delegate_crossproject.ts` |
| `src/daemon/RuntimeLifecycle.ts` | `src/daemon/Daemon.ts` (transitively live) |
| `src/daemon/ProjectRuntime.ts` | `src/daemon/RuntimeLifecycle.ts`, `src/daemon/Daemon.ts`, `src/daemon/routing/DaemonRouter.ts`, `src/services/AgentDefinitionMonitor.ts` |
| `src/daemon/SubscriptionManager.ts` | `src/daemon/Daemon.ts` |
| `src/daemon/routing/DaemonRouter.ts` | `src/daemon/Daemon.ts` |
| `src/daemon/ShutdownCoordinator.ts` | `src/daemon/Daemon.ts` |
| `src/daemon/SubscriptionSyncCoordinator.ts` | `src/daemon/RuntimeLifecycle.ts` |
| `src/daemon/EventHandlerRegistry.ts` | `src/daemon/Daemon.ts` |
| `src/daemon/StatusFile.ts` | `src/commands/daemon-status.ts`, `src/daemon/Daemon.ts` |
| `src/services/AgentDefinitionMonitor.ts` | `src/daemon/Daemon.ts`, `src/daemon/ShutdownCoordinator.ts` |
| `src/services/status/OperationsStatusService.ts` | `src/daemon/ProjectRuntime.ts` |
| `src/services/agents/AgentConfigWatcher.ts` | `src/daemon/ProjectRuntime.ts` |
| `src/services/telegram/TelegramGatewayService.ts` | `src/daemon/ProjectRuntime.ts` |
| `src/services/telegram/TelegramDeliveryService.ts` | `src/daemon/ProjectRuntime.ts`, `src/tools/implementations/send_message.ts`, `src/services/runtime/runtime-publisher-factory.ts` |

## Migration-related comments

No `// TODO`, `// DEPRECATED`, or `// HACK` comments referencing the Rust migration were found in the codebase. The single found `// TODO` (`src/agents/script-installer.ts:137`) is unrelated to migration.

## Total

- Ready to delete: 0 files (nothing is fully orphaned; all daemon files are connected through the live `getDaemon()` call chain)
- Already removed: 2 targets (`dispatch-adapter.ts`, `ral-bridge.ts`)
- Migration feature flags found: 0
- Blocks M9: 14 files (the entire `src/daemon/` subtree plus several service files that directly reference daemon types)
