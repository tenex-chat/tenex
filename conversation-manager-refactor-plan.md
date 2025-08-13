# ConversationManager Refactoring Plan

## Executive Summary
ConversationManager is a 1,034-line god object handling 12+ distinct responsibilities. This refactoring breaks it into 7 focused services following Single Responsibility Principle, improving maintainability, testability, and comprehension.

**Status**: Planning Phase  
**Created**: 2025-01-13  
**Priority**: High - Core architectural improvement

## Current Problems
- **1,034 lines** handling too many concerns
- **Difficult to test** - can't test phase management without persistence
- **Hard to modify** - changes risk breaking unrelated features
- **Poor separation** - business logic mixed with infrastructure
- **Cognitive overload** - too much to understand at once

## Proposed Architecture

### Core Services

#### 1. ConversationStore (Data Layer)
**Responsibility**: In-memory storage and retrieval of conversations
```typescript
interface ConversationStore {
  get(id: string): Conversation | undefined
  set(id: string, conversation: Conversation): void
  delete(id: string): void
  getAll(): Conversation[]
  findByEvent(eventId: string): Conversation | undefined
  exists(id: string): boolean
}
```

#### 2. ConversationPersistenceService (Infrastructure)
**Responsibility**: Persistence operations only
```typescript
interface ConversationPersistenceService {
  save(conversation: Conversation): Promise<void>
  load(id: string): Promise<Conversation | null>
  loadAll(): Promise<Conversation[]>
  archive(id: string): Promise<void>
  search(criteria: SearchCriteria): Promise<Conversation[]>
}
```

#### 3. PhaseManager (Business Logic)
**Responsibility**: Phase transitions and validation
```typescript
interface PhaseManager {
  canTransition(from: Phase, to: Phase): boolean
  transition(conversation: Conversation, to: Phase, context: TransitionContext): Promise<PhaseTransition>
  getCurrentPhaseRules(phase: Phase): PhaseRules
  validatePhaseRequirements(conversation: Conversation, phase: Phase): ValidationResult
}
```

#### 4. ConversationEventProcessor (Business Logic)
**Responsibility**: Processing and adding events to conversations
```typescript
interface ConversationEventProcessor {
  processIncomingEvent(conversation: Conversation, event: NDKEvent): Promise<void>
  createConversationFromEvent(event: NDKEvent): Promise<Conversation>
  extractMetadataFromEvent(event: NDKEvent): ConversationMetadata
  updateConversationSummary(conversation: Conversation, event: NDKEvent): void
}
```

#### 5. AgentContextBuilder (Business Logic)
**Responsibility**: Building message contexts for agents
```typescript
interface AgentContextBuilder {
  buildContext(conversation: Conversation, agent: AgentInstance, trigger?: NDKEvent): Promise<AgentContext>
  buildOrchestratorContext(conversation: Conversation, trigger?: NDKEvent): Promise<OrchestratorRoutingContext>
  handleDelegationResponses(conversation: Conversation, agent: string, response: NDKEvent): Promise<DelegationResult>
}
```

#### 6. OrchestratorTurnTracker (Business Logic)
**Responsibility**: Managing orchestrator routing decisions
```typescript
interface OrchestratorTurnTracker {
  startTurn(conversationId: string, phase: Phase, agents: string[], reason?: string): string
  addCompletion(conversationId: string, agent: string, message: string): void
  isCurrentTurnComplete(conversationId: string): boolean
  getCurrentTurn(conversationId: string): OrchestratorTurn | null
  getRoutingHistory(conversationId: string): RoutingEntry[]
}
```

#### 7. ConversationCoordinator (Orchestration Layer)
**Responsibility**: Coordinating between services (thin layer)
```typescript
class ConversationCoordinator {
  constructor(
    private store: ConversationStore,
    private persistence: ConversationPersistenceService,
    private phaseManager: PhaseManager,
    private eventProcessor: ConversationEventProcessor,
    private contextBuilder: AgentContextBuilder,
    private turnTracker: OrchestratorTurnTracker,
    private queueManager?: ExecutionQueueManager
  ) {}

  // Thin orchestration methods that delegate to appropriate services
  async createConversation(event: NDKEvent): Promise<Conversation>
  async updatePhase(id: string, phase: Phase, context: TransitionContext): Promise<boolean>
  async buildAgentMessages(id: string, agent: AgentInstance, trigger?: NDKEvent): Promise<AgentMessages>
}
```

## Data Flow

```
User Event → ConversationCoordinator
              ├→ EventProcessor (process event)
              ├→ Store (update in-memory)
              ├→ PhaseManager (if phase change)
              ├→ TurnTracker (if orchestrator routing)
              ├→ ContextBuilder (when agent needs context)
              └→ PersistenceService (save to disk)
```

