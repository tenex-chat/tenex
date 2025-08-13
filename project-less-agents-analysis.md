# Project-Less Agents: Analysis & Design Suggestions

## Executive Summary
Enable agents to operate independently of projects, allowing direct chat interactions without requiring project context. This would create a more flexible, modular agent system suitable for standalone tools, personal assistants, and microservices.

## Current Architecture Analysis

### Core Dependencies on Projects

#### 1. **ProjectContext Coupling** 
- `src/services/ProjectContext.ts:51-86`: Orchestrator hardwired to project
- `src/agents/AgentRegistry.ts:296-304`: Project-manager agent uses project title
- All agent operations assume ProjectContext exists

#### 2. **Event Routing Architecture**
- `src/event-handler/index.ts:9`: Requires getProjectContext()
- Events filtered by project naddr (NDKProject reference)
- Orchestrator assumed to exist for all routing decisions

#### 3. **Conversation Persistence**
- `src/conversations/ConversationManager.ts:34-45`: Tied to projectPath
- Conversations stored in `.tenex/conversations/` under project

#### 4. **Agent Discovery & Registration**
- `src/agents/AgentRegistry.ts:54-106`: Loads both global and project agents
- Project agents override global agents with same slug/eventId

## Design Suggestions

### Solution 1: **Standalone Agent Mode** (KISS/YAGNI)
*Minimal changes, maximum compatibility*

```typescript
// New: src/agents/StandaloneAgentRunner.ts
class StandaloneAgentRunner {
    private agent: AgentInstance;
    private conversationManager: StandaloneConversationManager;
    
    constructor(agentSlug: string) {
        // Load from global registry only
        const registry = new AgentRegistry(getGlobalPath(), true);
        this.agent = registry.getAgent(agentSlug);
        
        // Use memory-only conversation management
        this.conversationManager = new StandaloneConversationManager();
    }
    
    async handleDirectMessage(event: NDKEvent): Promise<void> {
        // Direct execution without orchestrator routing
        const executor = new AgentExecutor(this.llmService, this.ndk);
        await executor.executeAgent(this.agent, event.content);
    }
}
```

**Changes Required:**
- Extract conversation management interface (SRP)
- Add memory-only persistence adapter
- New CLI command: `tenex agent chat <agent-slug>`
- Skip orchestrator for standalone mode

### Solution 2: **Virtual Project Context** (DRY)
*Reuse existing infrastructure with minimal modifications*

```typescript
// Modify: src/services/ProjectContext.ts
class ProjectContext {
    static createVirtual(agent: AgentInstance): ProjectContext {
        // Create lightweight context without NDKProject
        const virtualProject = {
            id: `virtual-${agent.pubkey}`,
            title: agent.name,
            tagValue: (tag: string) => null,
            pubkey: agent.pubkey
        };
        
        // Agent acts as its own orchestrator
        return new ProjectContext(virtualProject as any, new Map([
            [agent.slug, { ...agent, isOrchestrator: true }]
        ]));
    }
}
```

**Changes Required:**
- Make NDKProject optional in ProjectContext
- Add virtual project support to EventHandler
- Modify SubscriptionManager to handle agent-only subscriptions

### Solution 3: **Agent Service Architecture** (Clean Architecture)
*Proper separation of concerns, most flexible*

```typescript
// New: src/agents/service/AgentService.ts
interface AgentRuntime {
    handleMessage(message: string, context?: RuntimeContext): Promise<string>;
    getCapabilities(): AgentCapabilities;
}

class ProjectAgentRuntime implements AgentRuntime {
    constructor(private projectContext: ProjectContext) {}
    // Existing project-based logic
}

class StandaloneAgentRuntime implements AgentRuntime {
    constructor(private agent: AgentInstance) {}
    // Direct agent execution
}

// Factory pattern for runtime selection
class AgentRuntimeFactory {
    static create(options: RuntimeOptions): AgentRuntime {
        if (options.projectPath) {
            return new ProjectAgentRuntime(await loadProject(options.projectPath));
        }
        return new StandaloneAgentRuntime(await loadAgent(options.agentSlug));
    }
}
```

**Changes Required:**
- Extract agent runtime interface
- Implement standalone and project runtimes
- Update CLI to use factory pattern
- Separate concerns: routing, execution, persistence

## Implementation Recommendations

### Phase 1: Foundation (Week 1)
1. Extract interfaces for ConversationManager, AgentExecutor
2. Create memory-only persistence adapter
3. Add `isStandalone` flag to AgentInstance

### Phase 2: Standalone Mode (Week 2)
1. Implement StandaloneAgentRunner
2. Add `tenex agent chat` command
3. Create direct NDK subscription for agent pubkey

### Phase 3: Enhanced Features (Week 3)
1. Add conversation history for standalone agents
2. Implement agent-to-agent communication without projects
3. Create agent marketplace/registry integration

## Key Design Decisions

### 1. **Conversation Persistence**
- **Option A**: Memory-only for standalone (simpler, stateless)
- **Option B**: SQLite per agent (persistent, complex)
- **Recommendation**: Start with A, migrate to B if needed

### 2. **Event Subscription**
- **Option A**: Direct pubkey subscription (simple, efficient)
- **Option B**: Virtual project events (reuses infrastructure)
- **Recommendation**: Option A for true independence

### 3. **Orchestrator Role**
- **Option A**: No orchestrator for standalone (direct execution)
- **Option B**: Agent as self-orchestrator (maintains patterns)
- **Recommendation**: Option A, cleaner separation

### 4. **Configuration Storage**
- **Current**: Global agents in ~/.tenex/agents/
- **Enhancement**: Add ~/.tenex/standalone/ for runtime state
- **Recommendation**: Keep using global registry as-is

## Migration Path

### Backwards Compatibility
- All existing project-based flows unchanged
- Global agents can work in both modes
- Progressive enhancement approach

### Configuration Changes
```json
// ~/.tenex/agents.json
{
  "my-assistant": {
    "nsec": "...",
    "file": "my-assistant.json",
    "standalone": true,  // New flag
    "subscriptions": {   // New: direct subscription config
      "relays": ["wss://relay.example.com"],
      "filters": { "kinds": [1], "#p": ["agent-pubkey"] }
    }
  }
}
```

## Benefits

1. **Modularity**: Agents become true microservices
2. **Scalability**: Deploy agents independently
3. **Flexibility**: Mix project and standalone agents
4. **Simplicity**: Direct agent interaction without overhead
5. **Marketplace**: Easier agent distribution and discovery

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Code duplication | Medium | Extract shared interfaces early |
| Feature parity | Low | Document standalone limitations |
| User confusion | Medium | Clear CLI help and docs |
| State management | High | Start stateless, add persistence later |

## Conclusion

The **Standalone Agent Mode** (Solution 1) offers the best balance of simplicity and functionality while adhering to KISS/YAGNI principles. It requires minimal changes to existing code, maintains backwards compatibility, and provides a clear upgrade path to more sophisticated solutions if needed.

The implementation should focus on:
1. Clean interface extraction (SRP)
2. Memory-only operation initially (YAGNI)
3. Direct NDK subscriptions (KISS)
4. Reusing existing AgentExecutor without orchestrator overhead (DRY)

This approach enables immediate value while keeping the door open for future enhancements like persistent conversations, agent marketplaces, and sophisticated routing mechanisms.