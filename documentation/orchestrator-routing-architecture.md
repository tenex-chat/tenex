# Orchestrator and Routing System Architecture

## Executive Summary

The Orchestrator and Routing System forms the intelligent coordination layer of TENEX, managing complex multi-agent workflows through a sophisticated phase-based execution model. This system ensures that user requests are routed to the appropriate specialized agents, maintains conversation state across distributed agent interactions, and enforces quality through mandatory verification and reflection phases. The architecture implements a unique invisible routing pattern where the orchestrator never directly interacts with users but instead coordinates agent collaboration behind the scenes.

## Core Architecture

### System Overview

The orchestrator operates as an invisible message router that coordinates agent collaboration:

```
┌─────────────────────────────────────────────────────────┐
│                      User Request                        │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                    Orchestrator                          │
│               (Invisible Router Agent)                   │
│         • Analyzes JSON routing context                  │
│         • Makes phase & agent decisions                  │
│         • Returns structured JSON only                   │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                  RoutingBackend                          │
│            (ExecutionBackend Implementation)             │
│         • Validates routing decisions                    │
│         • Executes target agents                         │
│         • Handles error recovery                         │
└─────────────────────┬───────────────────────────────────┘
                      │
         ┌────────────┼────────────┬──────────────┐
         ▼            ▼            ▼              ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Executor   │ │   Planner    │ │Project Manager│ │Expert Agents │
│(Can modify)  │ │(Plans only)  │ │(Requirements) │ │(Advisory)    │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## Key Components

### 1. Orchestrator Agent
**Location**: `src/agents/built-in/orchestrator.ts`

The orchestrator is a special-purpose agent with unique characteristics:

**Core Properties**:
- **Backend Type**: `"routing"` - Uses RoutingBackend instead of standard execution
- **Visibility**: Completely invisible to users
- **Input Format**: JSON context with routing history
- **Output Format**: Structured JSON routing decisions only
- **LLM Config**: Uses dedicated `"orchestrator"` configuration

**Routing Decision Structure**:
```typescript
{
    agents: string[];      // Target agent slugs
    phase?: string;        // Optional phase transition
    reason: string;        // Routing rationale
}
```

**Critical Behaviors**:
- Never generates user-visible output
- Always returns valid JSON
- Enforces phase flow quality gates
- Routes to special "END" agent for termination

### 2. RoutingBackend
**Location**: `src/agents/execution/RoutingBackend.ts`

The execution backend that implements the routing logic:

**Core Responsibilities**:
- **Decision Retrieval**: Gets routing decisions from LLM
- **JSON Parsing**: Extracts and validates routing JSON
- **Agent Execution**: Instantiates and executes target agents
- **Turn Management**: Tracks orchestrator routing turns
- **Error Recovery**: Handles invalid agent names gracefully
- **Phase Transitions**: Updates conversation phase when needed

**Key Methods**:

```typescript
async execute(
    messages: Message[],
    tools: Tool[],           // Ignored - routing doesn't use tools
    context: ExecutionContext,
    publisher: NostrPublisher
): Promise<void>
```

**Execution Flow**:
1. Get routing decision from LLM
2. Start orchestrator turn for tracking
3. Update phase if transitioning
4. Execute each target agent
5. Handle errors and retry with feedback

**Error Recovery Mechanism**:

When an invalid agent name is encountered:
1. Generate corrective feedback with available agents
2. Store as a learning lesson
3. Re-attempt routing with feedback
4. Execute corrected routing decision

This self-correcting behavior ensures robustness against:
- Typos in agent names
- Case sensitivity issues
- Format inconsistencies (e.g., "Project Manager" vs "project-manager")

### 3. Phase System
**Location**: `src/conversations/phases.ts`

Seven distinct phases guide conversation flow:

```typescript
type Phase = 
    | "chat"         // Requirements gathering
    | "brainstorm"   // Creative exploration
    | "plan"         // Architecture planning
    | "execute"      // Implementation
    | "verification" // Functional testing
    | "chores"       // Cleanup/documentation
    | "reflection";  // Learning capture
