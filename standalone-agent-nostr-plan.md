# Standalone Agent Nostr Communication Plan

## Current State Analysis

### How P-Tag Subscriptions Work Now
From `SubscriptionManager.ts:65-67`:
- The system subscribes to events with `#p` tags matching agent pubkeys
- This allows direct messaging to agents by p-tagging them
- Works within project context where all agents are known

### Event Flow
1. User creates Nostr event with `#p: [agent-pubkey]`
2. SubscriptionManager catches it via `{ "#p": agentPubkeys }` filter
3. EventHandler routes to appropriate conversation/agent
4. AgentExecutor builds context and executes

## Standalone Agent Communication Design

### Option 1: Direct P-Tag Subscription (Recommended)
**Simple, clean, follows existing patterns**

```typescript
// StandaloneAgentListener.ts
export class StandaloneAgentListener {
    private subscription?: NDKSubscription;
    
    constructor(
        private agent: AgentInstance,
        private llmService: LLMService,
        private ndk: NDK
    ) {}
    
    async start(): Promise<void> {
        // Subscribe to events that p-tag this agent
        const filter: NDKFilter = {
            "#p": [this.agent.pubkey],
            kinds: [1, 1111], // Text notes and replies
        };
        
        this.subscription = this.ndk.subscribe(filter, {
            closeOnEose: false,
            groupable: false,
        });
        
        this.subscription.on("event", async (event: NDKEvent) => {
            await this.handleDirectMessage(event);
        });
    }
    
    private async handleDirectMessage(event: NDKEvent): Promise<void> {
        // Create standalone components
        const persistence = new InMemoryPersistenceAdapter();
        const resolver = new StandaloneAgentResolver(
            new Map([[this.agent.slug, this.agent]])
        );
        
        // Create conversation manager with standalone components
        const conversationManager = new ConversationManager(
            `/tmp/standalone-${this.agent.slug}`,
            persistence
        );
        await conversationManager.initialize();
        
        // Create or get conversation
        let conversation = conversationManager.getConversationByEvent(event.id);
        if (!conversation) {
            conversation = await conversationManager.createConversation(event);
        }
        
        // Create standalone context
        const standaloneContext: StandaloneAgentContext = {
            agents: new Map([[this.agent.slug, this.agent]]),
            pubkey: this.agent.pubkey,
            signer: this.agent.signer,
        };
        
        // Execute with standalone context
        const executor = new AgentExecutor(
            this.llmService, 
            conversationManager,
            standaloneContext
        );
        
        const context: ExecutionContext = {
            conversationId: conversation.id,
            agent: this.agent,
            phase: PHASES.CHAT, // Default to CHAT for standalone
            triggeringEvent: event,
            conversationManager,
        };
        
        await executor.execute(context);
    }
}
```

### Option 2: Virtual Project Wrapper
**Reuses more existing code but adds complexity**

```typescript
// Create a minimal virtual project
const virtualProject = {
    id: `standalone-${agent.slug}`,
    encode: () => `standalone-${agent.slug}`,
    tagValue: (tag: string) => {
        if (tag === "title") return agent.name;
        if (tag === "d") return agent.slug;
        return null;
    },
    filter: () => ({ "#d": [agent.slug] }),
    tags: [],
    pubkey: agent.pubkey,
} as any as NDKProject;

// Use existing SubscriptionManager with virtual project
```

### Option 3: Agent-as-a-Service
**Most flexible, supports multiple conversation types**

```typescript
interface StandaloneAgentService {
    // Direct messages (kind 1 with p-tag)
    handleDirectMessage(event: NDKEvent): Promise<void>;
    
    // Mentions in conversations (kind 1 with p-tag in existing conversation)
    handleMention(event: NDKEvent, conversationId: string): Promise<void>;
    
    // Task assignments (kind 5206)
    handleTask(task: NDKTask): Promise<void>;
    
    // Spec requests (kind 1111 with K:30023)
    handleSpecRequest(event: NDKEvent): Promise<void>;
}
```

