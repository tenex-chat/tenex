# Conversation Management Architecture

## Executive Summary

The Conversation Management system is the foundational infrastructure that orchestrates multi-agent interactions, maintains state consistency, and enables coherent task execution across TENEX. Built on an event-driven Nostr protocol foundation, it provides sophisticated message routing, context management, and state persistence while maintaining agent autonomy. The architecture uniquely combines event sourcing principles with phase-based workflow orchestration to deliver a seamless conversational experience backed by deterministic execution guarantees.

## Table of Contents

1. [Core Architecture](#core-architecture)
2. [State Management](#state-management)
3. [Message Building and Context](#message-building-and-context)
4. [Event-Driven Integration](#event-driven-integration)
5. [Persistence Layer](#persistence-layer)
6. [Phase Management Integration](#phase-management-integration)
7. [Agent State Tracking](#agent-state-tracking)
8. [Orchestrator Turn Management](#orchestrator-turn-management)
9. [Recovery and Resilience](#recovery-and-resilience)
10. [Performance Optimizations](#performance-optimizations)
11. [Questions and Uncertainties](#questions-and-uncertainties)

## Core Architecture

### System Overview

The ConversationCoordinator serves as the central hub for all conversation-related operations:

```
┌─────────────────────────────────────────────────────────┐
│                   Nostr Events                           │
│              (User messages, Agent responses)            │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│             ConversationCoordinator                      │
│         (Central State Orchestrator)                     │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  State Management                                │   │
│  │  • Active conversations map                      │   │
│  │  • Agent states per conversation                 │   │
│  │  • Phase transitions                            │   │
│  │  • Orchestrator turns                           │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Message Building                                │   │
│  │  • Historical context assembly                   │   │
│  │  • Agent-specific views                         │   │
│  │  • Incremental processing                       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Persistence                                     │   │
│  │  • File-based state storage                     │   │
│  │  • Atomic writes                                │   │
│  │  • Recovery mechanisms                          │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────┬───────────────────────────────────┘
                      │
         ┌────────────┼────────────┐
         ▼            ▼            ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │ Agent 1 │ │ Agent 2 │ │ Agent 3 │
    └─────────┘ └─────────┘ └─────────┘
```

### Core Components

#### ConversationCoordinator Class (src/conversations/services/ConversationCoordinator.ts)

The central class that manages all conversation lifecycle operations:

**Key Responsibilities:**
- **State Management**: Maintains in-memory state of all active conversations
- **Message Building**: Constructs agent-specific message contexts
- **Phase Orchestration**: Manages phase transitions and enforcement
- **Turn Tracking**: Monitors orchestrator routing decisions
- **Persistence**: Handles saving and loading conversation state
- **Event Processing**: Integrates with Nostr event system

**Core Data Structures:**
```typescript
class ConversationCoordinator {
    private conversations: Map<string, Conversation>;
    private conversationContexts: Map<string, TracingContext>;
    private projectContext: ProjectContext;
    private stateDir: string;
}
```

### Implementation Architecture

The conversation management system is built on several key architectural patterns:

#### 1. **Event Sourcing Pattern**
All state changes originate from Nostr events, providing:
- Immutable audit trail
- Natural event replay capability
- Distributed state synchronization
- Crash recovery through event reconstruction

#### 2. **Repository Pattern for Persistence**
File-based storage with atomic operations:
- Each conversation stored as separate JSON file
- Atomic writes prevent corruption
- Lazy loading for memory efficiency
- Recovery mechanisms for corrupted state

#### 3. **Builder Pattern for Messages**
Sophisticated message construction:
- Agent-specific context windows
- Incremental processing markers
- Role-based message transformation
- Handoff context preservation

#### 4. **State Machine for Phases**
Deterministic phase transitions:
- Enforced quality gates
- Valid transition paths
- Automatic phase advancement
- Rollback prevention

## State Management

### Conversation State Structure

The complete state of a conversation is captured in the Conversation interface:

```typescript
interface Conversation {
    // Core Identity
    id: string;                              // Unique conversation identifier
    title: string;                           // Human-readable title
    createdAt: number;                       // Creation timestamp
    updatedAt: number;                       // Last update timestamp
    
    // Workflow State
    phase: Phase;                            // Current phase (chat/plan/execute/etc)
    phaseStartedAt?: number;                 // When current phase started
    phaseTransitions: PhaseTransition[];    // Complete transition history
    
    // Message History
    history: NDKEvent[];                     // All conversation events
    agentStates: Map<string, AgentState>;   // Per-agent processing state
    
    // Orchestration
    orchestratorTurns: OrchestratorTurn[];  // Routing decision history
    
    // Execution Tracking
    executionTime: {
        startTime?: number;                  // Execution start
        endTime?: number;                    // Execution end
        totalExecutionTime?: number;         // Total duration
    };
    
    // Metadata
    metadata: ConversationMetadata;         // Extensible metadata
    
    // Session Management
    readFiles?: string[];                    // Files accessed (cleared on reflection)
}
```

### State Lifecycle

#### 1. Creation
```typescript
async handleNewConversation(initialEvent: NDKEvent): Promise<Conversation> {
    const id = extractConversationId(initialEvent);
    const conversation: Conversation = {
        id,
        title: extractTitle(initialEvent) || generateTitle(),
        phase: PHASES.CHAT,
        history: [initialEvent],
        agentStates: new Map(),
        phaseTransitions: [],
        orchestratorTurns: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {}
    };
    
    this.conversations.set(id, conversation);
    await this.saveConversation(conversation);
    return conversation;
}
```

#### 2. Updates
```typescript
async updateConversation(
    conversationId: string,
    updates: Partial<Conversation>
): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} not found`);
    
    // Apply updates
    Object.assign(conversation, updates, {
        updatedAt: Date.now()
    });
    
    // Persist atomically
    await this.saveConversation(conversation);
}
```

#### 3. Loading
```typescript
private async loadConversation(conversationId: string): Promise<Conversation | null> {
    const filePath = this.getConversationFilePath(conversationId);
    
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        
        // Reconstruct complex types
        const conversation: Conversation = {
            ...parsed,
            agentStates: new Map(parsed.agentStates),
            history: parsed.history.map(reconstructNDKEvent)
        };
        
        return conversation;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}
```

### State Consistency Guarantees

The system provides several consistency guarantees:

1. **Atomic Updates**: All state changes are atomic at the conversation level
2. **Write-Through Cache**: In-memory state always reflects persisted state
3. **Recovery on Crash**: State can be fully recovered from disk
4. **Event Ordering**: History maintains strict chronological order
5. **Phase Integrity**: Invalid phase transitions are prevented

## Message Building and Context

### Agent-Specific Message Construction

The system builds tailored message contexts for each agent based on their processing state:

```typescript
async buildAgentMessages(
    agent: Agent,
    conversation: Conversation,
    triggeringEvent?: NDKEvent
): Promise<Message[]> {
    const messages: Message[] = [];
    const agentState = conversation.agentStates.get(agent.slug) || {
        lastProcessedMessageIndex: 0
    };
    
    // Add historical messages up to last processed
    const historicalMessages = conversation.history
        .slice(0, agentState.lastProcessedMessageIndex);
    
    // Add unprocessed messages with marker
    const unprocessedMessages = conversation.history
        .slice(agentState.lastProcessedMessageIndex);
    
    if (unprocessedMessages.length > 0) {
        messages.push({
            role: 'system',
            content: '=== MESSAGES WHILE YOU WERE AWAY ==='
        });
    }
    
    // Transform messages based on sender
    for (const event of conversation.history) {
        const message = await this.transformEventToMessage(event, agent);
        messages.push(message);
    }
    
    return messages;
}
```

### Message Role Assignment

The system assigns appropriate roles based on the message source:

```typescript
private determineMessageRole(
    event: NDKEvent,
    viewingAgent: Agent
): 'user' | 'assistant' | 'system' {
    const senderPubkey = event.pubkey;
    
    // Messages from the viewing agent
    if (senderPubkey === viewingAgent.pubkey) {
        return 'assistant';
    }
    
    // Messages from users
    if (this.isUserPubkey(senderPubkey)) {
        return 'user';
    }
    
    // Messages from other agents
    return 'system';
}
```

### Context Window Management

The system implements sophisticated context window management:

1. **Incremental Processing**: Agents only see new messages since last execution
2. **Historical Context**: Full history available for reference
3. **Phase Context**: Recent phase transitions included
4. **Handoff Context**: Information from routing decisions
5. **Metadata Preservation**: Referenced articles, voice mode, etc.

### Message Building Pipeline

```
Event Reception
    ↓
Conversation Lookup/Creation
    ↓
Agent State Retrieval
    ↓
Historical Message Assembly
    ↓
Unprocessed Message Marking
    ↓
Role Assignment
    ↓
Content Transformation
    ↓
System Context Injection
    ↓
Final Message Array
```

## Event-Driven Integration

### Nostr Event Processing

The system processes various Nostr event types:

```typescript
async handleEvent(event: NDKEvent): Promise<void> {
    const eventType = this.determineEventType(event);
    
    switch (eventType) {
        case 'user_message':
            await this.handleUserMessage(event);
            break;
        case 'agent_response':
            await this.handleAgentResponse(event);
            break;
        case 'orchestrator_routing':
            await this.handleOrchestratorRouting(event);
            break;
        case 'phase_transition':
            await this.handlePhaseTransition(event);
            break;
        case 'completion':
            await this.handleCompletion(event);
            break;
    }
}
```

### Event Tag Processing

The system extracts rich metadata from Nostr event tags:

```typescript
interface EventMetadata {
    conversationId?: string;      // 'd' tag
    phase?: string;               // 'phase' tag
    replyTo?: string;            // 'e' tag
    mentions?: string[];         // 'p' tags
    tool?: string;              // 'tool' tag
    completion?: object;        // 'complete' tag
    voice?: boolean;           // 'voice' tag
}
```

### Event Ordering and Consistency

The system maintains strict event ordering:

1. **Chronological Order**: Events processed in timestamp order
2. **Causal Consistency**: Reply chains maintained
3. **Atomic Processing**: Each event fully processed before next
4. **Idempotency**: Duplicate events safely ignored

## Persistence Layer

### Storage Architecture

The persistence layer uses a file-based approach optimized for conversation workloads:

```
.tenex/
├── state/
│   └── conversations/
│       ├── conv_abc123.json
│       ├── conv_def456.json
│       └── conv_ghi789.json
├── logs/
│   ├── execution/
│   └── tracing/
└── cache/
    └── mcp_tools.json
```

### Atomic Write Operations

All persistence operations use atomic writes to prevent corruption:

```typescript
private async saveConversation(conversation: Conversation): Promise<void> {
    const filePath = this.getConversationFilePath(conversation.id);
    const tempPath = `${filePath}.tmp`;
    
    // Serialize conversation
    const data = JSON.stringify({
        ...conversation,
        agentStates: Array.from(conversation.agentStates.entries()),
        history: conversation.history.map(serializeNDKEvent)
    }, null, 2);
    
    // Write to temp file
    await fs.writeFile(tempPath, data, 'utf-8');
    
    // Atomic rename
    await fs.rename(tempPath, filePath);
}
```

### Recovery Mechanisms

The system implements multiple recovery strategies:

#### 1. Corrupted File Recovery
```typescript
private async recoverConversation(conversationId: string): Promise<Conversation | null> {
    // Try backup file
    const backupPath = `${this.getConversationFilePath(conversationId)}.bak`;
    if (await this.fileExists(backupPath)) {
        return this.loadConversationFromPath(backupPath);
    }
    
    // Reconstruct from events
    const events = await this.fetchConversationEvents(conversationId);
    if (events.length > 0) {
        return this.reconstructFromEvents(conversationId, events);
    }
    
    return null;
}
```

#### 2. Incomplete Write Recovery
- Detect `.tmp` files on startup
- Validate partial writes
- Complete or rollback transaction

#### 3. State Reconstruction
- Fetch events from Nostr relays
- Rebuild conversation state
- Validate against persisted state

### Performance Optimizations

#### 1. Lazy Loading
Conversations loaded on-demand:
```typescript
async getConversation(id: string): Promise<Conversation | null> {
    // Check memory cache first
    if (this.conversations.has(id)) {
        return this.conversations.get(id);
    }
    
    // Load from disk
    const conversation = await this.loadConversation(id);
    if (conversation) {
        this.conversations.set(id, conversation);
    }
    
    return conversation;
}
```

#### 2. Write Batching
Multiple updates batched:
```typescript
private pendingWrites = new Map<string, Conversation>();
private writeTimer: NodeJS.Timeout;

async scheduleWrite(conversation: Conversation): Promise<void> {
    this.pendingWrites.set(conversation.id, conversation);
    
    if (!this.writeTimer) {
        this.writeTimer = setTimeout(() => this.flushWrites(), 100);
    }
}
```

#### 3. Selective Serialization
Only changed fields persisted:
```typescript
private async saveConversationDelta(
    conversationId: string,
    changes: Partial<Conversation>
): Promise<void> {
    const existing = await this.loadConversation(conversationId);
    const updated = { ...existing, ...changes };
    await this.saveConversation(updated);
}
```

## Phase Management Integration

### Phase Transition Handling

The ConversationCoordinator orchestrates phase transitions:

```typescript
async transitionPhase(
    conversationId: string,
    newPhase: Phase,
    context: PhaseTransitionContext
): Promise<void> {
    const conversation = await this.getConversation(conversationId);
    const oldPhase = conversation.phase;
    
    // Validate transition
    if (!this.isValidTransition(oldPhase, newPhase)) {
        throw new Error(`Invalid transition: ${oldPhase} → ${newPhase}`);
    }
    
    // Record transition
    const transition: PhaseTransition = {
        from: oldPhase,
        to: newPhase,
        timestamp: Date.now(),
        reason: context.reason,
        agentPubkey: context.agentPubkey,
        agentName: context.agentName,
        message: context.message
    };
    
    // Update conversation
    conversation.phase = newPhase;
    conversation.phaseStartedAt = Date.now();
    conversation.phaseTransitions.push(transition);
    
    // Special handling for REFLECTION → CHAT
    if (oldPhase === PHASES.REFLECTION && newPhase === PHASES.CHAT) {
        conversation.readFiles = [];
    }
    
    await this.saveConversation(conversation);
}
```

### Phase-Aware Message Building

Messages include phase context:

```typescript
private addPhaseContext(
    messages: Message[],
    conversation: Conversation
): Message[] {
    const recentTransition = this.getRecentTransition(conversation);
    
    if (recentTransition && this.isRecent(recentTransition)) {
        messages.push({
            role: 'system',
            content: this.formatPhaseTransition(recentTransition)
        });
    }
    
    return messages;
}
```

## Agent State Tracking

### Per-Agent State Management

Each agent maintains independent state within a conversation:

```typescript
interface AgentState {
    lastProcessedMessageIndex: number;  // Last message seen
}

// Session and metadata now handled separately via AgentMetadataStore
const metadataStore = agent.createMetadataStore(conversationId);
metadataStore.set('key', value);
const value = metadataStore.get('key');
```

### State Update Mechanism

```typescript
async updateAgentState(
    conversationId: string,
    agentSlug: string,
    updates: Partial<AgentState>
): Promise<void> {
    const conversation = await this.getConversation(conversationId);
    const currentState = conversation.agentStates.get(agentSlug) || {
        lastProcessedMessageIndex: 0
    };
    
    const newState = { ...currentState, ...updates };
    conversation.agentStates.set(agentSlug, newState);
    
    await this.saveConversation(conversation);
}
```

### Session Continuity

The system maintains session continuity for stateful agents via AgentMetadataStore:

```typescript
// Session management is now decoupled from conversation state
const metadataStore = agent.createMetadataStore(conversationId);

// Get existing session
const existingSessionId = metadataStore.get<string>('claudeSessionId');

// Store new session
if (newSessionId) {
    metadataStore.set('claudeSessionId', newSessionId);
}
```

## Orchestrator Turn Management

### Turn Tracking

The system tracks orchestrator routing decisions:

```typescript
interface OrchestratorTurn {
    turnId: string;                    // Unique turn identifier
    timestamp: number;                 // When turn started
    phase: Phase;                      // Target phase
    agents: string[];                  // Agents to execute
    completions: Completion[];         // Agent completions
    reason?: string;                   // Routing rationale
    isCompleted: boolean;             // All agents done?
}
```

### Turn Lifecycle

#### 1. Turn Creation
```typescript
async startOrchestratorTurn(
    conversationId: string,
    routing: RoutingDecision
): Promise<string> {
    const turnId = generateTurnId();
    const turn: OrchestratorTurn = {
        turnId,
        timestamp: Date.now(),
        phase: routing.phase || this.getCurrentPhase(conversationId),
        agents: routing.agents,
        completions: [],
        reason: routing.reason,
        isCompleted: false
    };
    
    const conversation = await this.getConversation(conversationId);
    conversation.orchestratorTurns.push(turn);
    await this.saveConversation(conversation);
    
    return turnId;
}
```

#### 2. Completion Tracking
```typescript
async addCompletionToTurn(
    conversationId: string,
    agentSlug: string,
    completion: CompletionInfo
): Promise<void> {
    const conversation = await this.getConversation(conversationId);
    const currentTurn = this.getCurrentTurn(conversation);
    
    if (!currentTurn) {
        throw new Error('No active orchestrator turn');
    }
    
    // Add completion
    currentTurn.completions.push({
        agentSlug,
        timestamp: Date.now(),
        summary: completion.summary,
        metadata: completion.metadata
    });
    
    // Check if turn is complete
    const expectedAgents = new Set(currentTurn.agents);
    const completedAgents = new Set(
        currentTurn.completions.map(c => c.agentSlug)
    );
    
    if (expectedAgents.size === completedAgents.size) {
        currentTurn.isCompleted = true;
    }
    
    await this.saveConversation(conversation);
}
```

### Turn-Based Routing Context

The system provides routing context based on turn history:

```typescript
private buildRoutingContext(conversation: Conversation): RoutingContext {
    const turns = conversation.orchestratorTurns;
    // Build a human-readable narrative of the workflow
    const narrative = buildWorkflowNarrative(turns);
    
    return {
        user_request: originalRequest,
        workflow_narrative: narrative
    };
}
```

## Recovery and Resilience

### Crash Recovery

The system implements comprehensive crash recovery:

```typescript
async recoverFromCrash(): Promise<void> {
    // 1. Detect incomplete writes
    const tempFiles = await this.findTempFiles();
    for (const tempFile of tempFiles) {
        await this.recoverTempFile(tempFile);
    }
    
    // 2. Validate persisted state
    const conversationFiles = await this.listConversationFiles();
    for (const file of conversationFiles) {
        await this.validateAndRepair(file);
    }
    
    // 3. Sync with Nostr events
    await this.syncWithNostr();
    
    // 4. Resume incomplete turns
    for (const [id, conversation] of this.conversations) {
        await this.resumeIncompleteTurns(conversation);
    }
}
```

### Error Boundaries

Multiple error boundaries prevent cascading failures:

```typescript
async safeExecute<T>(
    operation: () => Promise<T>,
    fallback: T,
    context: string
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        this.logger.error(`Error in ${context}:`, error);
        
        // Report to monitoring
        this.reportError(error, context);
        
        // Return fallback
        return fallback;
    }
}
```

### State Validation

Continuous state validation ensures consistency:

```typescript
private validateConversationState(conversation: Conversation): ValidationResult {
    const issues: string[] = [];
    
    // Check phase validity
    if (!Object.values(PHASES).includes(conversation.phase)) {
        issues.push(`Invalid phase: ${conversation.phase}`);
    }
    
    // Check history ordering
    for (let i = 1; i < conversation.history.length; i++) {
        if (conversation.history[i].created_at < conversation.history[i-1].created_at) {
            issues.push('History not in chronological order');
        }
    }
    
    // Check agent states
    for (const [agent, state] of conversation.agentStates) {
        if (state.lastProcessedMessageIndex > conversation.history.length) {
            issues.push(`Agent ${agent} has invalid message index`);
        }
    }
    
    return { valid: issues.length === 0, issues };
}
```

## Performance Optimizations

### Memory Management

#### 1. Conversation Cache Eviction
```typescript
private async evictOldConversations(): Promise<void> {
    const maxCacheSize = 100;
    const maxAge = 3600000; // 1 hour
    
    if (this.conversations.size > maxCacheSize) {
        const sorted = Array.from(this.conversations.entries())
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
        
        // Keep most recent
        const toKeep = sorted.slice(0, maxCacheSize / 2);
        this.conversations = new Map(toKeep);
    }
}
```

#### 2. History Truncation
```typescript
private truncateHistory(
    history: NDKEvent[],
    maxSize: number = 1000
): NDKEvent[] {
    if (history.length <= maxSize) return history;
    
    // Keep first and last messages
    const keep = Math.floor(maxSize / 2);
    return [
        ...history.slice(0, keep),
        ...history.slice(-keep)
    ];
}
```

### Query Optimization

#### 1. Indexed Lookups
```typescript
private buildIndices(): void {
    this.conversationsByPhase = new Map();
    this.conversationsByAgent = new Map();
    
    for (const [id, conv] of this.conversations) {
        // Index by phase
        if (!this.conversationsByPhase.has(conv.phase)) {
            this.conversationsByPhase.set(conv.phase, new Set());
        }
        this.conversationsByPhase.get(conv.phase).add(id);
        
        // Index by agent
        for (const agent of conv.agentStates.keys()) {
            if (!this.conversationsByAgent.has(agent)) {
                this.conversationsByAgent.set(agent, new Set());
            }
            this.conversationsByAgent.get(agent).add(id);
        }
    }
}
```

#### 2. Batch Operations
```typescript
async processEventBatch(events: NDKEvent[]): Promise<void> {
    // Group by conversation
    const byConversation = new Map<string, NDKEvent[]>();
    for (const event of events) {
        const convId = this.extractConversationId(event);
        if (!byConversation.has(convId)) {
            byConversation.set(convId, []);
        }
        byConversation.get(convId).push(event);
    }
    
    // Process in parallel
    await Promise.all(
        Array.from(byConversation.entries()).map(([id, events]) =>
            this.processConversationEvents(id, events)
        )
    );
}
```

### Caching Strategies

#### 1. Message Template Caching
```typescript
private messageTemplateCache = new Map<string, Message>();

private getCachedMessage(event: NDKEvent, agent: Agent): Message {
    const key = `${event.id}:${agent.slug}`;
    
    if (!this.messageTemplateCache.has(key)) {
        const message = this.transformEventToMessage(event, agent);
        this.messageTemplateCache.set(key, message);
    }
    
    return this.messageTemplateCache.get(key);
}
```

#### 2. Routing Context Caching
```typescript
private routingContextCache = new Map<string, {
    context: RoutingContext;
    timestamp: number;
}>();

private getCachedRoutingContext(conversationId: string): RoutingContext | null {
    const cached = this.routingContextCache.get(conversationId);
    if (!cached) return null;
    
    // Check age (5 seconds)
    if (Date.now() - cached.timestamp > 5000) {
        this.routingContextCache.delete(conversationId);
        return null;
    }
    
    return cached.context;
}
```

## Questions and Uncertainties

### Architectural Questions

1. **Event Ordering Guarantees**: How does the system handle out-of-order events from distributed Nostr relays?

2. **Conversation Merging**: Can conversations be merged if they're discovered to be duplicates?

3. **Multi-User Conversations**: How does the system handle conversations with multiple human participants?

4. **Conversation Forking**: Can conversations branch into parallel threads?

5. **Cross-Conversation Context**: How do agents access learnings from other conversations?

### Implementation Questions

6. **Memory Limits**: What happens when conversation history exceeds available memory?

7. **Persistence Format Evolution**: How are schema migrations handled for persisted conversations?

8. **Relay Synchronization**: How does the system handle conflicting events from different relays?

9. **Agent State Conflicts**: What happens when multiple agents update state simultaneously?

10. **Session Recovery**: How are Claude sessions recovered after system restart?

### Performance Questions

11. **Large History Performance**: How does message building scale with very long conversations?

12. **Concurrent Access**: How does the system handle multiple agents accessing the same conversation?

13. **Write Amplification**: Could frequent small updates cause excessive disk I/O?

14. **Cache Invalidation**: When should cached routing contexts be invalidated?

15. **Index Maintenance**: What's the cost of maintaining multiple indices?

### Behavioral Questions

16. **Phase Rollback**: Should the system support rolling back to previous phases on error?

17. **Turn Timeout**: Should orchestrator turns have timeouts?

18. **Partial Completions**: How should partially completed turns be handled?

19. **Agent Failure**: What happens when an agent fails mid-conversation?

20. **Conversation Archival**: When and how should old conversations be archived?

### Future Considerations

21. **Distributed State**: Could conversation state be distributed across multiple nodes?

22. **Real-time Collaboration**: Could multiple orchestrators work on the same conversation?

23. **Conversation Templates**: Should the system support conversation templates?

24. **State Versioning**: Should conversation state be versioned for rollback?

25. **External Storage**: Could large conversations use external storage (S3, etc.)?