```

**Phase Definitions**:

Each phase has structured metadata:
- **description**: What happens in this phase
- **goal**: Primary objective
- **whenToUse**: Trigger conditions
- **doNot**: Anti-patterns to avoid
- **constraints**: Rules and boundaries

**Phase Transition Rules**:

```typescript
const PHASE_TRANSITIONS = {
    chat: [execute, plan, brainstorm],
    brainstorm: [chat, plan, execute],
    plan: [execute],
    execute: [verification, chat],
    verification: [chores, execute, chat],
    chores: [reflection],
    reflection: [chat]
};
```

**Quality Gate Enforcement**:

The orchestrator enforces a critical flow after execution:
```
EXECUTE → VERIFICATION → CHORES → REFLECTION → END
```

This ensures:
- Work is always verified functionally
- Documentation is updated
- Lessons are captured for improvement

**Conversation Restart**:
After reaching END, the orchestrator can restart conversations when new user messages arrive:
- Detects END in routing history
- Compares new user request with original
- Routes to CHAT phase for new requests
- Maintains full conversation history

### 4. ConversationManager
**Location**: `src/conversations/ConversationManager.ts`

Manages conversation state and orchestrator coordination:

**Core Capabilities**:

**Orchestrator Turn Management**:
```typescript
interface OrchestratorTurn {
    turnId: string;
    timestamp: number;
    phase: Phase;
    agents: string[];           // Routed agents
    completions: Completion[];  // Their outputs
    reason?: string;
    isCompleted: boolean;
}
```

**Turn Lifecycle**:
1. `startOrchestratorTurn()`: Begin tracking a routing decision
2. `addCompletionToTurn()`: Record agent completions
3. Auto-completion when all agents finish

**Routing Context Building**:

The `buildOrchestratorRoutingContext()` method creates a context with a workflow narrative for the orchestrator:

```typescript
interface OrchestratorRoutingContext {
    user_request: string;  // Original user request that started the conversation
    workflow_narrative: string;  // Human-readable narrative of conversation flow and agent interactions
}
```

**Context Processing Logic**:
1. Extract original user request
2. Build workflow narrative from orchestrator turns and completions
3. Present agent interactions in a human-readable format
4. Include all completion messages for context-aware decision-making

**Agent Message Building**:

For routed agents, the manager:
1. Tracks what each agent has seen (`lastProcessedMessageIndex`)
2. Separates historical messages from new ones
3. Adds "MESSAGES WHILE YOU WERE AWAY" blocks
4. Maintains Claude session continuity
5. Processes Nostr entity references inline

## Routing Decision Logic

### Initial Phase Selection

The orchestrator applies sophisticated heuristics for initial routing:

**Direct to EXECUTE**:
- Clear action verbs (fix, add, remove, update)
- Specific feature requests
- Concrete modification targets
- Examples: "Fix typo on line 42", "Add login button"

**Route to PLAN**:
- Clear goals but architectural complexity
- Multiple component involvement
- System-wide changes
- Examples: "Implement OAuth2", "Migrate to PostgreSQL"

**Route to CHAT**:
- Ambiguous requirements
- Missing context or details
- Open-ended questions
- Examples: "Make it better", "What about performance?"

**Route to BRAINSTORM**:
- Creative exploration
- "What if" scenarios
- Ideation requests
- Examples: "Ways to improve engagement"

**Default Bias**: When uncertain between CHAT and EXECUTE, prefer EXECUTE for action-oriented behavior.

### Agent Specialization and Routing

**Core Agent Capabilities**:

**Executor** (executor):
- ONLY agent that can modify the system
- Handles all file operations and shell commands
- Implements changes from other agents' recommendations
- Performs verification and testing

**Planner** (planner):
- Creates implementation plans
- Makes architectural decisions
- Cannot modify code directly
- Output feeds to executor

**Project Manager** (project-manager):
- Maintains project knowledge
- Gathers requirements
- Provides summaries and context
- Cannot modify system

**Expert Agents**:
- Domain-specific advisory roles
- Provide recommendations only
- Cannot directly modify system
- Feedback routed through executor

### Routing Patterns

**Sequential Routing**:
```
User Request → Orchestrator → Planner → Orchestrator → Executor
```

**Parallel Routing**:
```
Orchestrator → [Expert1, Expert2] → Orchestrator → Executor
```

**Feedback Loop**:
```
Executor (issues) → Orchestrator → Expert → Orchestrator → Executor (fixes)
```

**Phase Transition**:
```
Executor (complete) → Orchestrator (VERIFICATION) → Executor (verify)
```

## Execution Flow

### 1. Request Initiation

When a user sends a request:

1. **Event Creation**: User message becomes an NDKEvent
2. **Conversation Start**: ConversationManager creates/updates conversation
3. **Orchestrator Trigger**: System routes to orchestrator first
4. **Context Building**: Manager builds OrchestratorRoutingContext

### 2. Routing Decision

The orchestrator:

1. **Receives JSON Context**: Structured routing context
2. **Analyzes State**: 
   - Empty history → Initial routing
   - Active routing → Wait for completions
   - Completed routing → Next steps
3. **Makes Decision**: Returns JSON with agents, phase, reason
4. **No User Output**: Remains completely invisible

### 3. Agent Execution

RoutingBackend processes the decision:

```typescript
// Simplified execution flow
for (const agentSlug of routingDecision.agents) {
    // Handle termination
    if (agentSlug === "END") {
        // Mark conversation as complete in orchestrator turns
        // This allows restart when new messages arrive
        break;
    }
    
    // Find agent
    const targetAgent = findAgentByName(agents, agentSlug);
    
    if (!targetAgent) {
        // Error recovery with feedback
        await sendRoutingFeedback(context, agentSlug, availableAgents);
        continue;
    }
    
    // Execute agent
    const targetContext = createContext(targetAgent);
    await agentExecutor.execute(targetContext);
}
```

### 4. Completion Tracking

Agents signal completion via the `complete()` tool:

1. **Tool Call**: Agent uses complete() with summary
2. **Event Tag**: Event tagged with ["tool", "complete"]
3. **Turn Update**: ConversationManager records completion
4. **Next Routing**: Orchestrator analyzes completions

### 5. Phase Transitions

Phase changes are managed carefully:

```typescript
// Phase transition with comprehensive context
await conversationManager.updatePhase(
    conversationId,
    newPhase,
    transitionMessage,    // Full context
    agentPubkey,
    agentName,
    reason               // Brief description
);
```

**Transition Context Includes**:
- Previous phase state
- Work completed
- Handoff message for next phase
- Summary for receiving agents

## State Management

### Conversation State

```typescript
interface Conversation {
    id: string;
    phase: Phase;
    history: NDKEvent[];              // All messages
    agentStates: Map<string, AgentState>; // Per-agent tracking
    phaseTransitions: PhaseTransition[];  // Phase history
    orchestratorTurns: OrchestratorTurn[]; // Routing decisions
    executionTime: ExecutionTimeTracking;
    metadata: ConversationMetadata;
}
```

### Agent State Tracking

Each agent maintains:
```typescript
interface AgentState {
    lastProcessedMessageIndex: number;  // Position in history
    claudeSessionId?: string;           // Session continuity
}
```

This enables:
- Agents to know what they've seen
- Proper message sequencing
- Session continuity across turns
- Efficient context building

### Orchestrator Turn State

```typescript
interface OrchestratorTurn {
    turnId: string;                // Unique identifier
    timestamp: number;
    phase: Phase;
    agents: string[];              // Target agents
    completions: Completion[];     // Results
    reason?: string;               // Decision rationale
    isCompleted: boolean;          // All agents done?
}
```

## Error Handling and Recovery

### Multi-Level Error Strategy

**Level 1: Agent Name Validation**

When invalid agent names are encountered:
1. Generate helpful feedback with correct names
2. Show common mistakes and corrections
3. Store as learning lesson
4. Retry with corrected names

**Level 2: Execution Failures**

When agent execution fails:
1. Log error with full context
2. Continue with other agents
3. Don't fail entire routing
4. Report failures in completions

**Level 3: Parsing Errors**

When JSON parsing fails:
1. Extract JSON from markdown blocks
2. Validate with Zod schema
3. Provide detailed error messages
4. Fail fast with clear feedback

**Level 4: State Recovery**

When conversation state is inconsistent:
1. Initialize missing agent states
2. Convert serialized Maps properly
3. Ensure execution time tracking
4. Graceful degradation

### Learning Integration

The system captures routing mistakes as lessons:

```typescript
const lesson = {
    scenario: `Routing to agent "${invalidAgent}"`,
    mistake: `Used incorrect slug "${invalidAgent}"`,
    correction: `Should use: ${availableAgents.join(', ')}`,
    timestamp: new Date().toISOString()
};
```

These lessons:
- Help prevent repeated mistakes
- Improve routing accuracy over time
- Provide debugging insights
- Enable pattern recognition

## Quality Enforcement

### Mandatory Quality Phases

After EXECUTE, the system enforces:

**VERIFICATION Phase**:
- Functional testing from user perspective
- Not code review, but behavior validation
- Clear reproduction steps for issues
- Route back to EXECUTE if problems found

**CHORES Phase**:
- Documentation updates
- Code cleanup
- Test updates
- Artifact organization

**REFLECTION Phase**:
- Each agent reflects once
- Capture specific learnings
- Avoid trivial lessons
- Project-specific insights only

### Loop Prevention

The orchestrator prevents infinite loops by:

1. **Detecting Repetition**: Identifying repeated routing patterns
2. **Agent Variation**: Routing to different agents
3. **Phase Escalation**: Moving to next phase
4. **Manager Escalation**: Routing to project-manager

## Performance Characteristics

### Caching Strategy

- **Agent States**: Cached in conversation memory
- **Routing History**: Maintained in orchestratorTurns
- **Message Processing**: Incremental based on lastProcessedMessageIndex
- **Context Building**: Efficient with tracked state

### Parallel Execution

The system supports parallel agent execution:
- Multiple agents can work simultaneously
- Completions tracked independently
- Turn marked complete when all finish
- Failures don't block other agents

### Resource Management

- **Memory**: Agent states are lightweight indexes
- **Processing**: Incremental message processing
- **Network**: Async agent execution
- **Storage**: Persistent conversation state

## Integration Points

### Nostr Event System

The orchestrator integrates with Nostr through:
- Event-based triggering
- NDKEvent message history
- Tag-based agent identification
- Completion detection via tool tags

### Tool System

While the orchestrator doesn't use tools directly:
- Monitors complete() tool usage
- Extracts completion messages
- Routes based on tool outputs
- Enforces complete() requirement

### LLM Service

The orchestrator uses specialized LLM configuration:
- Lower temperature (0.3) for consistency
- JSON-only output format
- Dedicated "orchestrator" config
- Structured prompt templates

### Prompt Fragments

The system uses modular prompt fragments:
- `orchestrator-routing-instructions`: Core routing logic
- `phase-definitions`: Phase descriptions
- `available-agents`: Agent capabilities
- Dynamic assembly based on context

## Common Patterns

### Workflow Patterns

**Simple Task**:
```
User → Orchestrator → Executor → Verification → Chores → Reflection → END
```

**Complex Feature**:
```
User → Orchestrator → Planner → Executor → Expert Review → Executor → Verification → Chores → Reflection → END
```

**Clarification Flow**:
```
User → Orchestrator → Project Manager (chat) → Orchestrator → Executor
```

### Routing Patterns

**Single Agent**:
```json
{
    "agents": ["executor"],
    "phase": "execute",
    "reason": "Clear implementation task"
}
```

**Multi-Agent**:
```json
{
    "agents": ["expert-1", "expert-2"],
    "reason": "Need domain expertise"
}
```

**Phase Transition**:
```json
{
    "agents": ["executor"],
    "phase": "verification",
    "reason": "Implementation complete, verifying"
}
```

**Termination**:
```json
{
    "agents": ["END"],
    "reason": "Workflow complete"
}
```

## Testing Considerations

### Unit Testing

Critical areas requiring testing:
- Routing decision validation
- Phase transition rules
- Agent name normalization
- Error recovery flows
- Turn completion logic

### Integration Testing

Key flows to test:
- Full workflow execution
- Multi-agent coordination
- Phase sequence enforcement
- Error recovery scenarios
- State persistence

### Test Patterns

The codebase includes comprehensive tests:
- `OrchestratorRouting.test.ts`: Routing context building
- `orchestrator-routing.test.ts`: Prompt fragment generation
- `RoutingBackend.test.ts`: Execution backend logic

## Future Architectural Considerations

### Potential Enhancements

1. **Dynamic Routing Rules**: Allow project-specific routing patterns
2. **Parallel Phase Execution**: Some phases could run concurrently
3. **Conditional Routing**: Based on execution outcomes
4. **Routing Templates**: Predefined workflow patterns
5. **Agent Capability Discovery**: Dynamic agent registration

### Scalability Considerations

1. **Distributed Orchestration**: Multiple orchestrators for sub-workflows
2. **Agent Pools**: Load balancing across agent instances
3. **Async Completions**: WebSocket-based completion notifications
4. **State Partitioning**: Conversation sharding for scale

## Questions and Uncertainties

### Architectural Questions

1. **Turn Timeout**: There's no timeout mechanism for orchestrator turns. Should abandoned turns auto-complete after a threshold?

2. **Parallel Phase Execution**: Could some phases run in parallel (e.g., verification and chores) for efficiency?

3. **Routing Priority**: When multiple agents could handle a task, how should priority be determined?

4. **Phase Skipping**: The system allows phase skipping but discourages it. Should there be hard enforcement options?

5. **Agent Capacity**: No mechanism exists to check if an agent is "busy". Should there be agent availability tracking?

### Implementation Uncertainties

1. **END Agent Handling**: The END "agent" is special-cased in RoutingBackend. Should this be formalized as a control flow construct?

2. **Completion Detection**: Relies on ["tool", "complete"] tags. What if an agent crashes before completing?

3. **Message Attribution**: System messages from agents use `[AgentName]: content` format. Is this consistently parsed?

4. **Phase Transition Atomicity**: Phase transitions aren't atomic with routing decisions. Could this cause inconsistencies?

5. **Routing Decision Caching**: Routing decisions aren't cached. Should failed routings be remembered to avoid repetition?

6. **Agent Finding Logic**: The `findAgentByName` function suggests fuzzy matching, but implementation details are abstracted. Edge cases?

7. **Orchestrator Recursion**: Can the orchestrator route to itself? This seems prevented but isn't explicitly documented.

8. **Turn Abandonment**: If an agent never completes, the turn remains open indefinitely. Recovery mechanism needed?

### Behavioral Uncertainties

1. **Feedback Message Handling**: When routing feedback is sent, it's added as a system message. Does this affect conversation history?

2. **Parallel Agent Conflicts**: If parallel agents modify the same resources, how are conflicts resolved?

3. **Phase Regression**: Can phases go backward (e.g., from verification back to plan)? Rules seem to prevent this.

4. **Orchestrator Visibility**: The orchestrator is "invisible" but its decisions affect conversation flow. Should decisions be logged for debugging?

5. **Agent Availability**: The system assumes all agents are always available. What about agent health/status checks?

## Conclusion

The Orchestrator and Routing System represents a sophisticated approach to multi-agent coordination, implementing an invisible routing layer that manages complex workflows through phase-based execution. Its self-correcting error recovery, quality enforcement gates, and comprehensive state management make it robust for production use while maintaining flexibility for diverse use cases.

The architecture successfully balances:
- **Invisibility**: Users never see routing complexity
- **Intelligence**: Smart routing based on context and history
- **Quality**: Enforced verification and documentation phases
- **Flexibility**: Supports various workflow patterns
- **Robustness**: Self-correcting error recovery
- **Scalability**: Efficient state management and parallel execution

This design enables TENEX to handle complex, multi-step workflows while maintaining clear separation of concerns between coordination logic and agent specialization. The phase-based approach ensures consistent quality outcomes while the invisible orchestrator pattern keeps the complexity hidden from end users.