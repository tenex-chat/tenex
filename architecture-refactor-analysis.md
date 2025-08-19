# TENEX Architecture Analysis: Current vs Proposed

## Current Architecture Flow

```mermaid
sequenceDiagram
    participant User
    participant EventHandler
    participant ReplyHandler
    participant AgentExecutor
    participant RAL as ReasonActLoop
    participant LLM
    participant Tools
    participant DelegationService
    participant NostrPublisher
    participant EventTagger
    participant Network

    User->>EventHandler: Nostr Event (kind 1111)
    EventHandler->>ReplyHandler: Route to handler
    ReplyHandler->>AgentExecutor: Execute with context
    AgentExecutor->>RAL: Start execution
    
    loop Reason-Act-Observe
        RAL->>LLM: Stream with messages + tools
        LLM-->>RAL: Content + Tool calls
        
        alt Tool: delegate
            RAL->>Tools: Execute delegate()
            Tools->>DelegationService: Create delegation
            DelegationService->>EventTagger: Tag events
            DelegationService-->>Tools: Serialized events
            Tools-->>RAL: {serializedEvents, toolType: 'delegate'}
        else Tool: complete
            RAL->>Tools: Execute complete()
            Tools->>EventTagger: Create completion tags
            Tools-->>RAL: {serializedEvent, toolType: 'complete'}
        else Other tools
            RAL->>Tools: Execute tool
            Tools-->>RAL: Tool result
        end
    end
    
    RAL->>RAL: Detect terminal tool
    RAL->>Network: Publish deferred events
```

## Proposed Architecture Flow

```mermaid
sequenceDiagram
    participant User
    participant EventHandler
    participant ReplyHandler  
    participant AgentExecutor
    participant RAL as ReasonActLoop
    participant LLM
    participant Tools
    participant AAD as AgentActionDispatcher
    participant Network

    User->>EventHandler: Nostr Event (kind 1111)
    EventHandler->>ReplyHandler: Route to handler
    ReplyHandler->>AgentExecutor: Execute with context
    AgentExecutor->>RAL: Start execution
    
    loop Reason-Act-Observe
        RAL->>LLM: Stream with messages + tools
        LLM-->>RAL: Content + Tool calls
        
        alt Tool returns intent
            RAL->>Tools: Execute tool
            Tools-->>RAL: Intent data only
            Note over Tools: Just returns data,<br/>no event creation
        end
    end
    
    RAL->>RAL: Collect execution context
    Note over RAL: Tool calls, timing,<br/>model info, etc.
    
    alt Delegation Intent
        RAL->>AAD: dispatchDelegation(intent, context)
        AAD->>AAD: Create NDKTask events
        AAD->>AAD: Apply tags and metadata
        AAD->>Network: Publish delegation events
    else Completion Intent  
        RAL->>AAD: dispatchCompletion(intent, context)
        AAD->>AAD: Create completion event
        AAD->>AAD: Apply tags and metadata
        AAD->>Network: Publish completion event
    else Conversation Intent
        RAL->>AAD: dispatchConversation(intent, context)
        AAD->>AAD: Create response event
        AAD->>Network: Publish response
    end
```

## Key Architectural Changes

### 1. Tool Simplification
```mermaid
graph LR
    subgraph "Current Tools"
        T1[delegate.ts] --> E1[Creates Events]
        T2[complete.ts] --> E2[Creates Events]
        T1 --> DS[DelegationService]
        DS --> ET[EventTagger]
    end
    
    subgraph "Proposed Tools"
        NT1[delegate.ts] --> I1[Returns Intent]
        NT2[complete.ts] --> I2[Returns Intent]
    end
```

### 2. Event Creation Consolidation
```mermaid
graph TB
    subgraph "Current: Scattered Event Creation"
        NostrPublisher --> Events1[Response Events]
        DelegationService --> Events2[Task Events]
        CompletionHandler --> Events3[Completion Events]
        StatusPublisher --> Events4[Status Events]
        AgentPublisher --> Events5[Profile Events]
    end
    
    subgraph "Proposed: Centralized Dispatch"
        AAD[AgentActionDispatcher] --> AllEvents[All Event Types]
        AAD --> |uses| EventTagger
        AAD --> |uses| NostrPublisher
    end
```

### 3. Data Flow Clarity
```mermaid
graph LR
    subgraph "Intent Flow"
        Tools -->|Pure Data| Intents
        Context[Execution Context] -->|Metadata| AAD
        Intents -->|What to do| AAD
        AAD -->|Events| Network
    end
```

## Modules to Remove/Refactor

### 1. **EventTagger** - Partially Remove
- Keep the tagging logic but move it inside AgentActionDispatcher
- No longer a separate service, becomes internal implementation detail

### 2. **DelegationService** - Refactor
- Remove event creation logic
- Keep only recipient resolution logic
- Move to a pure utility for resolving agent names/pubkeys

### 3. **CompletionHandler** - Remove
- Its event creation logic moves to AgentActionDispatcher
- RAL already handles completion detection

### 4. **Multiple Publishers** - Consolidate
- Keep NostrPublisher for low-level publishing
- Remove domain-specific publishers (StatusPublisher, etc.)
- AgentActionDispatcher handles all domain logic

## New Module Structure

