# Prompt System Architecture

## Executive Summary

The Prompt System Architecture is the sophisticated compositional engine that constructs context-aware system prompts for agents in TENEX. Unlike traditional template-based systems, it implements a fragment-based approach with priority ordering, conditional inclusion, and runtime composition. This system enables consistent agent behavior while allowing dynamic adaptation to conversation phases, available tools, and project-specific requirements. The architecture's power lies in its ability to maintain separation of concerns while composing complex prompts from reusable, testable fragments.

## Core Architecture

### System Overview

The prompt system operates through three primary layers:

```
┌─────────────────────────────────────────────────────────┐
│                    Agent Execution                       │
│           (AgentExecutor.buildMessages())                │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              System Prompt Builder                       │
│        (buildSystemPrompt() orchestration)               │
│                                                          │
│  • Determines fragment selection                         │
│  • Passes runtime context to fragments                   │
│  • Manages conditional inclusion logic                   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                  PromptBuilder                           │
│           (Fragment composition engine)                  │
│                                                          │
│  • Validates fragment arguments                          │
│  • Applies priority-based ordering                       │
│  • Concatenates fragments into final prompt              │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              FragmentRegistry                            │
│         (Global fragment storage)                        │
│                                                          │
│  • Stores all registered fragments                       │
│  • Provides fragment lookup by ID                        │
│  • Enables dynamic fragment registration                 │
└─────────────────────────────────────────────────────────┘
```

### Core Components

#### 1. FragmentRegistry (src/prompts/core/FragmentRegistry.ts)

The `FragmentRegistry` serves as the central repository for all prompt fragments. It's implemented as a singleton that maintains a Map of fragment IDs to fragment definitions.

**Key Characteristics:**
- **Global singleton**: Single instance (`fragmentRegistry`) shared across the application
- **Runtime registration**: Fragments self-register when their modules are imported
- **Type-safe storage**: Uses TypeScript generics to maintain type safety while storing heterogeneous fragments
- **Simple API**: Provides basic CRUD operations (register, get, has, clear, getAllIds)

**Registration Pattern:**
Fragments register themselves at module load time through side effects:
```typescript
// At the bottom of each fragment file:
fragmentRegistry.register(myFragment);
```

#### 2. PromptBuilder (src/prompts/core/PromptBuilder.ts)

The `PromptBuilder` implements a fluent builder pattern for composing prompts from fragments. It manages the complexity of fragment ordering, conditional inclusion, and argument validation.

**Core Responsibilities:**
- **Fragment collection**: Accumulates fragment configurations with their arguments
- **Conditional evaluation**: Evaluates condition functions to determine fragment inclusion
- **Argument validation**: Runs fragment-specific validators before template execution
- **Priority sorting**: Orders fragments by priority (lower numbers = higher priority)
- **Template execution**: Executes fragment templates with provided arguments
- **Error handling**: Provides detailed error messages for invalid arguments or missing fragments

**Build Process:**
1. Filter fragments based on conditions
2. Validate arguments for each fragment
3. Execute template functions
4. Sort by priority
5. Concatenate non-empty results with double newlines

#### 3. PromptFragment Interface (src/prompts/core/types.ts)

The `PromptFragment<T>` interface defines the contract for all fragments:

```typescript
interface PromptFragment<T = unknown> {
    id: string;                              // Unique identifier
    priority?: number;                        // Sort order (default: 50)
    template: (args: T) => string;           // Content generator
    validateArgs?: (args: unknown) => args is T;  // Type guard
    expectedArgs?: string;                   // Error message helper
}
```

**Design Principles:**
- **Type safety**: Generic type parameter ensures compile-time type checking
- **Runtime validation**: Optional validators provide runtime type checking
- **Self-documenting**: `expectedArgs` helps with debugging
- **Flexible priority**: Default priority of 50 allows fragments to position themselves relative to others

### Fragment System

#### Fragment Categories

The system organizes fragments into logical categories:

1. **Identity Fragments** (Priority: 1-10)
   - `agent-system-prompt`: Core agent identity and instructions
   - `agent-completion-guidance`: How agents should complete tasks

2. **Context Fragments** (Priority: 10-20)
   - `phase-definitions`: Available phases and transitions
   - `phase-context`: Current phase and transition history
   - `phase-constraints`: Phase-specific behavioral constraints
   - `conversation-history-instructions`: How to interpret historical context

3. **Capability Fragments** (Priority: 20-30)
   - `available-agents`: Other agents available for handoff
   - `agent-tools`: Agent-specific tools
   - `mcp-tools`: MCP server tools
   - `project-inventory-context`: Project structure understanding

