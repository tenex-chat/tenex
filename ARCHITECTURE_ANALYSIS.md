# TENEX Architecture Analysis

## Executive Summary

TENEX is a distributed agent orchestration system built on Nostr. It currently uses two operational modes:
1. **Project Run Mode** (`tenex project run`): Standalone listener for a single project
2. **Daemon Mode** (`tenex daemon`): Multi-project manager that spawns child processes

The codebase is approximately 69,000 lines of TypeScript with a unified storage model introduced in recent refactoring (storage architecture unification, Oct 17).

---

## 1. HOW "tenex project run" CURRENTLY WORKS

### Entry Point: `/src/commands/project/run.ts`

The `project run` command orchestrates a complete TENEX project listener:

```
tenex project run [--path <path>]
    ↓
1. ensureProjectInitialized(projectPath)
   - Loads project from Nostr using naddr
   - Creates ProjectContext
   - Initializes AgentRegistry
   
2. mcpService.initialize(projectPath)
   - Loads MCP servers from project tags
   
3. SchedulerService.initialize()
   - Sets up scheduler for delayed tasks
   
4. RagSubscriptionService.initialize()
   - Initializes RAG (Retrieval-Augmented Generation)
   
5. dynamicToolService.initialize()
   - Loads dynamic tools
   
6. Refresh agent tools with MCP tools
   
7. ProjectDisplay.displayProjectInfo()
   - Shows agents, models, tools in formatted output
   
8. runProjectListener(projectPath)
   ↓
   8a. EventHandler.initialize()
       - Initializes DelegationRegistry
       - Creates ConversationCoordinator
       - Creates AgentExecutor
   
   8b. SubscriptionManager.start()
       - Subscribes to 5 event types (see section 2)
       - Routes events through EventHandler
   
   8c. StatusPublisher.startPublishing()
       - Publishes kind:24010 events every 30 seconds
   
   8d. OperationsStatusPublisher.start()
       - Tracks LLM operation statuses
   
   8e. setupGracefulShutdown()
       - Handles Ctrl+C cleanup
```

### Key Processes

**ProjectContext Initialization** (`/src/services/ProjectContext.ts`):
- Holds reference to NDKProject, AgentRegistry, and LLMLogger
- Single source of truth for all agents in the project
- Identifies Project Manager (PM) agent (first agent in tags or marked with "pm" role)
- Hardwires PM's signer and pubkey for project signing

**Agent Registry** (`/src/agents/AgentRegistry.ts`):
- Manages all agents for a project
- Loads agents from storage (global ~/.tenex/agents/) and Nostr
- Creates AgentInstance with LLM service factory
- Handles agent-specific configuration changes
- Persists PM status to disk

---

## 2. EVENT ROUTING MECHANISM AND SUBSCRIPTION MANAGEMENT

### SubscriptionManager (`/src/commands/run/SubscriptionManager.ts`)

Creates **5 concurrent NDK subscriptions** to different event kinds:

#### Subscription 1: Project Updates (NDKProject kind 31933)
```
Filter: project's naddr
        + agent pubkeys (#p tags)
Purpose: Detect project updates and new mentions
```

#### Subscription 2: Agent Lessons (kind 32033 + 32034)
```
Filter: authors = all agent pubkeys
Purpose: Collect learned lessons from agents
Action: Updates ProjectContext.agentLessons (max 50 per agent)
```

#### Subscription 3: Project Events (kind matching project)
```
Filter: project.filter()
Purpose: All events tagging the project
```

#### Subscription 4: Spec Replies (kind 1111)
```
Filter: kind 1111 + #K:30023 (spec documents)
Purpose: Replies to specification documents
Routing: Uses A-tag value as conversationId
```

#### Subscription 5: Conversation Metadata (kind 513)
```
Filter: authors = agent pubkeys + project owner
        kinds: [513]
Purpose: Conversation title updates
```

### Event Deduplication (Unified Daemon)
- **Tracking File**: `.tenex/projects/{projectId}/processed-events.json` (per project)
- **Memory Cache**: `Map<projectId, Set<eventId>>` in EventRouter
- **Logic**: `EventRouter.markProcessed()` marks event as seen for specific project
- **Persistence**: Debounced (5s) saves to prevent excessive I/O
- **Limit**: Keeps last 10,000 events per project to prevent unbounded growth

### Event Routing Flow

```
Event arrives → SubscriptionManager.handleIncomingEvent()
    ↓
Check deduplication cache
    ↓
Add to processed cache (memory)
    ↓
EventHandler.handleEvent(event)
```

---

## 3. PROJECT CONTEXT LOADING AND MANAGEMENT

### ProjectContext (`/src/services/ProjectContext.ts`)

