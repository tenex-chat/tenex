# TENEX Architecture Diagrams

## 1. Current Multi-Process Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       TENEX CLI Entry Point                     │
│                      (src/tenex.ts main)                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼──────┐    ┌─────▼─────┐    ┌─────▼─────┐
    │   daemon  │    │  project  │    │   agent   │
    │  command  │    │  command  │    │  command  │
    └────┬──────┘    └─────┬─────┘    └───────────┘
         │                 │
         │        ┌────────▼────────┐
         │        │  project run    │
         │        │    subcommand   │
         │        └────────┬────────┘
         │                 │
    ┌────▼──────────────────▼─────────────┐
    │   NDK Client (Global Singleton)     │
    └─────────────────────────────────────┘
         │                 │
    ┌────▼──────┐    ┌─────▼──────────────────┐
    │EventMonitor│    │  runProjectListener    │
    │ (daemon)   │    │ (project run)          │
    └────┬──────┘    └─────┬──────────────────┘
         │                 │
    ┌────▼──────────────────▼──────────────────────────┐
    │  Nostr Network (Relays)                          │
    │  - Listens to events from whitelisted pubkeys   │
    │  - Subscribed to project event kinds            │
    └────────────────────────────────────────────────────┘
         │                 │
    ┌────▼──────┐    ┌─────▼────────────────┐
    │ProjectMgr  │    │SubscriptionManager   │
    │(daemon)    │    │ (project run)        │
    └────┬───────┘    └─────┬────────────────┘
         │                  │
    ┌────▼───────────────────▼──────────────┐
    │   EventHandler (Multi-project aware)   │
    │   Routes to correct project context    │
    └────┬──────────────────────────────────┘
         │
    ┌────▼─────────────────────────────┐
    │  Project Processes (Child)        │
    │  ┌──────────────────────────────┐ │
    │  │ Process 1: ProjectContext    │ │
    │  │ ┌────────────────────────────┤ │
    │  │ │AgentRegistry, AgentExecutor│ │
    │  │ └────────────────────────────┤ │
    │  │         ↓ publishes          │ │
    │  │    kind 1, 24010, 24111      │ │
    │  └──────────────────────────────┘ │
    │  ┌──────────────────────────────┐ │
    │  │ Process 2: ProjectContext    │ │
    │  │ ┌────────────────────────────┤ │
    │  │ │AgentRegistry, AgentExecutor│ │
    │  │ └────────────────────────────┤ │
    │  │         ↓ publishes          │ │
    │  │    kind 1, 24010, 24111      │ │
    │  └──────────────────────────────┘ │
    │               ...                  │
    └─────────────────────────────────────┘
```

## 2. Event Processing Pipeline (Per Project)

```
Nostr Event Reception
        │
        ▼
┌──────────────────────────────┐
│ SubscriptionManager          │
│ - 5 Concurrent Subscriptions │
│ - Deduplication Check        │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ EventHandler.handleEvent()   │
│ - Ignore certain kinds       │
│ - Delegation check           │
│ - Route by kind              │
└──────────┬───────────────────┘
           │
    ┌──────┴────────────────────────────────────┐
    │ Route by Kind:                             │
    │                                            │
    ├─ kind 1111 (reply) ──────────────────┐   │
    ├─ kind 11 (thread) ───────────────────┤   │
    ├─ kind 31933 (project) ───────────────┤   │
    ├─ kind 24020 (agent config) ──────────┤   │
    ├─ kind 513 (metadata) ────────────────┤   │
    ├─ kind 24134 (stop) ───────────────────┤   │
    └─ other ───────────────────────────────┘   │
        │
    ┌───▼───────────────────────────────────────────┐
    │ Conversation Resolution                       │
    │ - Find or create conversation                │
    │ - Load conversation history                  │
    │ - Update conversation metadata               │
    └───┬───────────────────────────────────────────┘
        │
    ┌───▼───────────────────────────────────────────┐
    │ Agent Router                                  │
    │ - Resolve target agents from p-tags          │
    │ - Filter out self-replies (exceptions: PM)   │
    │ - Apply delegation rules                     │
    └───┬───────────────────────────────────────────┘
        │
    ┌───▼───────────────────────────────────────────┐
    │ Parallel Agent Execution                      │
    │ for each target agent:                       │
    │  ├─ Create AgentExecutor                     │
    │  ├─ Load LLM service                         │
    │  ├─ Stream LLM response                      │
    │  ├─ Handle tool execution                    │
    │  └─ Publish result (kind 1)                  │
    └───┬───────────────────────────────────────────┘
        │
    ┌───▼───────────────────────────────────────────┐
    │ Save Conversation History                     │
    │ - Update .tenex/conversations/               │
    │ - Persist agent responses                    │
    └───────────────────────────────────────────────┘
```

## 3. ProjectContext Initialization Sequence

```
tenex project run --path /path/to/project
        │
        ▼
ensureProjectInitialized()
        │
    ┌───┴─────────────────────────────┐
    │                                 │
    ▼                                 ▼
Load Config                    Fetch Project from Nostr
.tenex/config.json           using projectNaddr
    │                                 │
    └───┬─────────────────────────────┘
        │
        ▼
