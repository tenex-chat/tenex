# AgentExecutor Refactoring Proposal

## Executive Summary
The AgentExecutor.ts file contains 1068 lines with significant duplication and mixing of concerns. This proposal outlines a refactoring strategy to reduce the file to ~400 lines while improving maintainability, testability, and clarity.

## Key Problems Identified

### 1. Repeated EventContext Creation (8 occurrences)
- Lines: 381-387, 415-421, 463-468, 569-575, 637, 794, 875, and implicit in other locations
- Same pattern repeated with slight variations

### 2. Duplicated Error Handling Logic (3 major blocks)
- Lines 412-452: Main error handler
- Lines 775-806: Stream error handler
- Lines 844-888: Catch block error handler
- 90% identical code with minor message variations

### 3. Buffer Management Duplication
- Content buffer: Lines 577-598
- Reasoning buffer: Lines 600-613
- Non-streaming buffers: Lines 622-648
- Same flush pattern repeated

### 4. Tool Execution State Management
- Lines 53-89: Complex discriminated union
- Lines 186-296: Verbose state transitions
- Could be simplified with a state machine

### 5. Session Management Scattered
- Lines 516-538: Session ID retrieval
- Lines 145-181: Event filtering
- Lines 748-758: Session persistence
- Lines 809-820: Session capture

## Proposed Solution Architecture

### 1. EventContextBuilder Class
```typescript
class EventContextBuilder {
  private baseContext: Partial<EventContext> = {};

  constructor(private context: ExecutionContext) {
    this.baseContext = {
      conversationId: context.conversationId,
      model: context.agent.llmConfig
    };
  }

  withTriggeringEvent(event: NDKEvent): this {
    this.baseContext.triggeringEvent = event;
    return this;
  }

  withRootEvent(event: NDKEvent): this {
    this.baseContext.rootEvent = event;
    return this;
  }

  withPhase(phase?: string): this {
    if (phase) this.baseContext.phase = phase;
    return this;
  }

  build(): EventContext {
    const conversation = this.context.conversationCoordinator.getConversation(
      this.context.conversationId
    );

    return {
      triggeringEvent: this.baseContext.triggeringEvent || this.context.triggeringEvent,
      rootEvent: this.baseContext.rootEvent || conversation?.history[0] || this.context.triggeringEvent,
      conversationId: this.context.conversationId,
      model: this.baseContext.model,
      phase: this.baseContext.phase
    };
  }
}
```

### 2. ErrorPublisher Utility
```typescript
class ErrorPublisher {
  constructor(
    private agentPublisher: AgentPublisher,
    private eventContextBuilder: EventContextBuilder
  ) {}

  async publishError(error: unknown, context: string): Promise<void> {
    const errorInfo = this.parseError(error);
    const eventContext = this.eventContextBuilder.build();

    try {
      await this.agentPublisher.error({
        message: errorInfo.message,
        errorType: errorInfo.type
      }, eventContext);

      logger.info(`${context} error published`, {
        errorType: errorInfo.type
      });
    } catch (publishError) {
      logger.error(`Failed to publish ${context} error`, {
        error: formatAnyError(publishError)
      });
    }
  }

  private parseError(error: unknown): { message: string; type: string } {
    let message = "An error occurred while processing your request.";
    let type = "system";

    if (error instanceof Error) {
      const errorStr = error.toString();
      if (this.isAIAPIError(errorStr)) {
        type = "ai_api";
        message = this.formatAIError(error, errorStr);
      } else {
        message = `Error: ${error.message}`;
      }
    }

    return { message, type };
  }

  private isAIAPIError(errorStr: string): boolean {
    return errorStr.includes("AI_APICallError") ||
           errorStr.includes("Provider returned error") ||
           errorStr.includes("422") ||
           errorStr.includes("openrouter");
  }

  private formatAIError(error: Error, errorStr: string): string {
    const providerMatch = errorStr.match(/provider_name":"([^"]+)"/);
    const provider = providerMatch ? providerMatch[1] : "AI provider";
    let message = `Failed to process request with ${provider}. The AI service returned an error.`;

    const rawMatch = errorStr.match(/raw":"([^"]+)"/);
    if (rawMatch) {
      message += ` Details: ${rawMatch[1]}`;
    }

    return message;
  }
}
```

