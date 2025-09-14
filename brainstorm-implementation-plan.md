# Implementation Plan: Ad-Hoc Brainstorming Mode

## Overview
This plan implements brainstorming functionality using an **Ad-Hoc Broadcast Model** where:
- A user's `kind:1` event with `["mode", "brainstorm"]` tag initiates the workflow
- Multiple agents generate `kind:1110` draft replies
- A designated moderator agent collects and selects the best reply
- The winning reply is promoted as a `kind:1111` event from the moderator

## Core Architecture Decisions

### Why No Session Event (kind:31110)
- **Simplicity**: The brainstorming session is inherently defined by the user's initial event and its reply chain
- **Stateless**: Each brainstorming is atomic and self-contained 
- **No Overhead**: No need to manage session lifecycle or state persistence
- **Natural Boundaries**: The conversation thread itself provides the session boundary

### Tag-Based Control Flow
The user's initial `kind:1` event contains:
- `["mode", "brainstorm"]` - Activates brainstorming mode
- `["moderator", "<pubkey>"]` - Designates the moderator agent
- `["p", "<agent1_pubkey>"]`, `["p", "<agent2_pubkey>"]`, etc. - Generator agents
- `["brainstorm_timeout", "30s"]` - Optional timeout (default: 30s)

## Implementation Phases

### Phase 1: MVP Implementation

#### 1. Modify AgentRouter to Support Brainstorming Mode

**File**: `src/event-handler/AgentRouter.ts`

```typescript
// Add new return type for brainstorming
interface BrainstormRoutingResult {
  isBrainstorm: boolean;
  moderator?: AgentInstance;
  generators: AgentInstance[];
  timeout?: number;
}

// Modify resolveTargetAgents to detect brainstorming mode
static resolveTargetAgents(
  event: NDKEvent,
  projectContext: ProjectContext
): AgentInstance[] | BrainstormRoutingResult {
  const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
  
  // Check for brainstorming mode
  const modeTag = event.tags.find(tag => tag[0] === "mode" && tag[1] === "brainstorm");
  if (modeTag) {
    const moderatorTag = event.tags.find(tag => tag[0] === "moderator");
    const timeoutTag = event.tags.find(tag => tag[0] === "brainstorm_timeout");
    
    const moderatorPubkey = moderatorTag?.[1];
    const timeout = timeoutTag ? parseTimeout(timeoutTag[1]) : 30000;
    
    // Resolve all p-tagged agents
    const allAgents = // existing logic to get agents from mentionedPubkeys
    
    // Split into moderator and generators
    const moderator = moderatorPubkey ? 
      allAgents.find(a => a.pubkey === moderatorPubkey) : undefined;
    const generators = allAgents.filter(a => a.pubkey !== moderatorPubkey);
    
    return {
      isBrainstorm: true,
      moderator,
      generators,
      timeout
    };
  }
  
  // Existing non-brainstorm logic...
}
```

#### 2. Update Reply Handler for Brainstorming

**File**: `src/event-handler/reply.ts`

```typescript
async function handleReplyLogic(
  event: NDKEvent,
  { conversationCoordinator, agentExecutor }: EventHandlerContext
): Promise<void> {
  // ... existing conversation setup ...
  
  // Determine target agents
  const routingResult = AgentRouter.resolveTargetAgents(event, projectCtx);
  
  // Check if this is brainstorming mode
  if (typeof routingResult === 'object' && 'isBrainstorm' in routingResult) {
    await handleBrainstormMode(
      event,
      routingResult,
      conversation,
      { conversationCoordinator, agentExecutor }
    );
    return;
  }
  
  // ... existing standard routing logic ...
}

async function handleBrainstormMode(
  event: NDKEvent,
  routing: BrainstormRoutingResult,
  conversation: Conversation,
  context: EventHandlerContext
): Promise<void> {
  // Execute generators in parallel with kind:1110 override
  const generatorPromises = routing.generators.map(async (generator) => {
    const executionContext: ExecutionContext = {
      agent: generator,
      conversationId: conversation.id,
      projectPath: getProjectContext().agentRegistry.getBasePath(),
      triggeringEvent: event,
      conversationCoordinator: context.conversationCoordinator,
      options: { replyKind: 1110 } // Override reply kind
    };
    
    await context.agentExecutor.execute(executionContext);
  });
  
  // Execute moderator with special strategy
  if (routing.moderator) {
    const moderatorContext: ExecutionContext = {
      agent: routing.moderator,
      conversationId: conversation.id,
      projectPath: getProjectContext().agentRegistry.getBasePath(),
      triggeringEvent: event,
      conversationCoordinator: context.conversationCoordinator,
      strategy: new BrainstormModerationStrategy(routing.timeout)
    };
    
    await context.agentExecutor.execute(moderatorContext);
  }
  
  await Promise.all([...generatorPromises]);
}
```