## Migration Strategy

### Phase 1: Extract Pure Services (Week 1)
1. **ConversationStore** - Simple in-memory Map wrapper
2. **OrchestratorTurnTracker** - Extract turn management logic
3. **ConversationEventProcessor** - Extract event processing

### Phase 2: Extract Complex Services (Week 2)
4. **PhaseManager** - Extract phase logic with queue integration
5. **AgentContextBuilder** - Extract context building (uses existing AgentConversationContext)
6. **ConversationPersistenceService** - Wrap existing FileSystemAdapter

### Phase 3: Create Coordinator (Week 3)
7. **ConversationCoordinator** - Thin orchestration layer
8. Update all callers to use coordinator instead of ConversationManager
9. Keep ConversationManager as deprecated facade during transition

### Phase 4: Cleanup (Week 4)
10. Remove old ConversationManager
11. Update tests to test services independently
12. Performance optimization and monitoring

## Benefits

### Immediate
- **Testability**: Each service can be tested in isolation
- **Comprehension**: Each file ~150-200 lines focused on one thing
- **Maintainability**: Changes isolated to relevant service

### Long-term
- **Reusability**: Services can be used independently
- **Performance**: Can optimize each service separately (e.g., caching in Store)
- **Scalability**: Can distribute services if needed
- **Team velocity**: Developers can work on different services without conflicts

## Example: Phase Transition (Before vs After)

### Before (ConversationManager - mixed concerns)
```typescript
async updatePhase(id: string, phase: Phase, message: string, agentPubkey: string, agentName: string, reason?: string): Promise<boolean> {
  // 150+ lines mixing:
  // - Conversation retrieval
  // - Queue management
  // - Tracing/logging
  // - Phase validation
  // - State updates
  // - Persistence
  // - Event notifications
}
```

### After (Clean separation)
```typescript
// ConversationCoordinator
async updatePhase(id: string, phase: Phase, context: TransitionContext): Promise<boolean> {
  const conversation = this.store.get(id);
  if (!conversation) throw new Error(`Conversation ${id} not found`);
  
  const transition = await this.phaseManager.transition(conversation, phase, context);
  if (!transition.success) return false;
  
  conversation.phase = phase;
  conversation.phaseTransitions.push(transition);
  
  await this.persistence.save(conversation);
  return true;
}

// PhaseManager (focused on phase logic only)
async transition(conversation: Conversation, to: Phase, context: TransitionContext): Promise<PhaseTransition> {
  if (!this.canTransition(conversation.phase, to)) {
    return { success: false, reason: "Invalid transition" };
  }
  
  if (to === PHASES.EXECUTE && this.queueManager) {
    const permission = await this.queueManager.requestExecution(conversation.id, context.agentPubkey);
    if (!permission.granted) {
      return { success: false, queued: true, queuePosition: permission.queuePosition };
    }
  }
  
  return {
    success: true,
    from: conversation.phase,
    to: to,
    timestamp: Date.now(),
    ...context
  };
}
```

## Testing Strategy

### Unit Tests (per service)
```typescript
describe('PhaseManager', () => {
  it('should validate phase transitions', () => {
    const manager = new PhaseManager();
    expect(manager.canTransition(PHASES.CHAT, PHASES.PLAN)).toBe(true);
    expect(manager.canTransition(PHASES.EXECUTE, PHASES.PLAN)).toBe(false);
  });
  
  it('should queue EXECUTE phase requests', async () => {
    const mockQueue = createMockQueueManager();
    const manager = new PhaseManager(mockQueue);
    // Test queue integration in isolation
  });
});
```

### Integration Tests
```typescript
describe('ConversationCoordinator', () => {
  it('should coordinate phase transition', async () => {
    const coordinator = createTestCoordinator();
    const conversation = await coordinator.createConversation(testEvent);
    const result = await coordinator.updatePhase(conversation.id, PHASES.PLAN, context);
    expect(result).toBe(true);
    // Verify all services were called correctly
  });
});
```

## Risk Mitigation

1. **Backwards Compatibility**: Keep ConversationManager as facade initially
2. **Incremental Migration**: Extract one service at a time
3. **Feature Flags**: Can toggle between old/new implementation
4. **Extensive Testing**: Each extraction includes comprehensive tests
5. **Monitoring**: Add metrics to track service performance

## Success Metrics

- **Code Coverage**: Each service >90% tested
- **File Size**: No service >300 lines
- **Cyclomatic Complexity**: Reduced by 60%
- **Team Velocity**: 30% faster feature development after refactor
- **Bug Rate**: 50% reduction in conversation-related bugs

## Next Steps

1. Review and approve this plan
2. Create feature branch `refactor/conversation-manager`
3. Begin Phase 1 extractions
4. Daily progress updates
5. Code review after each service extraction