### 3. BufferManager Class
```typescript
class BufferManager {
  private contentBuffer = '';
  private reasoningBuffer = '';
  private pendingContent = '';
  private pendingReasoning = '';
  private publishTimeout: NodeJS.Timeout | null = null;

  constructor(
    private agentPublisher: AgentPublisher,
    private eventContext: EventContext,
    private supportsStreaming: boolean
  ) {}

  async handleContent(delta: string): Promise<void> {
    this.contentBuffer += delta;

    if (this.supportsStreaming) {
      await this.agentPublisher.publishStreamingDelta(delta, this.eventContext, false);
    } else {
      this.pendingContent += delta;
      this.schedulePublish();
    }
  }

  async handleReasoning(delta: string): Promise<void> {
    this.reasoningBuffer += delta;

    if (this.supportsStreaming) {
      await this.agentPublisher.publishStreamingDelta(delta, this.eventContext, true);
    } else {
      this.pendingReasoning += delta;
      this.schedulePublish();
    }
  }

  async flushAll(): Promise<void> {
    await this.flushContent();
    await this.flushReasoning();
  }

  private async flushContent(): Promise<void> {
    if (this.contentBuffer.trim().length > 0) {
      await this.agentPublisher.conversation({
        content: this.contentBuffer
      }, this.eventContext);

      logger.info(`[BufferManager] Flushed content (${this.contentBuffer.length} chars)`);
      this.contentBuffer = '';
    }
  }

  private async flushReasoning(): Promise<void> {
    if (this.reasoningBuffer.trim().length > 0) {
      await this.agentPublisher.conversation({
        content: this.reasoningBuffer,
        isReasoning: true
      }, this.eventContext);

      logger.info(`[BufferManager] Flushed reasoning (${this.reasoningBuffer.length} chars)`);
      this.reasoningBuffer = '';
    }
  }

  private schedulePublish(): void {
    if (this.publishTimeout) {
      clearTimeout(this.publishTimeout);
    }

    this.publishTimeout = setTimeout(async () => {
      if (this.pendingReasoning) {
        await this.agentPublisher.conversation({
          content: this.pendingReasoning,
          isReasoning: true
        }, this.eventContext);
        this.pendingReasoning = '';
      }

      if (this.pendingContent) {
        await this.agentPublisher.conversation({
          content: this.pendingContent
        }, this.eventContext);
        this.pendingContent = '';
      }

      this.publishTimeout = null;
    }, 500);
  }

  getBufferStates(): { hadContent: boolean; hadReasoning: boolean } {
    return {
      hadContent: this.contentBuffer.trim().length > 0,
      hadReasoning: this.reasoningBuffer.trim().length > 0
    };
  }

  clearBuffers(): void {
    this.contentBuffer = '';
    this.reasoningBuffer = '';
    this.pendingContent = '';
    this.pendingReasoning = '';
    if (this.publishTimeout) {
      clearTimeout(this.publishTimeout);
      this.publishTimeout = null;
    }
  }
}
```

### 4. SessionManager Class
```typescript
class SessionManager {
  private metadataStore: any;

  constructor(
    private agent: AgentInstance,
    private conversationId: string
  ) {
    this.metadataStore = agent.createMetadataStore(conversationId);
  }

  getSessionInfo(): { sessionId?: string; lastSentEventId?: string } {
    const sessionId = this.metadataStore.get<string>('sessionId');
    const lastSentEventId = this.metadataStore.get<string>('lastSentEventId');

    if (sessionId) {
      logger.info("[SessionManager] Found existing session", {
        sessionId,
        lastSentEventId: lastSentEventId || 'NONE'
      });
    }

    return { sessionId, lastSentEventId };
  }

  saveSession(sessionId: string, lastSentEventId: string): void {
    this.metadataStore.set('sessionId', sessionId);
    this.metadataStore.set('lastSentEventId', lastSentEventId);

    logger.info("[SessionManager] Saved session info", {
      sessionId,
      lastSentEventId: lastSentEventId.substring(0, 8)
    });
  }

  createEventFilter(lastSentEventId?: string): ((event: NDKEvent) => boolean) | undefined {
    if (!lastSentEventId) return undefined;

    let foundLastSent = false;
    return (event: NDKEvent) => {
      if (!foundLastSent) {
        if (event.id === lastSentEventId) {
          foundLastSent = true;
          logger.debug("[SessionManager] Found last sent event", {
            eventId: event.id.substring(0, 8)
          });
          return false;
        }
        return false;
      }
      return true;
    };
  }
}
```