```mermaid
graph TB
    subgraph "Core Execution"
        EH[EventHandler] --> AE[AgentExecutor]
        AE --> RAL[ReasonActLoop]
    end
    
    subgraph "Tool Layer"
        RAL --> Tools
        Tools --> Intents[Intent Objects]
    end
    
    subgraph "Dispatch Layer"
        RAL --> AAD[AgentActionDispatcher]
        AAD --> NP[NostrPublisher]
        AAD --> Registry[DelegationRegistry]
    end
    
    subgraph "Utilities"
        AAD -.-> AR[AgentResolver]
        AAD -.-> PM[ProjectMetadata]
    end
```

## Benefits of This Architecture

1. **Clear Separation of Concerns**
   - Tools: Business logic only
   - RAL: Orchestration only
   - AAD: Event creation/publishing only

2. **Testability**
   - Tools are pure functions
   - AAD can be tested with mock publishers
   - RAL can be tested with mock AAD

3. **Extensibility**
   - New intent types are easy to add
   - Event format changes are centralized
   - Publishing strategies can evolve in one place

4. **Type Safety**
   - Intents are strongly typed
   - No serialization until the last moment
   - Context is explicitly passed

## Implementation Priority

1. **Phase 1**: Create AgentActionDispatcher
2. **Phase 2**: Refactor tools to return intents
3. **Phase 3**: Update RAL to use AAD
4. **Phase 4**: Remove obsolete modules
5. **Phase 5**: Consolidate remaining publishers

## AgentActionDispatcher Internal Design

```mermaid
classDiagram
    class AgentActionDispatcher {
        -ndk: NDK
        -publisher: NostrPublisher
        -projectContext: ProjectContext
        +dispatchDelegation(intent, context): Promise~void~
        +dispatchCompletion(intent, context): Promise~void~
        +dispatchConversation(intent, context): Promise~void~
        -createBaseEvent(kind): NDKEvent
        -applyFlowContext(event, triggerEvent): void
        -applyAgentMetadata(event, agent): void
    }
    
    class DelegationIntent {
        +type: "delegate"
        +recipients: string[]
        +title: string
        +request: string
        +phase?: string
    }
    
    class CompletionIntent {
        +type: "complete"
        +content: string
    }
    
    class ConversationIntent {
        +type: "conversation"
        +content: string
    }
    
    class ExecutionContext {
        +agent: AgentInstance
        +triggeringEvent: NDKEvent
        +conversationId: string
        +toolCalls: ToolCall[]
        +executionTime: number
        +model: string
        +usage: UsageStats
    }
    
    AgentActionDispatcher ..> DelegationIntent
    AgentActionDispatcher ..> CompletionIntent
    AgentActionDispatcher ..> ConversationIntent
    AgentActionDispatcher ..> ExecutionContext
```

## Example Usage in RAL

```typescript
// In ReasonActLoop after processing iteration
if (iterationResult.terminalIntent) {
    const dispatcher = new AgentActionDispatcher(
        this.ndk,
        this.publisher,
        this.projectContext
    );
    
    const executionContext = {
        agent: context.agent,
        triggeringEvent: context.triggeringEvent,
        conversationId: context.conversationId,
        toolCalls: stateManager.getToolCalls(),
        executionTime: Date.now() - startTime,
        model: finalResponse?.model,
        usage: finalResponse?.usage
    };
    
    switch (iterationResult.terminalIntent.type) {
        case 'delegate':
            await dispatcher.dispatchDelegation(
                iterationResult.terminalIntent,
                executionContext
            );
            break;
            
        case 'complete':
            await dispatcher.dispatchCompletion(
                iterationResult.terminalIntent,
                executionContext
            );
            break;
            
        case 'conversation':
            await dispatcher.dispatchConversation(
                iterationResult.terminalIntent,
                executionContext
            );
            break;
    }
}
```

## Modules That Become Obsolete

1. **EventTagger** → Logic absorbed into AgentActionDispatcher
2. **Multiple event creation points** → All consolidated
3. **Deferred publishing logic in RAL** → No longer needed
4. **Event creation in tools** → Tools become pure functions
5. **ComplexStreamPublisher logic** → Simplified or removed

## Current Architecture Problems Solved

```mermaid
graph TB
    subgraph "Problem 1: Scattered Event Creation"
        P1A[10+ files create events]
        P1B[Each has own patterns]
        P1C[Duplication everywhere]
    end
    
    subgraph "Problem 2: Mixed Concerns"
        P2A[Tools create events]
        P2B[Business logic mixed with publishing]
        P2C[Hard to test in isolation]
    end
    
    subgraph "Problem 3: Complex State Management"
        P3A[Deferred publishing in RAL]
        P3B[Serialization/deserialization]
        P3C[Terminal tool detection logic]
    end
    
    subgraph "Solution: Clean Architecture"
        S1[Single dispatch point]
        S2[Pure function tools]
        S3[Direct publishing]
    end
    
    P1A --> S1
    P1B --> S1
    P1C --> S1
    P2A --> S2
    P2B --> S2
    P2C --> S2
    P3A --> S3
    P3B --> S3
    P3C --> S3
```

## Critical Path for Refactoring

The key insight is that we need to:

1. **Stop** tools from creating events
2. **Start** tools returning simple intent objects
3. **Move** all event creation to AgentActionDispatcher
4. **Remove** the complex deferred publishing logic
5. **Simplify** RAL to just orchestrate and dispatch

This creates a much cleaner separation where:
- **Tools** = Pure business logic
- **RAL** = Orchestration only
- **AgentActionDispatcher** = Event creation and publishing
- **NostrPublisher** = Low-level publishing mechanics