**Single Global Instance** accessible via `getProjectContext()`:

```typescript
// Holds:
- project: NDKProject (the project event from Nostr)
- agentRegistry: AgentRegistry (all agents for project)
- signer: NDKPrivateKeySigner (PM's signer)
- pubkey: string (PM's pubkey)
- projectManager: AgentInstance (PM agent)
- agentLessons: Map<pubkey, NDKAgentLesson[]>
- conversationCoordinator: ConversationCoordinator (optional)
- llmLogger: LLMLogger (logging for LLM operations)
```

### Initialization Flow

```
1. ensureProjectInitialized(projectPath)
   └─ loads config.json from .tenex/
   └─ fetches project from Nostr (using projectNaddr)
   └─ creates AgentRegistry
   
2. AgentRegistry.loadFromProject(ndkProject)
   └─ clears existing agents
   └─ loads agents from global storage (~/.tenex/agents/)
   └─ installs missing agents from Nostr
   └─ creates AgentInstance for each
   
3. setProjectContext(project, agentRegistry, llmLogger)
   └─ creates ProjectContext
   └─ identifies PM agent
   └─ calls agentRegistry.setPMPubkey()
   └─ calls agentRegistry.persistPMStatus()
```

### Agent Storage (Unified Model - Oct 17)

**Location**: `~/.tenex/agents/<pubkey>.json`

**Stored per Agent**:
```json
{
  "eventId": "event_id_or_null",
  "nsec": "private_key",
  "slug": "agent_slug",
  "name": "Agent Name",
  "role": "pm|agent|delegated",
  "description": "...",
  "instructions": "...",
  "useCriteria": "...",
  "llmConfig": "config_slug",
  "tools": ["tool1", "tool2"],
  "phase": "phase_name|null",
  "phases": {...},
  "projects": ["project_d_tag1", "project_d_tag2"]
}
```

---

## 4. HOW MULTIPLE PROJECTS/AGENTS ARE CURRENTLY HANDLED

### Current Architecture: Process-Per-Project

```
tenex daemon (parent process)
    ↓
EventMonitor (subscribes to events from whitelisted pubkeys)
    ↓
When event received → ProjectManager checks if project running
    ↓
If not running → ProcessManager.spawnProjectRun()
    ↓
Child process: "bun run tenex.ts project run --path /projects/identifier/"
```

### ProcessManager (`/src/daemon/ProcessManager.ts`)

```typescript
// Tracks:
- Map<projectId, ProcessInfo>
  where ProcessInfo = { process, projectPath, startedAt }

// Operations:
- spawnProjectRun(projectPath, projectId)
  └─ spawns child process with stdio: "inherit"
  └─ stores in Map
  └─ handles exit/error events
  
- isProjectRunning(projectId)
  └─ checks process.pid exists
  
- stopProject(projectId)
  └─ sends SIGTERM, waits 5s, then SIGKILL
  
- stopAll()
  └─ stops all projects on shutdown
```

### ProjectManager (`/src/daemon/ProjectManager.ts`)

```typescript
// Operations:
- initializeProject(projectPath, naddr, ndk)
  └─ fetches project from Nostr
  └─ clones repo if specified
  └─ installs agents from Nostr
  └─ installs MCP servers
  └─ creates project structure
  
- loadProject(projectPath)
  └─ reads .tenex/config.json
  
- ensureProjectExists(identifier, naddr, ndk)
  └─ checks if already initialized
  └─ initializes if not
  
- loadAndInitializeProjectContext(projectPath, ndk)
  └─ loads project from Nostr
  └─ creates AgentRegistry
  └─ creates LLMLogger
  └─ calls setProjectContext()
  └─ initializes ConversationCoordinator
```

### Agent Instance Lookup

**Global Agents** (shared across projects):
- Stored in `~/.tenex/agents/`
- Loaded on-demand by AgentRegistry
- Multiple projects can reference same agent

**Project-Specific Agents**:
- Specified in project tags: `["agent", "event_id"]`
- Created on first project run if not in storage

---

## 5. RELATIONSHIP BETWEEN DAEMON, PROJECTS, AND AGENTS

### Hierarchical Model