### 5. ToolExecutionTracker Class
```typescript
class ToolExecutionTracker {
  private executions = new Map<string, {
    toolName: string;
    toolEventId: string;
    input: unknown;
    output?: unknown;
    error?: boolean;
    completed: boolean;
  }>();

  async trackExecution(
    toolCallId: string,
    toolName: string,
    args: unknown,
    toolsObject: Record<string, CoreTool>,
    agentPublisher: AgentPublisher,
    eventContext: EventContext
  ): Promise<void> {
    const humanContent = this.getHumanReadableContent(toolName, args, toolsObject);

    const toolEvent = await agentPublisher.toolUse({
      toolName,
      content: humanContent,
      args
    }, eventContext);

    this.executions.set(toolCallId, {
      toolName,
      toolEventId: toolEvent.id,
      input: args,
      completed: false
    });

    logger.debug("[ToolExecutionTracker] Tracked new execution", {
      toolCallId,
      toolName
    });
  }

  async completeExecution(
    toolCallId: string,
    result: unknown,
    error: boolean,
    agentPubkey: string
  ): Promise<void> {
    const execution = this.executions.get(toolCallId);
    if (!execution) {
      logger.warn("[ToolExecutionTracker] Unknown tool call", { toolCallId });
      return;
    }

    execution.output = result;
    execution.error = error;
    execution.completed = true;

    await toolMessageStorage.store(
      execution.toolEventId,
      {
        toolCallId,
        toolName: execution.toolName,
        input: execution.input
      },
      {
        toolCallId,
        toolName: execution.toolName,
        output: result,
        error
      },
      agentPubkey
    );
  }

  private getHumanReadableContent(
    toolName: string,
    args: unknown,
    toolsObject: Record<string, CoreTool>
  ): string {
    const tool = toolsObject[toolName];
    return tool?.getHumanReadableContent?.(args) ||
           (toolName.startsWith('mcp__')
             ? `Executing ${formatMCPToolName(toolName)}`
             : `Executing ${toolName}`);
  }
}
```