#### 3. Modify AgentExecutor to Support Custom Reply Kinds

**File**: `src/agents/execution/AgentExecutor.ts`

```typescript
interface ExecutionOptions {
  replyKind?: number;
}

async execute(
  context: ExecutionContext,
  strategy?: MessageGenerationStrategy,
  options?: ExecutionOptions
): Promise<void> {
  // ... existing setup ...
  
  // Pass options through to strategy if needed
  const messages = await this.messageStrategy.buildMessages(
    context, 
    context.triggeringEvent,
    options
  );
  
  // ... rest of execution ...
  
  // When publishing, use custom kind if specified
  const eventContext: EventContext = {
    // ... existing context ...
    kind: options?.replyKind // Pass through custom kind
  };
}
```

#### 4. Create Brainstorm Moderation Strategy

**File**: `src/agents/execution/strategies/BrainstormModerationStrategy.ts`

```typescript
import type { MessageGenerationStrategy } from "./types";
import { getNDK } from "@/nostr/ndkClient";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

export class BrainstormModerationStrategy implements MessageGenerationStrategy {
  private candidateReplies: NDKEvent[] = [];
  private timeout: number;
  
  constructor(timeout: number = 30000) {
    this.timeout = timeout;
  }
  
  async buildMessages(
    context: ExecutionContext,
    triggeringEvent: NDKEvent
  ): Promise<ModelMessage[]> {
    // Collect kind:1110 replies
    const replies = await this.collectBrainstormReplies(triggeringEvent);
    
    // Build prompt for LLM to select best reply
    return [{
      role: "system",
      content: "You are a moderator agent selecting the best response from multiple drafts."
    }, {
      role: "user",
      content: this.buildSelectionPrompt(triggeringEvent, replies)
    }];
  }
  
  private async collectBrainstormReplies(
    triggeringEvent: NDKEvent
  ): Promise<NDKEvent[]> {
    const ndk = getNDK();
    const replies: NDKEvent[] = [];
    
    return new Promise((resolve) => {
      // Subscribe to kind:1110 replies
      const subscription = ndk.subscribe({
        kinds: [1110],
        '#e': [triggeringEvent.id]
      });
      
      subscription.on('event', (event: NDKEvent) => {
        replies.push(event);
      });
      
      // Wait for timeout then resolve
      setTimeout(() => {
        subscription.stop();
        resolve(replies);
      }, this.timeout);
    });
  }
  
  private buildSelectionPrompt(
    originalEvent: NDKEvent,
    replies: NDKEvent[]
  ): string {
    return `Original request: ${originalEvent.content}
    
    Received ${replies.length} draft responses:
    
    ${replies.map((r, i) => `
    Response ${i + 1} (from ${r.pubkey.substring(0, 8)}):
    ${r.content}
    `).join('\n')}
    
    Select the BEST response by returning ONLY its event ID.
    Consider: relevance, completeness, clarity, and correctness.
    
    Return format: {"selected_event_id": "<event_id>"}`;
  }
  
  async processLLMResponse(
    llmResponse: string,
    context: ExecutionContext
  ): Promise<void> {
    // Parse selected event ID from LLM response
    const selection = JSON.parse(llmResponse);
    const winningEvent = this.candidateReplies.find(
      r => r.id === selection.selected_event_id
    );
    
    if (!winningEvent) {
      throw new Error("Invalid selection from moderator");
    }
    
    // Publish promoted reply
    await this.publishPromotedReply(
      winningEvent,
      context
    );
  }
  
  private async publishPromotedReply(
    winningEvent: NDKEvent,
    context: ExecutionContext
  ): Promise<void> {
    const agentPublisher = new AgentPublisher(context.agent);
    
    // Get losing agents for feedback loop
    const losingAgents = this.candidateReplies
      .filter(r => r.id !== winningEvent.id)
      .map(r => r.pubkey);
    
    await agentPublisher.publishPromotedReply(
      winningEvent,
      context.triggeringEvent,
      losingAgents
    );
  }
}
```

#### 5. Add Promotion Method to AgentPublisher

**File**: `src/nostr/AgentPublisher.ts`