4. **Behavioral Fragments** (Priority: 80-90)
   - `agent-reasoning`: Chain-of-thought instructions
   - `orchestrator-reasoning`: Routing decision logic
   - `expert-reasoning`: Domain expertise guidelines

5. **Specialized Fragments** (Variable Priority)
   - `voice-mode`: Voice interaction adaptations
   - `referenced-article`: External content context
   - `retrieved-lessons`: Historical learnings

#### Priority System

The priority system ensures consistent prompt structure:

- **1-10**: Core identity and purpose
- **10-20**: Phase and context information
- **20-30**: Available capabilities and tools
- **30-50**: Project-specific information
- **50** (default): General instructions
- **80-90**: Reasoning and behavioral guidelines
- **90+**: Final instructions or overrides

Lower priority numbers appear earlier in the final prompt, establishing foundational context before specific instructions.

### Dynamic Composition

#### buildSystemPrompt Function

The `buildSystemPrompt` function (src/prompts/utils/systemPromptBuilder.ts) orchestrates the entire prompt generation process. It serves as the single source of truth for how prompts are assembled.

**Key Decision Points:**

1. **Orchestrator vs Domain Expert**:
   - Orchestrators receive routing-specific fragments
   - Domain experts receive execution-specific fragments
   - Different conversation history interpretation instructions

2. **Phase-Aware Composition**:
   - Phase definitions always included
   - Phase constraints added based on current phase
   - Phase context includes transition history

3. **Tool Inclusion Logic**:
   - Agent tools always included if present
   - MCP tools excluded for orchestrators
   - Tool-use instructions conditionally added

4. **Conditional Fragments**:
   - Voice mode only for non-orchestrator agents with voice triggers
   - Project.md only for project-manager agent
   - Referenced articles only when metadata present
   - Lessons only when relevant to current agent/phase

#### Fragment Arguments Flow

The system passes rich context to fragments:

```typescript
interface BuildSystemPromptOptions {
    // Core requirements
    agent: Agent;
    phase: Phase;
    projectTitle: string;
    
    // Optional context
    projectRepository?: string;
    availableAgents?: Agent[];
    conversation?: Conversation;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    mcpTools?: Tool[];
    triggeringEvent?: NDKEvent;
}
```

This context flows through the builder to individual fragments, allowing them to generate contextually appropriate content.

### Registration and Initialization

#### Module Loading Strategy

The system uses a side-effect based registration pattern:

1. **Central Import Module** (src/prompts/index.ts):
   - Imports all fragment modules for side effects
   - Ensures fragments register before use
   - Exports core classes and types

2. **Fragment Self-Registration**:
   - Each fragment file registers its fragments at module load
   - No explicit initialization required
   - Guarantees availability when imported

3. **Import Order Independence**:
   - Fragments identified by unique IDs
   - Priority system handles ordering
   - No dependency on import sequence

#### Fragment Lifecycle

1. **Definition**: Fragment object created with id, priority, template, and validators
2. **Registration**: Fragment registered with global registry on module load
3. **Reference**: Builder adds fragment by ID with runtime arguments
4. **Validation**: Arguments validated when building prompt
5. **Execution**: Template function called with validated arguments
6. **Composition**: Result incorporated based on priority order

### Error Handling and Validation

#### Validation Layers

1. **Fragment Existence**:
   - Builder throws if fragment ID not found
   - Lists available fragments in error message

2. **Argument Validation**:
   - Optional type guard validates arguments
   - Detailed error messages with expected vs received
   - Falls back to template execution for dynamic validation

3. **Template Execution**:
   - Catches template errors and provides context
   - Shows fragment ID and provided arguments
   - Helps identify data structure mismatches

#### Error Message Quality

The system prioritizes developer experience with detailed errors:

```typescript
throw new Error(
    `Fragment "${fragmentId}" received invalid arguments.\n` +
    `Expected: ${expectedDesc}\n` +
    `Received: ${receivedArgs}`
);
```

### Integration Points

#### 1. Agent Execution Integration

The AgentExecutor (src/agents/execution/AgentExecutor.ts) integrates the prompt system at message building:

- Gathers all necessary context (conversation, tools, lessons)
- Calls `buildSystemPrompt` with complete options
- Creates system message with generated prompt
- Combines with conversation history for final messages

#### 2. Phase System Integration

The prompt system deeply integrates with the phase system:

- Phase definitions fragment provides phase descriptions
- Phase constraints fragment enforces phase-specific rules
- Phase context fragment includes transition history
- Phase transitions influence fragment selection

#### 3. Tool System Integration

Tool availability flows through the prompt system:

- Agent tools converted to prompt fragments
- MCP tools dynamically included based on availability
- Tool instructions adapted to available capabilities
- Tool result handling instructions included

### Performance Considerations

#### Optimization Strategies

