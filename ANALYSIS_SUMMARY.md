# TENEX Architecture Analysis - Executive Summary

## Analysis Deliverables

Three comprehensive documents have been created:

1. **ARCHITECTURE_ANALYSIS.md** - Detailed 11-section analysis
2. **ARCHITECTURE_DIAGRAMS.md** - Visual ASCII diagrams  
3. **ARCHITECTURE_CODE_REFERENCE.md** - Code location reference

## Key Findings

### 1. Current "tenex project run" Works

**Flow**: Single-project listener that:
1. Loads project from Nostr using naddr
2. Initializes 5 concurrent NDK subscriptions
3. Runs EventHandler to route events to agents
4. Publishes agent responses and status (kind 24010) every 30s
5. Persists conversations to disk

**Key Components**:
- `ProjectContext` (global singleton per process)
- `AgentRegistry` (all agents for project)
- `SubscriptionManager` (5 concurrent subscriptions)
- `EventHandler` (routes by event kind)
- `StatusPublisher` (kind 24010 every 30s)

### 2. Event Routing Mechanism

**5 Concurrent Subscriptions** created by SubscriptionManager:
1. Project updates (kind 31933) + agent p-tags
2. Agent lessons (kind 32033/32034)
3. All project-tagged events
4. Spec replies (kind 1111 with #K:30023)
5. Conversation metadata (kind 513)

**Deduplication**: Per-project `.tenex/projects/{projectId}/processed-events.json` managed by EventRouter
**Routing**: EventHandler switches on event kind, then routes to agents

### 3. Project Context Loading

**Three-Step Process**:
1. Load config + fetch project from Nostr
2. Create AgentRegistry from project tags
3. Call `setProjectContext()` to make available globally

**PM Identification**: First agent in tags (or marked with "pm" tag)

**Agent Storage**: Global `~/.tenex/agents/<pubkey>.json` (unified as of Oct 17)

### 4. Multiple Projects/Agents Currently Handled

**Process-Per-Project Architecture**:
- Daemon spawns child process for each project
- Each process gets separate ProjectContext
- Each process creates separate SubscriptionManager (5 subscriptions)
- Separate event deduplication per project

**Current Limitations**:
- High memory overhead (multiple ProjectContext instances)
- Redundant subscriptions (same event kinds re-subscribed)
- Complex process management
- Not scalable for hundreds of projects

### 5. Daemon ↔ Projects ↔ Agents Relationship

```
DAEMON (EventMonitor + ProcessManager)
  ├─ Listens to Nostr for events from whitelisted pubkeys
  ├─ When event arrives: check if project running
  └─ If not: spawn "tenex project run" child process
      ↓
  CHILD PROJECT PROCESS (ProjectContext + EventHandler)
      ├─ Receives event from subscription
      ├─ Routes through EventHandler
      ├─ Executes agents
      └─ Publishes responses
```

**Shared State**:
- NDK singleton (same client)
- Global agent storage (~/.tenex/agents/)
- Global config (~/.tenex/config.json)

**Isolated State**:
- ProjectContext (per process)
- Subscriptions (per project)
- Conversation history (per project)

### 6. Event Publishing (24010) & Routing

**Kind 24010 Events** (Ephemeral status):
- Published every 30 seconds
- Contains: agents, models, tools in project
- Marks which agent is PM
- Excludes: delegate tools, core tools

**Event Routing Sequence**:
```
Event → SubscriptionManager → Dedup Check → EventHandler
         → IGNORED_KINDS check
         → Delegation check
         → Route by Kind (1111, 11, 31933, 24020, 513, 24134)
         → AgentRouter (resolve target agents)
         → AgentExecutor (parallel execution)
         → AgentPublisher (publish kind 1 response)
```

---

## Critical Architectural Constraints

### Must-Have Characteristics

1. **NDK as Source of Truth**
   - All data flows from Nostr/NDK
   - Events must be proper NDKEvent instances
   - Filtering happens at relay level

2. **Project Manager Identification**
   - First agent in project tags = PM (unless explicit "pm" tag)
   - PM's signer = project's signer (for signing outbound events)
   - PM's pubkey = project's pubkey

3. **Event Ordering Dependency**
   - Conversations resolved by e-tag/A-tag links
   - Deduplication prevents double-processing
   - Agent filters determine processing order

4. **Tool Validation Rules**
   - Tools validated against registry
   - MCP tools checked after initialization
   - Invalid tools silently skipped

---

## Design Decisions for Unified Daemon

### For Moving to Unified Approach, Must Decide:

1. **ProjectContext Management**
   - Option A: Stack-based context switching per thread
   - Option B: Map of ProjectContext by project ID
   - Option C: Refactor to remove global singleton

2. **Subscription Consolidation**
   - How to route consolidated subscription to correct projects
   - Maintain separate deduplication per project or unify?
   - Filter at NDK level or post-receipt routing?

3. **Threading Model**
   - Worker threads per project
   - Async/await with proper context isolation
   - Thread-safe access to ProjectContext

4. **Status Event Publishing**
   - Aggregate into single 24010 event?
   - Maintain per-project 24010 events?
   - How to identify project in aggregated event?

5. **Resource Sharing**
   - Shared LLM service pool?
   - Shared thread pools for agent execution?
   - Consolidated logging pipeline?

---

## File Organization (69,000 lines)

```
/src
├── commands/              # CLI entry points
│   ├── daemon.ts         # daemon command
│   └── project/run.ts    # project run command
├── daemon/               # Daemon-only components
│   ├── EventMonitor.ts
│   ├── ProcessManager.ts
│   └── ProjectManager.ts
├── event-handler/        # Event routing (124 lines each)
│   ├── index.ts          # Main event router
│   ├── reply.ts          # Handle messages
│   ├── newConversation.ts
│   └── project.ts        # Handle project updates
├── agents/               # Agent management
│   ├── AgentRegistry.ts  # Master registry
│   ├── AgentStorage.ts   # Persistence
│   └── execution/        # Agent execution
├── services/             # Project & LLM services
│   ├── ProjectContext.ts # Global singleton
│   ├── ConfigService.ts
│   ├── StatusPublisher.ts # 24010 events
│   ├── DelegationRegistry.ts
│   └── ...
├── conversations/        # Conversation management
├── nostr/                # NDK integration
├── llm/                  # LLM services
├── tools/                # Tool registry & implementations
└── utils/                # Utilities
```

---

## Recommended Next Steps

### Phase 1: Deep Understanding Complete ✓
- [x] Map event routing paths
- [x] Document ProcessManager responsibilities  
- [x] Chart data flow from EventMonitor to AgentExecutor

### Phase 2: Design Unified Approach
- [ ] Decide on ProjectContext management strategy
- [ ] Design consolidated event subscription
- [ ] Plan project-aware EventHandler

### Phase 3: Implement & Test
- [ ] Implement chosen architecture
- [ ] Ensure backwards compatibility with "project run"
- [ ] Add integration tests for multi-project scenario
- [ ] Benchmark: memory, CPU, subscription overhead

---

## Quick Reference Links

**Analysis Documents**:
- Architecture Analysis: `/ARCHITECTURE_ANALYSIS.md` (11 sections, 600 lines)
- Diagrams: `/ARCHITECTURE_DIAGRAMS.md` (6 visual diagrams)
- Code Reference: `/ARCHITECTURE_CODE_REFERENCE.md` (lookup tables)

**Key Entry Points**:
- Daemon: `/src/commands/daemon.ts` (99 lines)
- Project Run: `/src/commands/project/run.ts` (153 lines)
- EventMonitor: `/src/daemon/EventMonitor.ts` (128 lines)
- EventHandler: `/src/event-handler/index.ts` (411 lines)
- ProjectContext: `/src/services/ProjectContext.ts` (307 lines)
- AgentRegistry: `/src/agents/AgentRegistry.ts` (612 lines)

---

## Questions for Clarification

Before proceeding with implementation:

1. Should unified daemon maintain separate 24010 events per project or aggregate?
2. How many projects are realistically expected to run concurrently?
3. Should "tenex project run" remain as standalone option for testing?
4. Any performance targets (response latency, throughput)?
5. Should delegation operations be synchronous or async?