```typescript
/**
 * Publish a promoted brainstorm reply.
 * Creates a kind:1111 event from the moderator that references the winning kind:1110.
 */
async publishPromotedReply(
  winningReply: NDKEvent,
  originalUserEvent: NDKEvent,
  losingAgentsPubkeys: string[]
): Promise<NDKEvent> {
  const event = new NDKEvent(getNDK());
  event.kind = 1111; // Standard reply kind
  event.content = winningReply.content;
  
  // Tag structure for promoted reply
  event.tags = [
    // Reference the original user request
    ["e", originalUserEvent.id, "", "root"],
    // Reference the winning draft reply
    ["e", winningReply.id, "", "reply"],
    // Mark original author for transparency
    ["original_author", winningReply.pubkey],
    // Tag losing agents for feedback loop
    ...losingAgentsPubkeys.map(pubkey => ["p", pubkey]),
    // Mark as promoted content
    ["promoted", "true"],
    ["promotion_reason", "selected_best_response"]
  ];
  
  // Sign with moderator's key
  await event.sign(this.agent.signer);
  await event.publish();
  
  logger.info("Published promoted reply", {
    moderator: this.agent.name,
    originalAuthor: winningReply.pubkey.substring(0, 8),
    eventId: event.id
  });
  
  return event;
}
```

#### 6. Update AgentEventEncoder for Custom Kinds

**File**: `src/nostr/AgentEventEncoder.ts`

```typescript
encodeConversation(
  intent: ConversationIntent, 
  context: EventContext
): NDKEvent {
  const event = new NDKEvent(getNDK());
  event.kind = context.kind || 1111; // Allow custom kind override
  event.content = intent.content;
  
  // ... existing tag logic ...
  
  return event;
}
```

### Phase 2: Feedback Loop for Non-Selected Agents

#### 1. Create Feedback Prompt Fragment

**File**: `src/prompts/fragments/brainstorm-feedback.ts`

```typescript
export const brainstormFeedbackFragment = {
  id: "brainstorm-feedback",
  content: `
## Brainstorm Mode Feedback

You previously participated in a brainstorming session where multiple agents provided responses.
Your response was not selected by the moderator.

The selected response has been shared with you for learning purposes.
When responding to this promoted content:
- Acknowledge the selection gracefully
- Avoid redundant responses that duplicate the selected content
- Only respond if you have genuinely new insights to add
- Consider this a learning opportunity for future brainstorming sessions

Remember: The goal is collaborative problem-solving, not competition.
`
};
```

#### 2. Modify PromptBuilder to Inject Feedback

**File**: `src/prompts/core/PromptBuilder.ts`

```typescript
build(): string {
  // ... existing prompt building ...
  
  // Check if this is feedback scenario
  if (this.isBrainstormFeedback()) {
    fragments.push(brainstormFeedbackFragment);
  }
  
  // ... rest of building ...
}

private isBrainstormFeedback(): boolean {
  const parentEvent = this.context.triggeringEvent;
  
  // Check if parent is a promoted reply from moderator
  if (parentEvent.kind !== 1111) return false;
  
  const promotedTag = parentEvent.tags.find(t => t[0] === "promoted");
  const originalAuthorTag = parentEvent.tags.find(t => t[0] === "original_author");
  
  // Check if current agent was p-tagged (meaning they lost)
  const currentAgentTagged = parentEvent.tags.some(
    t => t[0] === "p" && t[1] === this.context.agent.pubkey
  );
  
  return promotedTag && originalAuthorTag && currentAgentTagged;
}
```

### Testing Strategy

1. **Unit Tests**:
   - Test `AgentRouter` brainstorm mode detection
   - Test `BrainstormModerationStrategy` reply collection
   - Test promotion event structure

2. **Integration Tests**:
   - End-to-end brainstorming flow
   - Timeout handling
   - Multiple agent coordination

3. **Manual Testing Scenarios**:
   - Basic brainstorm with 3 agents + moderator
   - Timeout edge cases
   - Missing moderator handling
   - Feedback loop verification

## Configuration & Defaults

- **Default timeout**: 30 seconds
- **Minimum generators**: 2 agents
- **Reply kind for drafts**: 1110
- **Reply kind for promoted**: 1111
- **Max reply collection**: 100 events (safety limit)

## Future Enhancements (Phase 3+)

1. **Pluggable Moderation Strategies**:
   - `PickBestStrategy` - Current implementation
   - `SynthesizeStrategy` - Combine multiple responses
   - `VotingStrategy` - Let agents vote on best response
   - `HumanModerationStrategy` - Wait for human selection

2. **Advanced Features**:
   - Multi-round brainstorming
   - Weighted agent contributions
   - Learning from selection patterns
   - Brainstorm analytics and metrics

## Security Considerations

1. **No Key Sharing**: Moderator publishes new events, never re-signs others' content
2. **Transparency**: Original author always credited via tags
3. **Rate Limiting**: Timeout prevents infinite reply collection
4. **Access Control**: Only designated moderator can promote replies

## Migration Path

This implementation requires no database migrations or breaking changes:
- New event kinds (1110) are additive
- Existing reply flows remain unchanged
- Brainstorm mode is opt-in via tags
- Backward compatible with non-brainstorm events