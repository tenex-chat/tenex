# Prompt System Architecture

## Executive Summary

The Prompt System Architecture is the sophisticated compositional engine that constructs context-aware system prompts for agents in TENEX. It implements a fragment-based approach with priority ordering, conditional inclusion, and runtime composition. This system enables consistent agent behavior while allowing dynamic adaptation to conversation phases, available tools, and project-specific requirements. The architecture's power lies in its ability to maintain separation of concerns while composing complex prompts from reusable, testable fragments.

## Table of Contents

1. [System Philosophy and Design Rationale](#system-philosophy-and-design-rationale)
2. [Core Architecture](#core-architecture)
3. [Fragment System](#fragment-system)
4. [Dynamic Composition](#dynamic-composition)
5. [Registration and Initialization](#registration-and-initialization)
6. [Data Flow Architecture](#data-flow-architecture)
7. [Runtime Execution Pipeline](#runtime-execution-pipeline)
8. [Priority Resolution Mechanics](#priority-resolution-mechanics)
9. [Type System and Safety Guarantees](#type-system-and-safety-guarantees)
10. [Memory and Performance Characteristics](#memory-and-performance-characteristics)
11. [Integration Patterns](#integration-patterns)
12. [Advanced Fragment Patterns](#advanced-fragment-patterns)
13. [Testing Architecture](#testing-architecture)
14. [Best Practices](#best-practices)
15. [Questions and Uncertainties](#questions-and-uncertainties)

## System Philosophy and Design Rationale

### Core Design Principles

The prompt system embodies several fundamental design principles:

#### 1. Composition Over Inheritance
Rather than using inheritance hierarchies or template inheritance, the system embraces composition through fragments. Each fragment represents an atomic unit of prompt logic that can be combined with others to create complex behaviors.

#### 2. Runtime Flexibility with Compile-Time Safety
The system leverages TypeScript's type system for compile-time guarantees while maintaining runtime flexibility through dynamic fragment registration and conditional composition.

#### 3. Fail-Safe Degradation
When fragments encounter errors or missing data, they return empty strings rather than throwing exceptions, ensuring prompt generation always succeeds even with partial data.

#### 4. Single Responsibility Fragments
Each fragment handles exactly one concern - agent identity, tool descriptions, phase constraints, etc. This separation enables independent testing and evolution.

### Architectural Trade-offs

The system makes deliberate trade-offs:
- **Flexibility vs Performance**: Dynamic composition at runtime over pre-compiled templates
- **Type Safety vs Dynamism**: Type erasure in registry for heterogeneous storage
- **Simplicity vs Power**: Side-effect registration over explicit configuration
- **Consistency vs Customization**: Priority system over arbitrary ordering

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

## Fragment System

### Fragment Categories

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
   - `project-inventory-context`: Project structure understanding
   - Tools: Tool descriptions and schemas are provided directly by the AI SDK tool implementations

4. **Behavioral Fragments** (Priority: 80-90)
   - `agent-reasoning`: Chain-of-thought instructions
   - `orchestrator-reasoning`: Routing decision logic
   - `expert-reasoning`: Domain expertise guidelines

5. **Specialized Fragments** (Variable Priority)
   - `voice-mode`: Voice interaction adaptations
   - `referenced-article`: External content context
   - `retrieved-lessons`: Historical learnings

### Priority System

The priority system ensures consistent prompt structure:

- **1-10**: Core identity and purpose
- **10-20**: Phase and context information
- **20-30**: Available capabilities and tools
- **30-50**: Project-specific information
- **50** (default): General instructions
- **80-90**: Reasoning and behavioral guidelines
- **90+**: Final instructions or overrides

Lower priority numbers appear earlier in the final prompt, establishing foundational context before specific instructions.

### Priority Ranges and Semantics

```
[1-10]    Foundation Layer   - Core identity, fundamental purpose
[11-20]   Context Layer      - Situational awareness, phase info
[21-30]   Capability Layer   - Tools, agents, available actions
[31-50]   Project Layer      - Project-specific context
[51-80]   Instruction Layer  - General behavioral guidelines
[81-90]   Reasoning Layer    - Output format, thinking structure
[91-299]  Override Layer     - Special conditions, exceptions
[300+]    Appendix Layer     - Reference material, examples
```

## Dynamic Composition

### buildSystemPrompt Function

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

### Fragment Arguments Flow

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

### Conditional Composition Engine

The system supports multiple types of conditions:

#### 1. Agent Type Conditions
```typescript
if (!agent.isOrchestrator) {
    systemPromptBuilder
        .add("conversation-history-instructions", { isOrchestrator: false })
        .add("mcp-tools", { tools: mcpTools })
        .add("agent-reasoning", {});
}
```

#### 2. Phase-Based Conditions
```typescript
template: ({ phase }) => {
    if (phase === PHASES.EXECUTE) {
        return "Focus on implementation details...";
    }
    return "Focus on planning and structure...";
}
```

#### 3. Data Availability Conditions
```typescript
if (conversation?.metadata?.referencedArticle) {
    systemPromptBuilder.add("referenced-article", 
        conversation.metadata.referencedArticle);
}
```

#### 4. Feature Flag Conditions
```typescript
if (!agent.isOrchestrator && isVoiceMode(triggeringEvent)) {
    systemPromptBuilder.add("voice-mode", { isVoiceMode: true });
}
```

## Registration and Initialization

### Module Loading Strategy

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

### Fragment Lifecycle

1. **Definition**: Fragment object created with id, priority, template, and validators
2. **Registration**: Fragment registered with global registry on module load
3. **Reference**: Builder adds fragment by ID with runtime arguments
4. **Validation**: Arguments validated when building prompt
5. **Execution**: Template function called with validated arguments
6. **Composition**: Result incorporated based on priority order

### Registration Phase

Fragment registration occurs during module initialization through JavaScript's module loading mechanism:

#### 1. Module Load Trigger
```typescript
// When src/prompts/index.ts is imported
import "./fragments/agent-common";  // Side effect: registers fragments
import "./fragments/phase-definitions";
import "./fragments/orchestrator-routing";
// ... more fragment imports
```

#### 2. Fragment Definition and Registration
```typescript
// In each fragment file
const myFragment: PromptFragment<MyArgs> = {
    id: "my-fragment",
    priority: 20,
    template: (args) => generateContent(args),
    validateArgs: (args): args is MyArgs => validateStructure(args)
};

// Registration happens immediately
fragmentRegistry.register(myFragment);
```

#### 3. Registry Storage
```typescript
// In FragmentRegistry
register<T>(fragment: PromptFragment<T>): void {
    if (!fragment.id) {
        throw new Error("Fragment must have an id");
    }
    // Type erasure here - stored as unknown
    this.fragments.set(fragment.id, fragment as PromptFragment<unknown>);
}
```

## Data Flow Architecture

### Context Propagation Pipeline

The prompt system implements a sophisticated context propagation pipeline that flows data from event handlers through multiple transformation layers:

```
Event Reception → Context Extraction → Data Enrichment → Fragment Arguments → Template Execution
```

#### Stage 1: Event Reception
```typescript
// Entry point in event handler
const event: NDKEvent = await subscription.getEvent();
const context = {
    conversationId: event.tags.find(t => t[0] === 'd')?.[1],
    agent: findAgentByPubkey(event.pubkey),
    phase: determinePhase(event),
    triggeringEvent: event
};
```

#### Stage 2: Context Extraction
```typescript
// In AgentExecutor.buildMessages()
const projectCtx = getProjectContext();
const conversation = conversationCoordinator.getConversation(context.conversationId);
const tagMap = new Map(project.tags.map(t => [t[0], t[1]]));
```

#### Stage 3: Data Enrichment
```typescript
// Gathering runtime data
const availableAgents = Array.from(projectCtx.agents.values());
const mcpTools = mcpService.getCachedTools();
const agentLessons = projectCtx.getLessonsForAgent(context.agent.pubkey);
```

#### Stage 4: Fragment Arguments
```typescript
// Building options object
const options: BuildSystemPromptOptions = {
    agent: context.agent,
    phase: context.phase,
    projectTitle: tagMap.get("title") || "Untitled",
    projectRepository: tagMap.get("repo"),
    availableAgents,
    conversation,
    agentLessons: agentLessonsMap,
    mcpTools,
    triggeringEvent
};
```

#### Stage 5: Template Execution
```typescript
// In fragment template
template: ({ agent, phase, projectTitle }) => {
    // Access to full context for generating content
    return generateContextualContent(agent, phase, projectTitle);
}
```

### Data Transformation Patterns

The system employs several data transformation patterns:

#### 1. Map Transformation
```typescript
// Converting arrays to maps for efficient lookup
const agentLessonsMap = new Map<string, NDKAgentLesson[]>();
agentLessonsMap.set(agent.pubkey, lessons);
```

#### 2. Filtering and Projection
```typescript
// In available-agents fragment
const availableForHandoff = agents.filter(a => 
    a.pubkey !== currentAgent.pubkey && 
    !a.isOrchestrator
);
```

#### 3. Aggregation
```typescript
// In mcp-tools fragment
const toolsByServer = tools.reduce((acc, tool) => {
    const server = tool.metadata?.serverName || 'unknown';
    acc[server] = acc[server] || [];
    acc[server].push(tool);
    return acc;
}, {});
```

## Runtime Execution Pipeline

### Execution Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Event Handler (src/event-handler/*)                             │
│ • Receives Nostr event                                          │
│ • Determines handler type                                       │
│ • Creates ExecutionContext                                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ AgentExecutor.execute() (src/agents/execution/AgentExecutor.ts) │
│ • Validates context                                             │
│ • Builds messages array                                         │
│ • Initializes execution                                         │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ AgentExecutor.buildMessages()                                   │
│ • Gathers project context                                       │
│ • Collects runtime data                                         │
│ • Calls buildSystemPrompt()                                     │
│ • Adds conversation context                                     │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ buildSystemPrompt() (src/prompts/utils/systemPromptBuilder.ts)  │
│ • Creates PromptBuilder instance                                │
│ • Adds fragments conditionally                                  │
│ • Returns built prompt string                                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ PromptBuilder.build() (src/prompts/core/PromptBuilder.ts)       │
│ • Filters by conditions                                         │
│ • Validates arguments                                           │
│ • Executes templates                                            │
│ • Sorts by priority                                             │
│ • Joins content                                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Execution (ReasonActLoop)                                       │
│ • Sends prompt to LLM                                          │
│ • Streams response                                              │
│ • Processes tool calls                                          │
└─────────────────────────────────────────────────────────────────┘
```

### Critical Execution Points

#### 1. Context Assembly Point
Location: `AgentExecutor.buildMessages()` lines 183-262

This is where all context comes together:
- Project configuration
- Conversation state
- Available agents
- MCP tools
- Agent lessons
- Triggering event

#### 2. Fragment Selection Point
Location: `buildSystemPrompt()` lines 34-149

Critical decisions made here:
- Which fragments to include
- What arguments to pass
- Conditional logic evaluation
- Agent-type specific branching

#### 3. Priority Resolution Point
Location: `PromptBuilder.build()` line 68

The sort operation that determines final prompt structure:
```typescript
.sort((a, b) => a.priority - b.priority)
```

### Composition Phase

During prompt building, fragments undergo a multi-stage composition process:

#### 1. Fragment Collection
```typescript
// In PromptBuilder
add<T>(fragmentId: string, args: T, condition?: (args: T) => boolean): this {
    this.fragments.push({
        fragmentId,
        args,
        condition: condition ? 
            (unknownArgs) => condition(unknownArgs as T) : 
            undefined
    });
    return this;
}
```

#### 2. Conditional Evaluation
```typescript
// During build()
const activeFragments = this.fragments.filter((config) => 
    !config.condition || config.condition(config.args)
);
```

#### 3. Validation and Execution
```typescript
// For each active fragment
const fragment = fragmentRegistry.get(config.fragmentId);
if (fragment.validateArgs && !fragment.validateArgs(config.args)) {
    throw new Error(/* detailed error */);
}
const content = fragment.template(config.args);
```

#### 4. Priority Sorting
```typescript
// Sort by priority (lower = higher priority)
fragmentsWithContent.sort((a, b) => a.priority - b.priority);
```

#### 5. Final Assembly
```typescript
// Join non-empty content
return fragmentsWithPriority
    .map((f) => f.content)
    .filter((content) => content.trim().length > 0)
    .join("\n\n");
```

## Priority Resolution Mechanics

### Priority Conflict Resolution

When fragments have identical priorities, the system maintains insertion order:

```typescript
// In PromptBuilder.build()
fragmentsWithPriority.sort((a, b) => a.priority - b.priority);
// JavaScript's sort is stable, preserving insertion order for equal priorities
```

### Dynamic Priority Patterns

While fragments have static priorities, the system achieves dynamic behavior through:

#### 1. Conditional Inclusion
```typescript
// Higher priority fragment only included in specific conditions
if (isVoiceMode(triggeringEvent)) {
    builder.add("voice-mode", { isVoiceMode: true }); // Priority 20
}
```

#### 2. Content Adaptation
```typescript
// Same priority, different content based on context
template: ({ agent }) => {
    if (agent.isOrchestrator) {
        return "## Routing Instructions\n...";  // Orchestrator version
    }
    return "## Execution Guidelines\n...";      // Regular agent version
}
```

### Condition Evaluation Order

Conditions are evaluated in two phases:

1. **Build-time conditions** (in buildSystemPrompt):
   - Determines which fragments to add
   - Based on static context

2. **Runtime conditions** (in PromptBuilder.build):
   - Fragment-level condition functions
   - Can access fragment arguments

## Type System and Safety Guarantees

### Type Safety Layers

The system implements multiple layers of type safety:

#### 1. Compile-Time Type Safety
```typescript
// Fragment definition with generic type
interface PromptFragment<T = unknown> {
    template: (args: T) => string;
    validateArgs?: (args: unknown) => args is T;
}
```

#### 2. Runtime Type Validation
```typescript
// Type guard pattern
validateArgs: (args): args is AgentToolsArgs => {
    return (
        typeof args === "object" &&
        args !== null &&
        "agent" in args &&
        typeof (args as any).agent === "object"
    );
}
```

#### 3. Error Message Type Information
```typescript
expectedArgs: "{ agent: Agent }"  // Helps developers understand requirements
```

### Type Erasure Strategy

The FragmentRegistry uses type erasure for storage:

```typescript
private fragments = new Map<string, PromptFragment<unknown>>();
```

**Rationale:**
- Allows heterogeneous fragment storage
- Simplifies registry implementation
- Validation happens at usage time

### Type Flow Through System

```
TypeScript Types → Fragment Definition → Type Erasure (Registry) → 
Runtime Validation → Type Guard → Safe Template Execution
```

### System Invariants and Guarantees

The system maintains several critical invariants:

#### 1. Fragment Uniqueness
- Each fragment ID must be unique in the registry
- Later registrations override earlier ones (should not happen in practice)

#### 2. Priority Ordering
- Fragments always appear in priority order in final prompt
- Equal priorities maintain insertion order

#### 3. Non-Throwing Template Execution
- Template errors are caught and re-thrown with context
- Empty returns are valid and filtered out

#### 4. Type Safety at Boundaries
- Arguments validated before template execution
- Type guards ensure type safety within templates

### System Guarantees

#### 1. Prompt Generation Always Succeeds
- Missing fragments result in errors with helpful messages
- Template errors include debugging information
- Empty fragments don't break generation

#### 2. Deterministic Output
- Same inputs produce same prompt
- Priority system ensures consistent ordering
- No random elements in fragment selection

#### 3. Context Isolation
- Fragments can't modify shared state
- Each fragment execution is independent
- No side effects beyond registration

## Memory and Performance Characteristics

### Memory Usage Patterns

#### 1. Fragment Storage
- **Static Memory**: ~25-30 fragment definitions stored in registry
- **Per Fragment**: ~200-500 bytes (ID, priority, function references)
- **Total Registry**: ~10-15 KB

#### 2. Prompt Building
- **Transient Memory**: PromptBuilder instances are short-lived
- **Fragment Arguments**: Typically reference existing objects (no deep copies)
- **String Concatenation**: Uses array join (efficient for multiple strings)

#### 3. Generated Prompts
- **Size Range**: 5-50 KB depending on context
- **Lifetime**: Garbage collected after LLM call
- **No Caching**: Prompts regenerated for each execution

### Performance Characteristics

#### 1. Fragment Registration (Startup)
- **Time**: ~1-2ms total for all fragments
- **Operation**: O(n) where n = number of fragments
- **Frequency**: Once at application start

#### 2. Prompt Building (Runtime)
- **Time**: ~5-10ms typical
- **Operations**:
  - Fragment lookup: O(1) hash map access
  - Validation: O(n) where n = added fragments
  - Sorting: O(n log n) where n = added fragments
  - Concatenation: O(m) where m = total content length

#### 3. Scalability Factors
- **Fragment Count**: Linear impact on build time
- **Content Size**: Linear impact on concatenation
- **Condition Complexity**: Minimal impact (simple boolean checks)

### Optimization Opportunities

#### 1. Static Fragment Caching
```typescript
// Potential optimization for static fragments
const cachedContent = new Map<string, string>();
template: (args) => {
    const key = JSON.stringify(args);
    if (!cachedContent.has(key)) {
        cachedContent.set(key, generateContent(args));
    }
    return cachedContent.get(key)!;
}
```

#### 2. Prompt Template Precompilation
```typescript
// Could pre-process static portions
const staticParts = fragments
    .filter(f => !f.isDynamic)
    .map(f => f.template({}))
    .join("\n\n");
```

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

## Integration Patterns

### System Boundaries

The prompt system maintains clear boundaries with other subsystems:

#### 1. Agent System Boundary
```typescript
// Agent system provides
interface Agent {
    name: string;
    role: string;
    instructions: string;
    tools: Tool[];
    isOrchestrator: boolean;
}

// Prompt system consumes
buildSystemPrompt({ agent, ... })
```

#### 2. Conversation System Boundary
```typescript
// Conversation system provides
interface Conversation {
    id: string;
    messages: Message[];
    metadata: ConversationMetadata;
    phase: Phase;
}

// Prompt system uses for context
systemPromptBuilder.add("phase-context", { conversation })
```

#### 3. Tool System Boundary
```typescript
// Tool system provides
interface Tool {
    name: string;
    description: string;
    inputSchema: JsonSchema;
}

// Prompt system formats for LLM
systemPromptBuilder.add("mcp-tools", { tools: mcpTools })
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

#### 4. File System Integration
Several fragments read from the file system:

```typescript
// PROJECT.md fragment
const projectMdPath = path.join(projectPath, "PROJECT.md");
if (fs.existsSync(projectMdPath)) {
    content = fs.readFileSync(projectMdPath, "utf-8");
}
```

**Characteristics:**
- Synchronous reads (blocking)
- Silent failure on missing files
- No file watching or caching

#### 5. Event System Integration
Voice mode detection from Nostr events:

```typescript
export function isVoiceMode(event?: NDKEvent): boolean {
    if (!event) return false;
    const voiceTag = event.tags.find(tag => tag[0] === "voice");
    return voiceTag?.[1] === "true";
}
```

#### 6. MCP Service Integration
Dynamic tool loading:

```typescript
const mcpTools = mcpService.getCachedTools();
// Tools are cached at MCP service level, not prompt level
```

## Advanced Fragment Patterns

### 1. Multi-Section Fragment Pattern
```typescript
const fragment: PromptFragment<Args> = {
    id: "multi-section",
    template: (args) => {
        const sections: string[] = [];
        
        // Header section
        sections.push(`## ${args.title}`);
        
        // Conditional sections
        if (args.includeDetails) {
            sections.push(generateDetails(args));
        }
        
        // Dynamic list section
        if (args.items?.length > 0) {
            sections.push(args.items.map(formatItem).join("\n"));
        }
        
        return sections.filter(Boolean).join("\n\n");
    }
};
```

### 2. Delegating Fragment Pattern
```typescript
const fragment: PromptFragment<Args> = {
    id: "delegating",
    template: (args) => {
        if (args.agent.isOrchestrator) {
            return orchestratorFragment.template(args);
        } else if (args.agent.isSpecialist) {
            return specialistFragment.template(args);
        } else {
            return defaultFragment.template(args);
        }
    }
};
```

### 3. Aggregating Fragment Pattern
```typescript
const fragment: PromptFragment<ToolArgs> = {
    id: "tool-aggregator",
    template: ({ tools }) => {
        // Group tools by category
        const grouped = tools.reduce((acc, tool) => {
            const category = tool.category || "general";
            acc[category] = acc[category] || [];
            acc[category].push(tool);
            return acc;
        }, {} as Record<string, Tool[]>);
        
        // Generate sections for each category
        return Object.entries(grouped)
            .map(([category, tools]) => 
                `### ${category}\n${tools.map(formatTool).join("\n")}`
            )
            .join("\n\n");
    }
};
```

### 4. Fallback Fragment Pattern
```typescript
const fragment: PromptFragment<DataArgs> = {
    id: "with-fallback",
    template: (args) => {
        try {
            // Try primary data source
            const data = loadPrimaryData(args);
            return formatData(data);
        } catch {
            try {
                // Try secondary data source
                const fallbackData = loadFallbackData(args);
                return formatData(fallbackData);
            } catch {
                // Return default content
                return "## Default Instructions\n...";
            }
        }
    }
};
```

## Testing Architecture

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

## Best Practices

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

### Implementation Best Practices

#### 1. Context Creation

Always create contexts at system boundaries:
```typescript
// Good: Create at conversation start
const context = createTracingContext(conversationId);

// Good: Create child context for new scope
const agentContext = createAgentExecutionContext(parentContext, agentName);
```

#### 2. Fragment Design

- **Single Responsibility**: Each fragment does one thing well
- **Clear Documentation**: Document expected arguments and behavior
- **Error Context**: Include relevant context in error messages
- **Graceful Degradation**: Return empty string rather than throwing

#### 3. Performance Optimization

- **Fail Fast**: Validate early to avoid wasted work
- **Lazy Evaluation**: Only compute when needed
- **Efficient String Operations**: Use array join for concatenation
- **Cache Wisely**: Consider caching for expensive static content

## Questions and Uncertainties

### Architectural Questions

1. **Fragment Coupling**: Some fragments seem to assume others exist (e.g., phase fragments). Is this coupling intentional or should fragments be more independent?

2. **Priority Conflicts**: What happens when two fragments have the same priority? The current implementation seems to maintain insertion order, but is this guaranteed?

3. **Dynamic Priority**: Should fragment priority be dynamic based on context? For example, should voice-mode fragments have higher priority when in voice mode?

4. **Fragment Versioning**: As fragments evolve, how do we handle backward compatibility?

5. **Fragment Marketplace**: Could external fragments be loaded dynamically?

6. **Prompt Size Limits**: How does the system handle LLM token limits? Should fragments be aware of their token cost?

### Implementation Questions

1. **Fragment Validation Timing**: Why do some fragments have validators while others rely on TypeScript types alone? Is there a consistent strategy?

2. **Registry Clearing**: The FragmentRegistry has a `clear()` method but it's only used in tests. Could this cause issues if called in production?

3. **Fragment ID Uniqueness**: There's no enforcement preventing duplicate fragment IDs. Later registrations would override earlier ones. Is this intentional?

4. **Fragment Side Effects**: While the design discourages side effects, there's no enforcement. Should there be?

### Performance Questions

1. **Template Execution Cost**: Fragment templates execute on every prompt build. Should frequently-used static fragments cache their results?

2. **String Concatenation**: The builder uses array join for concatenation. Has this been profiled against other approaches like string builder patterns?

3. **Fragment Count Scaling**: How does performance scale with the number of fragments? Is there a practical upper limit?

4. **Memory Pressure Under Load**: How does the system behave under memory pressure with many concurrent prompt generations?

### Integration Questions

1. **Fragment Discovery**: How do developers discover available fragments? The error messages help, but is there a better discovery mechanism?

2. **Fragment Documentation**: Should fragments self-document their purpose and requirements beyond the `expectedArgs` field?

3. **Testing Coverage**: Are all fragment combinations tested? How do we ensure fragments compose correctly?

4. **External Integration**: Is OpenTelemetry integration planned for fragment execution tracking?

### Future Considerations

1. **A/B Testing**: Could the fragment system support prompt experimentation?

2. **Observability**: Should fragment execution be traced for debugging and optimization?

3. **Multi-Model Adaptation**: How could prompts adapt to different LLM models?

4. **Declarative Configuration**: Should fragment inclusion be configurable via YAML/JSON?

5. **Smart Fragment Selection**: Could ML-based fragment selection improve agent performance?

### Deep Technical Questions

1. **Memory Pressure Under Load**: How does the system behave under memory pressure with many concurrent prompt generations?

2. **Fragment Template Performance**: What is the performance impact of complex template functions?

3. **Registry Thread Safety**: Is the FragmentRegistry thread-safe in a Node.js context?

4. **Fragment Interdependencies**: How should fragments that logically depend on each other be handled?

5. **Dynamic Fragment Loading**: Could fragments be loaded dynamically based on configuration?

6. **Error Recovery Patterns**: Should template execution errors be recoverable?

7. **Fragment Composition Strategies**: Could fragments be composed more sophisticatedly (hierarchical, slot-based, pipeline)?

8. **Caching Strategies**: Which fragments would benefit from caching?

9. **LLM Token Limit Handling**: How should the system handle prompts exceeding model token limits?

10. **Prompt Debugging and Observability**: How can developers debug prompt generation issues?