### 6. StreamingHandler Class
```typescript
class StreamingHandler {
  private bufferManager: BufferManager;
  private errorPublisher: ErrorPublisher;
  private toolTracker: ToolExecutionTracker;
  private finalResponseEvent?: NDKEvent;

  constructor(
    private llmService: LLMService,
    private agentPublisher: AgentPublisher,
    private eventContext: EventContext,
    private supportsStreaming: boolean
  ) {
    this.bufferManager = new BufferManager(agentPublisher, eventContext, supportsStreaming);
    this.errorPublisher = new ErrorPublisher(agentPublisher, new EventContextBuilder(/* context */));
    this.toolTracker = new ToolExecutionTracker();
  }

  setupEventHandlers(
    context: ExecutionContext,
    toolsObject: Record<string, CoreTool>
  ): void {
    this.llmService.on('content', (event) => this.bufferManager.handleContent(event.delta));
    this.llmService.on('reasoning', (event) => this.bufferManager.handleReasoning(event.delta));
    this.llmService.on('chunk-type-change', () => this.bufferManager.flushAll());

    this.llmService.on('complete', async (event) => {
      await this.handleComplete(event);
    });

    this.llmService.on('stream-error', async (event) => {
      await this.errorPublisher.publishError(event.error, 'Stream');
    });

    this.llmService.on('tool-will-execute', async (event) => {
      await this.toolTracker.trackExecution(
        event.toolCallId,
        event.toolName,
        event.args,
        toolsObject,
        this.agentPublisher,
        this.eventContext
      );
    });

    this.llmService.on('tool-did-execute', async (event) => {
      await this.toolTracker.completeExecution(
        event.toolCallId,
        event.result,
        event.error ?? false,
        context.agent.pubkey
      );
    });
  }

  private async handleComplete(event: any): Promise<void> {
    if (this.supportsStreaming) {
      await this.agentPublisher.forceFlushStreamingBuffers();
    }

    this.bufferManager.clearBuffers();

    if (event.message.trim()) {
      const { hadContent, hadReasoning } = this.bufferManager.getBufferStates();
      const isReasoning = hadReasoning && !hadContent;

      const publishedEvent = await this.agentPublisher.complete({
        content: event.message,
        usage: event.usage,
        isReasoning
      }, this.eventContext);

      if (!isReasoning) {
        this.finalResponseEvent = publishedEvent;
      }
    }
  }

  async stream(
    messages: ModelMessage[],
    toolsObject: Record<string, CoreTool>,
    abortSignal: AbortSignal
  ): Promise<NDKEvent | undefined> {
    try {
      await this.llmService.stream(messages, toolsObject, { abortSignal });
    } catch (error) {
      await this.errorPublisher.publishError(error, 'Stream execution');
      throw error;
    } finally {
      this.llmService.removeAllListeners();
    }

    return this.finalResponseEvent;
  }
}
```

## Refactored AgentExecutor Class

```typescript
export class AgentExecutor {
  private messageStrategy: MessageGenerationStrategy;

  constructor(
    private standaloneContext?: StandaloneAgentContext,
    messageStrategy?: MessageGenerationStrategy
  ) {
    this.messageStrategy = messageStrategy || new ThreadWithMemoryStrategy();
  }

  async execute(context: ExecutionContext): Promise<NDKEvent | undefined> {
    const agentPublisher = new AgentPublisher(context.agent);
    const contextBuilder = new EventContextBuilder(context);
    const errorPublisher = new ErrorPublisher(agentPublisher, contextBuilder);

    const fullContext: ExecutionContext = {
      ...context,
      agentPublisher
    };

    try {
      const conversation = this.getConversation(context);
      startExecutionTime(conversation);

      const phaseContext = this.extractPhaseContext(context.triggeringEvent);
      const eventContext = contextBuilder
        .withPhase(phaseContext?.phase)
        .build();

      await agentPublisher.typing({ state: "start" }, eventContext);

      const responseEvent = await this.executeWithStreaming(fullContext, eventContext);

      logger.info(`Agent ${context.agent.name} completed`, {
        eventId: responseEvent?.id
      });

      return responseEvent;

    } catch (error) {
      await errorPublisher.publishError(error, 'Execution');
      throw error;
    } finally {
      await this.cleanup(context, agentPublisher, contextBuilder);
    }
  }

  private async executeWithStreaming(
    context: ExecutionContext,
    eventContext: EventContext
  ): Promise<NDKEvent | undefined> {
    const toolNames = context.agent.tools || [];
    const toolsObject = toolNames.length > 0 ? getToolsObject(toolNames, context) : {};

    const sessionManager = new SessionManager(context.agent, context.conversationId);
    const { sessionId, lastSentEventId } = sessionManager.getSessionInfo();

    const eventFilter = sessionManager.createEventFilter(lastSentEventId);
    const messages = await this.messageStrategy.buildMessages(
      context,
      context.triggeringEvent,
      eventFilter
    );

    const llmService = this.initializeLLMService(context, toolsObject, sessionId);
    const supportsStreaming = this.checkStreamingSupport(llmService);

    const streamingHandler = new StreamingHandler(
      llmService,
      context.agentPublisher,
      eventContext,
      supportsStreaming
    );

    streamingHandler.setupEventHandlers(context, toolsObject);

    llmService.on('session-captured', ({ sessionId }) => {
      sessionManager.saveSession(sessionId, context.triggeringEvent.id);
    });

    const abortSignal = llmOpsRegistry.registerOperation(context);

    try {
      return await streamingHandler.stream(messages, toolsObject, abortSignal);
    } finally {
      llmOpsRegistry.completeOperation(context);
    }
  }

  private async cleanup(
    context: ExecutionContext,
    agentPublisher: AgentPublisher,
    contextBuilder: EventContextBuilder
  ): Promise<void> {
    const conversation = this.getConversation(context);
    if (conversation) stopExecutionTime(conversation);

    try {
      const eventContext = contextBuilder.build();
      await agentPublisher.typing({ state: "stop" }, eventContext);
    } catch (error) {
      logger.warn("Failed to stop typing indicator", {
        error: formatAnyError(error)
      });
    }
  }

  private getConversation(context: ExecutionContext) {
    const conversation = context.conversationCoordinator.getConversation(
      context.conversationId
    );
    if (!conversation) {
      throw new Error(`Conversation ${context.conversationId} not found`);
    }
    return conversation;
  }

  private checkStreamingSupport(llmService: LLMService): boolean {
    return this.isAISdkProvider(llmService.provider)
      ? providerSupportsStreaming(llmService.provider)
      : true;
  }

  // ... Other simplified methods
}
```