Create AgentRegistry
        │
        ├─ agentStorage.initialize()
        │
        ├─ For each agent tag in project:
        │  ├─ Check local storage (~/.tenex/agents/)
        │  ├─ If missing: fetch from Nostr & install
        │  └─ Create AgentInstance with signer
        │
        ▼
setProjectContext(project, agentRegistry, llmLogger)
        │
        ├─ Identify Project Manager (PM)
        │  ├─ Look for "pm" tag
        │  └─ Fallback: first agent in project
        │
        ├─ Set PM's signer & pubkey as project signer/pubkey
        │
        ├─ agentRegistry.setPMPubkey()
        │
        ├─ agentRegistry.persistPMStatus()
        │
        ▼
Global ProjectContext ready
(accessible via getProjectContext())
```

## 4. 24010 Status Event Contents

```
NDK Event (kind 24010 - Ephemeral)
        │
        ├─ Content: "" (empty)
        │
        ├─ Tags:
        │
        ├─ a-tag: ["a", "31933:pubkey:project-d-tag"]
        │         (Project reference)
        │
        ├─ p-tag: ["p", "project-owner-pubkey"]
        │         (Project owner)
        │
        ├─ agent tags (one per agent):
        │  └─ ["agent", "agent-pubkey", "agent-slug", ?pm]
        │     ^^^^^^ identifies as PM if present
        │
        ├─ model tags (one per LLM config):
        │  └─ ["model", "config-slug", "agent1", "agent2", ...]
        │     List of agents using this model
        │
        ├─ tool tags (one per tool):
        │  └─ ["tool", "tool-name", "agent1", "agent2", ...]
        │     List of agents with access to tool
        │
        │ EXCLUDED:
        │  ├─ Delegate tools (handled by system)
        │  └─ Core agent tools (always present)
        │
        └─ Published every 30 seconds
          from ProjectContext.signer (PM's signer)
```

## 5. Daemon Command Flow

```
tenex daemon [--whitelist <pubkeys>] [--config <path>]
        │
        ├─ Load global config
        │  └─ ~/.tenex/config.json
        │
        ├─ Get whitelisted pubkeys
        │  ├─ Command line option
        │  └─ Fallback: config file
        │
        ├─ Check for required configs
        │  ├─ Whitelisted pubkeys
        │  └─ LLM configurations
        │
        ├─ If needed: runInteractiveSetup()
        │
        ├─ initNDK() → global singleton
        │
        ├─ Initialize core services:
        │  ├─ ProjectManager
        │  ├─ ProcessManager
        │  ├─ EventMonitor
        │  ├─ SchedulerService
        │  └─ DynamicToolService
        │
        ▼
EventMonitor.start(whitelistedPubkeys)
        │
        ├─ Subscribe to NDK filter:
        │  └─ authors: whitelistedPubkeys, limit: 0
        │
        ├─ For each event received:
        │  ├─ Extract project "a" tag
        │  ├─ Check if project running
        │  ├─ If not: ensureProjectExists()
        │  └─ If not running: spawnProjectRun()
        │
        ▼
Keep daemon running (await infinite promise)
```

## 6. Multi-Project State (Current vs Proposed)

### Current State (Process-Per-Project)

```
Daemon Process (Parent)
├─ EventMonitor (NDK subscription)
├─ ProcessManager
├─ Global config
└─ Global agent storage

    Child Process 1 (Project A)
    ├─ ProjectContext (Project A)
    ├─ EventHandler (Project A)
    ├─ SubscriptionManager (Project A)
    ├─ AgentRegistry (Project A)
    └─ StatusPublisher (24010)

    Child Process 2 (Project B)
    ├─ ProjectContext (Project B)
    ├─ EventHandler (Project B)
    ├─ SubscriptionManager (Project B)
    ├─ AgentRegistry (Project B)
    └─ StatusPublisher (24010)

    Child Process N (Project N)
    ├─ ProjectContext (Project N)
    ├─ EventHandler (Project N)
    ├─ SubscriptionManager (Project N)
    ├─ AgentRegistry (Project N)
    └─ StatusPublisher (24010)
```

**Issues**:
- Multiple SubscriptionManager instances creating redundant NDK subscriptions
- Separate processed-events tracking per project
- Separate ProjectContext per process
- High memory overhead for many projects

### Proposed Unified Daemon (Future)

```
Single Daemon Process (Multi-threaded)
├─ EventMonitor (NDK subscription)
├─ ProcessManager (projects, threads, or workers)
├─ MultiProjectEventHandler
│  ├─ Routes to Project A handler
│  ├─ Routes to Project B handler
│  └─ Routes to Project N handler
├─ MultiProjectSubscriptionManager
│  ├─ Single NDK subscription (more efficient)
│  └─ Routes events to correct handler
├─ Unified deduplication across projects
├─ Global config
└─ Global agent storage

    ProjectContext A
    ├─ AgentRegistry A
    ├─ ConversationCoordinator A
    └─ StatusPublisher A (24010)

    ProjectContext B
    ├─ AgentRegistry B
    ├─ ConversationCoordinator B
    └─ StatusPublisher B (24010)

    ProjectContext N
    ├─ AgentRegistry N
    ├─ ConversationCoordinator N
    └─ StatusPublisher N (24010)
```

**Benefits**:
- Reduced memory footprint
- Consolidated subscriptions
- Shared resource pools
- Better scalability