## Implementation Recommendations

### Phase 1: Basic Direct Messaging
1. Implement `StandaloneAgentListener` (Option 1)
2. Add CLI command: `tenex agent chat <agent-slug>`
3. Test with simple text exchanges

### Phase 2: Conversation Threading
1. Track conversation threads via `e` tags
2. Maintain conversation history in memory
3. Support multi-turn conversations

### Phase 3: Enhanced Features
1. Persistent conversation storage (SQLite)
2. Multiple standalone agents in same process
3. Agent-to-agent communication

## CLI Command Implementation

```typescript
// src/commands/agent/chat.ts
import { Command } from "commander";
import { StandaloneAgentListener } from "@/agents/standalone/StandaloneAgentListener";

export const agentChatCommand = new Command("chat")
    .description("Start a standalone agent that responds to Nostr messages")
    .argument("<agent-slug>", "Agent to run in standalone mode")
    .option("--relay <url>", "Custom relay URL", "wss://relay.damus.io")
    .action(async (agentSlug: string, options) => {
        // 1. Load agent from global registry
        const registry = new AgentRegistry(getGlobalPath(), true);
        await registry.loadFromProject();
        const agent = registry.getAgent(agentSlug);
        
        if (!agent) {
            logger.error(`Agent "${agentSlug}" not found in global registry`);
            process.exit(1);
        }
        
        // 2. Initialize NDK with custom relay if provided
        const ndk = await initializeNDK({
            relays: [options.relay],
        });
        
        // 3. Load LLM service
        const llmService = await loadLLMRouter(getGlobalPath());
        
        // 4. Start standalone listener
        const listener = new StandaloneAgentListener(agent, llmService, ndk);
        await listener.start();
        
        logger.info(`✅ Agent "${agent.name}" is now listening for messages`);
        logger.info(`   Pubkey: ${agent.pubkey}`);
        logger.info(`   Relay: ${options.relay}`);
        logger.info(`   `);
        logger.info(`To chat with this agent, p-tag it in a Nostr event:`);
        logger.info(`   Event content: "Hello agent!"`);
        logger.info(`   Tags: [["p", "${agent.pubkey}"]]`);
        
        // Keep process running
        await new Promise(() => {});
    });
```

## Testing Strategy

### Unit Tests
```typescript
describe('StandaloneAgentListener', () => {
    it('should respond to p-tagged events', async () => {
        const mockAgent = createMockAgent();
        const listener = new StandaloneAgentListener(mockAgent, mockLLM, mockNDK);
        
        const event = createMockEvent({
            content: "Hello agent",
            tags: [["p", mockAgent.pubkey]]
        });
        
        await listener.handleDirectMessage(event);
        
        expect(mockPublisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.stringContaining("Hello"),
                tags: expect.arrayContaining([["e", event.id]])
            })
        );
    });
});
```

### Integration Tests
1. Start standalone agent
2. Send Nostr event with p-tag
3. Verify response event is published
4. Check conversation threading works

## Benefits of This Approach

1. **Minimal Changes**: Reuses existing AgentExecutor with standalone context
2. **Clean Separation**: No project dependencies in standalone mode
3. **Nostr Native**: Uses standard p-tagging for agent communication
4. **Flexible**: Can be extended for groups, channels, etc.
5. **Testable**: Each component can be tested independently

## Migration Path

1. **Week 1**: Implement StandaloneAgentListener and basic CLI
2. **Week 2**: Add conversation persistence and threading
3. **Week 3**: Support multiple agents and agent-to-agent communication
4. **Week 4**: Production hardening and monitoring

## Security Considerations

1. **Rate Limiting**: Prevent spam by tracking event rates per pubkey
2. **Authentication**: Verify event signatures before processing
3. **Resource Limits**: Cap conversation history and memory usage
4. **Relay Selection**: Use trusted relays or allow user configuration