```
┌─────────────────────────────────────────┐
│         TENEX DAEMON (main process)     │
│  - EventMonitor (listens on Nostr)     │
│  - ProcessManager (spawns children)    │
│  - SchedulerService (global scheduler) │
│  - DynamicToolService (global tools)   │
└─────────────────────────────────────────┘
        ↓ (spawns for each active project)
┌─────────────────────────────────────────┐
│      PROJECT PROCESS (child)            │
│  - ProjectContext (project state)       │
│  - EventHandler (project-specific)      │
│  - SubscriptionManager (project feeds)  │
│  - StatusPublisher (24010 events)       │
└─────────────────────────────────────────┘
        ↓ (manages)
┌─────────────────────────────────────────┐
│      AGENTS (in memory)                 │
│  - AgentRegistry (per project)          │
│  - AgentInstance (with signer)          │
│  - AgentExecutor (runs agents)          │
└─────────────────────────────────────────┘
        ↓ (acts on)
┌─────────────────────────────────────────┐
│      NOSTR (network)                    │
│  - Publishes agent responses (kind 1)   │
│  - Publishes status events (kind 24010) │
│  - Listens for new conversations        │
└─────────────────────────────────────────┘
```

### Data Flow

```
Nostr Event
    ↓
EventMonitor (daemon) → ProjectManager → ProcessManager
    ↓
spawnProjectRun() → "project run" (child process)
    ↓
SubscriptionManager → EventHandler → AgentExecutor
    ↓
AgentInstance → LLM Call → Parse Response
    ↓
AgentPublisher → Nostr (kind 1)
```

### Shared vs Isolated State

**Daemon-Level (Shared)**:
- EventMonitor
- ProcessManager
- SchedulerService singleton
- DynamicToolService singleton
- Global config in ~/.tenex/config.json
- Global agents in ~/.tenex/agents/

**Project-Level (Isolated)**:
- ProjectContext singleton (per project process)
- EventHandler (per project)
- SubscriptionManager (per project)
- StatusPublisher (per project)
- ConversationCoordinator (per project)
- Project config in .tenex/config.json
- Processed events tracking

---

## 6. EVENT PUBLISHING (24010 Events) AND ROUTING LOGIC

### Status Publisher - 24010 Events (`/src/services/status/StatusPublisher.ts`)

**Kind 24010**: Ephemeral "project status" event

**Published Every 30 Seconds** containing:

```
Event Kind: 24010 (ephemeral, not stored)
Content: empty

Tags:
├─ Project Reference (a-tag)
├─ p-tag: project owner pubkey
├─ agent tags: [agent, pubkey, slug, ?pm]
├─ model tags: [model, config_slug, agent1, agent2, ...]
└─ tool tags: [tool, name, agent1, agent2, ...]
```

**Information Included**:
- All agents active in project
- Which agent is PM (marked with "pm" flag)
- Model configurations and which agents use them
- Tool availability and which agents have access

**Excluded from 24010**:
- Delegate tools (system-level delegation)
- Core agent tools (always present)

### Event Routing in EventHandler (`/src/event-handler/index.ts`)

```
Event received
    ↓
IGNORED_EVENT_KINDS check:
├─ kind 0 (metadata)
├─ kind 3 (contacts)
├─ kind 24010 (project status) ← ignored
├─ kind 24111 (typing indicator)
├─ kind 24112 (typing stop)
└─ kind 24113 (operations status)
    ↓ (if ignored, return early)
    
Check if delegation response
├─ yes → DelegationRegistry.handleDelegationResponse()
└─ add to conversation history
    ↓
Route by Kind:
├─ kind 1111 (GenericReply) → handleChatMessage()
├─ kind 11 (Thread/Conversation) → handleNewConversation()
│   └─ check if brainstorm mode
├─ kind 31933 (NDKProject) → handleProjectEvent()
├─ kind 24020 (AGENT_CONFIG_UPDATE) → handleAgentConfigUpdate()
├─ kind 513 (metadata) → handleMetadataEvent()
├─ kind 24134 (STOP event) → handleStopEvent()
└─ default → handleDefaultEvent()
```

### AgentRouter (`/src/event-handler/AgentRouter.ts`)

Determines which agents should process an event:

```
resolveTargetAgents(event, projectCtx)
    ↓
Check p-tags (recipients)
├─ If p-tags present → agents matching those pubkeys
├─ If #d tag present → conversation-specific routing
├─ If #root tag → delegate to delegate_phase agents
└─ Otherwise → PM agent
    ↓
filterOutSelfReplies()
    ↓
Filter agents who would process their own messages
├─ Exception: agents with "delegate_phase" tool can self-reply
```

### Conversation Resolution (`/src/conversations/services/ConversationResolver.ts`)

For each event, determines if it belongs to:
1. Existing conversation (by e-tag/A-tag links)
2. New conversation (root thread)

---

## 7. AGENT EXECUTION AND LLM OPERATIONS

### AgentExecutor (`/src/agents/execution/AgentExecutor.ts`)

Executes agents with comprehensive LLM operation tracking:

```
execute(executionContext)
    ↓
1. Load conversation history
2. Build system prompt with agent instructions
3. Create LLM service for agent
4. Register operation in llmOpsRegistry
    ↓
5. Stream LLM response
    ├─ Publish streaming events (kind 24111)
    ├─ Track tokens, costs, timing
    └─ Handle tool execution requests
    ↓
6. Parse structured response
    ├─ Extract decision node
    ├─ Execute delegations if needed
    ├─ Manage phase transitions
    └─ Execute tools
    ↓
7. Publish final response (kind 1)
8. Save conversation history
9. Deregister operation
```

### LLM Operations Registry (`/src/services/LLMOperationsRegistry.ts`)

Tracks active LLM operations:
- Stores operation state (streaming, completed, failed)
- Allows stopping operations via kind 24134 events
- Publishes operation status via OperationsStatusPublisher

---

## 8. KEY ARCHITECTURAL COMPONENTS

### Storage

**Global** (`~/.tenex/`):
```
config.json          # LLM configs, whitelisted pubkeys
agents/              # Shared agent storage
  <pubkey>.json      # Agent definition
```

**Per-Project** (`.tenex/projects/{projectId}/`):
```
config.json               # Project-specific config (DEPRECATED in unified daemon)
conversations/            # Conversation history
logs/                     # LLM logs
processed-events.json     # Per-project event deduplication cache
```

### Singletons

- **NDK**: Global Nostr client
- **ProjectContext**: Per-project (switches on project run)
- **AgentRegistry**: Per-project instance
- **SchedulerService**: Shared across projects
- **DynamicToolService**: Shared across projects
- **DelegationRegistry**: Per-project initialization

### Key Services

**ConfigService**: Loads/saves configs
**MCPService**: Manages MCP servers
**RagSubscriptionService**: Handles RAG operations
**StatusPublisher**: Publishes 24010 events
**OperationsStatusPublisher**: Publishes operation status
**BrainstormService**: Handles brainstorm events

---

## 9. IDENTIFIED AREAS FOR UNIFIED DAEMON APPROACH

### Current Limitations

1. **Process-Per-Project Model**:
   - Each project runs in separate child process
   - Separate ProjectContext per process
   - Separate subscriptions per project (duplicated filters)
   - High overhead for many projects

2. **Event Deduplication** (✅ RESOLVED in unified daemon):
   - Per-project processed-events.json files in `.tenex/projects/{projectId}/`
   - Managed by EventRouter with debounced persistence
   - Limited to 10,000 events per project for memory efficiency

3. **Scheduler/Tool Services**:
   - Singletons exist but shared only within daemon
   - Each project process re-initializes them
   - Potential for state inconsistencies

4. **Status Publishing**:
   - Each project publishes separate 24010 events
   - Could aggregate into single event

### Unified Daemon Approach Would Require

1. **Multi-Project Context Management**:
   - Switch between ProjectContext instances
   - Or refactor to ProjectContexts (plural)
   - Thread-safe access to different project states

2. **Consolidated Event Routing**:
   - EventHandler becomes multi-project aware
   - Route events to appropriate project's handlers
   - Shared subscription for all projects (more efficient)

3. **Consolidated Processing**:
   - Single EventHandler with project routing
   - Shared processing queues per project
   - Centralized conversation coordination

4. **Single Status Event**:
   - Aggregate 24010 events for all active projects
   - Or maintain per-project status (requires routing)

5. **Resource Management**:
   - Centralized thread/worker pool
   - Shared LLM service factories
   - Consolidated logging

---

## 10. CRITICAL DEPENDENCIES AND CONSTRAINTS

### NDK Integration
- All project/agent data comes from Nostr via NDK
- Events must be properly typed as NDKEvent
- Filtering happens at relay subscription level

### Project Manager Identification
- First agent in project tags = PM (unless explicit "pm" tag)
- PM's signer is project's signer
- PM's pubkey is project's pubkey (for signing events)

### Event Ordering
- Conversation resolution depends on e-tag/A-tag links
- Deduplication prevents duplicate processing
- Agent filters must respect routing rules

### Tool Validation
- Tools are validated against tool registry
- MCP tools checked after initialization
- Invalid tools silently skipped

---

## 11. RECOMMENDED CHANGES FOR ARCHITECTURE ANALYSIS

### Phase 1: Understand Current State
- [x] Map event routing paths
- [x] Document ProcessManager responsibilities
- [x] Chart data flow from EventMonitor to AgentExecutor

### Phase 2: Design Unified Approach
- [ ] Design multi-project context management
- [ ] Plan consolidated event subscription
- [ ] Design project-aware EventHandler

### Phase 3: Implementation Decisions
- [ ] Single ProjectContext vs Multiple (concurrent)
- [ ] Threading model for concurrent projects
- [ ] State isolation and synchronization
- [ ] Backwards compatibility with existing "project run"