1. **Lazy Evaluation**:
   - Fragments only execute if conditions pass
   - Empty fragments filtered before concatenation
   - Minimal string operations until final build

2. **Caching Opportunities**:
   - Fragment registry maintains single instances
   - Static fragments could cache results
   - Project context could be memoized

3. **Memory Efficiency**:
   - Fragments generate strings on-demand
   - No persistent prompt storage
   - Garbage collection friendly design

### Testing Architecture

The prompt system includes comprehensive testing:

1. **Unit Tests**:
   - PromptBuilder logic and error handling
   - FragmentRegistry operations
   - Individual fragment behavior

2. **Integration Tests**:
   - Complete prompt generation
   - Fragment interaction and ordering
   - Conditional inclusion logic

3. **Test Utilities**:
   - Mock fragments for testing
   - Assertion helpers for prompt content
   - Fragment validation testing

## Architectural Decisions

### Why Fragment-Based Architecture?

1. **Composability**: Fragments can be mixed and matched for different agent types
2. **Testability**: Each fragment can be tested in isolation
3. **Maintainability**: Changes to specific behaviors are localized
4. **Extensibility**: New fragments can be added without modifying core logic
5. **Reusability**: Fragments can be shared across different prompt contexts

### Why Priority-Based Ordering?

1. **Consistency**: Ensures predictable prompt structure across agents
2. **Flexibility**: Allows fragments to position themselves appropriately
3. **Clarity**: Makes prompt structure explicit and debuggable
4. **Override Capability**: Higher priority fragments can override earlier ones

### Why Self-Registration?

1. **Simplicity**: No complex initialization sequences
2. **Modularity**: Fragments are self-contained units
3. **Type Safety**: Registration happens at compile time
4. **Discoverability**: All fragments visible in registry

## System Nuances and Behaviors

### Fragment Interaction Patterns

1. **Information Flow**: Earlier fragments establish context for later ones
2. **Override Patterns**: Higher priority fragments can contradict earlier ones
3. **Dependency Handling**: Fragments check for required context availability
4. **Graceful Degradation**: Missing optional context doesn't break generation

### Edge Cases and Special Handling

1. **Empty Fragments**: Automatically filtered from final output
2. **Circular Dependencies**: Prevented by unidirectional data flow
3. **Missing Fragments**: Clear error messages with available alternatives
4. **Invalid Arguments**: Detailed validation errors with examples

### Phase Transition Effects

The prompt system adapts based on phase transitions:

1. **Transition Context**: Previous phase message included in prompt
2. **Constraint Changes**: Different behavioral rules per phase
3. **Tool Availability**: Some tools only available in specific phases
4. **Agent Selection**: Orchestrator routing influenced by phase

## Questions and Uncertainties

### Architectural Questions

1. **Fragment Coupling**: Some fragments seem to assume others exist (e.g., phase fragments). Is this coupling intentional or should fragments be more independent?

2. **Priority Conflicts**: What happens when two fragments have the same priority? The current implementation seems to maintain insertion order, but is this guaranteed?

3. **Dynamic Priority**: Should fragment priority be dynamic based on context? For example, should voice-mode fragments have higher priority when in voice mode?

### Implementation Questions

1. **Fragment Validation Timing**: Why do some fragments have validators while others rely on TypeScript types alone? Is there a consistent strategy?

2. **Registry Clearing**: The FragmentRegistry has a `clear()` method but it's only used in tests. Could this cause issues if called in production?

3. **Fragment ID Uniqueness**: There's no enforcement preventing duplicate fragment IDs. Later registrations would override earlier ones. Is this intentional?

### Performance Questions

1. **Template Execution Cost**: Fragment templates execute on every prompt build. Should frequently-used static fragments cache their results?

2. **String Concatenation**: The builder uses array join for concatenation. Has this been profiled against other approaches like string builder patterns?

3. **Fragment Count Scaling**: How does performance scale with the number of fragments? Is there a practical upper limit?

### Integration Questions

1. **Fragment Discovery**: How do developers discover available fragments? The error messages help, but is there a better discovery mechanism?

2. **Fragment Documentation**: Should fragments self-document their purpose and requirements beyond the `expectedArgs` field?

3. **Testing Coverage**: Are all fragment combinations tested? How do we ensure fragments compose correctly?

### Future Considerations

1. **Fragment Versioning**: As fragments evolve, how do we handle backward compatibility?

2. **Fragment Marketplace**: Could external fragments be loaded dynamically?

3. **Prompt Size Limits**: How does the system handle LLM token limits? Should fragments be aware of their token cost?

4. **A/B Testing**: Could the fragment system support prompt experimentation?

5. **Observability**: Should fragment execution be traced for debugging and optimization?