## Benefits of Refactoring

### 1. **Code Reduction**: ~60% reduction in code size (from 1068 to ~400 lines)

### 2. **Improved Testability**:
- Each class can be unit tested independently
- Mock dependencies easily
- Test edge cases in isolation

### 3. **Better Separation of Concerns**:
- Event context management separate from execution
- Error handling centralized
- Buffer management abstracted
- Session management isolated
- Tool tracking independent

### 4. **Easier Maintenance**:
- Single responsibility for each class
- Clear interfaces between components
- Reduced cognitive load per file

### 5. **Enhanced Reusability**:
- Components can be reused in other agents
- Standardized patterns across the codebase

### 6. **Better Error Handling**:
- Consistent error messages
- Centralized error parsing
- Easier to add new error types

## Implementation Plan

### Phase 1: Create Supporting Classes (Week 1)
1. Implement EventContextBuilder
2. Implement ErrorPublisher
3. Implement BufferManager
4. Write unit tests for each

### Phase 2: Extract Complex Logic (Week 2)
1. Implement SessionManager
2. Implement ToolExecutionTracker
3. Implement StreamingHandler
4. Write integration tests

### Phase 3: Refactor AgentExecutor (Week 3)
1. Update AgentExecutor to use new classes
2. Remove duplicated code
3. Update all references
4. Run comprehensive tests

### Phase 4: Documentation & Cleanup (Week 4)
1. Update documentation
2. Add JSDoc comments
3. Performance testing
4. Final code review

## Testing Strategy

### Unit Tests
- Test each class in isolation
- Mock all dependencies
- Cover edge cases and error scenarios

### Integration Tests
- Test component interactions
- Verify event flow
- Test with different LLM providers

### E2E Tests
- Full agent execution flow
- Session resumption scenarios
- Error recovery testing

## Risk Mitigation

1. **Gradual Migration**: Implement new classes alongside existing code
2. **Feature Flags**: Use flags to switch between old and new implementations
3. **Comprehensive Testing**: Ensure 100% test coverage before switching
4. **Rollback Plan**: Keep old code available for quick rollback if needed

## Metrics for Success

- **Code Coverage**: >95% test coverage
- **Performance**: No degradation in execution time
- **Maintainability**: Reduced cyclomatic complexity
- **Developer Experience**: Faster onboarding for new developers
- **Bug Rate**: 50% reduction in bug reports related to agent execution

## Conclusion

This refactoring will transform AgentExecutor from a monolithic 1000+ line class into a well-architected system of focused, testable components. The investment in this refactoring will pay dividends in reduced maintenance costs, fewer bugs, and faster feature development.