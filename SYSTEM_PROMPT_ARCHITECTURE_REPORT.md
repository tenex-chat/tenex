# System Prompt Architecture Analysis & Restructuring Proposals

## Executive Summary

The TENEX system prompt generation architecture is sophisticated but shows signs of organic growth that has led to complexity and inconsistencies. This report provides a deep analysis of the current system and proposes three restructuring plans ranging from incremental improvements to a complete architectural overhaul.

## Current Architecture Overview

### Core Components

1. **PromptBuilder** (`src/prompts/core/PromptBuilder.ts`)
   - Central orchestrator for assembling prompt fragments
   - Handles fragment prioritization and conditional inclusion
   - Concatenates fragments with proper formatting

2. **FragmentRegistry** (`src/prompts/core/FragmentRegistry.ts`)
   - Singleton pattern for managing all prompt fragments
   - Auto-registration on import
   - Global access to all fragments

3. **System Prompt Builder** (`src/prompts/utils/systemPromptBuilder.ts`)
   - Main entry point: `buildSystemPromptMessages()`
   - Returns array of `SystemMessage` objects with caching metadata
   - Orchestrates fragment assembly for different agent types

4. **ConversationManager** (`src/conversations/ConversationManager.ts`)
   - Injects dynamic conversation context
   - Handles "messages while you were away" blocks
   - Manages phase transitions and instructions

5. **Phase Instructions Builder** (`src/prompts/utils/phaseInstructionsBuilder.ts`)
   - Generates dynamic phase-specific instructions
   - Handles phase transitions
   - Injected as system messages during conversation

## Key Issues Identified

### 1. Multiple Injection Points for Dynamic Content

**Problem**: System prompts are assembled at multiple stages:
- Static fragments in `buildSystemPromptMessages()`
- Dynamic phase instructions in `ConversationManager.buildAgentMessages()` 
- Debug mode injection in `AgentExecutor.buildMessages()`
- Backend-specific additions (e.g., JSON-only instruction in `RoutingBackend`)

**Impact**: Difficult to understand the complete prompt an agent receives without tracing through multiple files.

### 2. Orchestrator Logic Scattered Across Fragments

**Problem**: Many fragments contain `if (isOrchestrator)` conditional logic:
- `agent-system-prompt`
- `conversation-history-instructions`
- `expertise-boundaries`
- Others

**Impact**: Orchestrator-specific behavior is spread across multiple files rather than centralized.

### 3. Inconsistent Dynamic vs Static Content Separation

**Problem**: Some dynamic content is in fragments (e.g., `retrieved-lessons`), while other dynamic content is injected later (e.g., phase instructions, debug mode).

**Impact**: No clear principle for what belongs in a fragment vs what should be injected dynamically.

### 4. Phase Management Complexity

**Problem**: Phase-related prompts are handled in three different places:
- `phase-definitions` fragment (static definitions)
- `phase-context` and `phase-constraints` fragments (removed from main prompt, injected dynamically)
- `buildPhaseInstructions()` for dynamic transitions

**Impact**: Phase logic is fragmented and hard to follow.

### 5. Tool Prompt Fragment Inconsistency

**Problem**: 
- Native tools use manual `promptFragment` strings
- MCP tools dynamically generate from schemas
- No standardized format for tool instructions

**Impact**: Inconsistent tool documentation quality in prompts.

### 6. Caching Strategy Unclear

**Problem**: The `SystemMessage` interface includes caching metadata, but:
- Only PROJECT.md and inventory are marked cacheable
- No clear strategy for what should be cached
- Caching keys don't account for all variables

**Impact**: Potential performance optimizations are not fully realized.

### 7. Message Role Attribution Complexity

**Problem**: `ConversationManager.buildAgentMessages()` has complex logic for:
- Determining message roles (user/assistant/system)
- Attribution of other agents' messages
- Handling "messages while away" blocks

**Impact**: High cognitive load to understand conversation history formatting.

## Restructuring Proposals

### Plan A: Incremental Improvements (Low Risk, 2-3 weeks)

Focus on improving the existing architecture without major breaking changes.

#### Changes:
1. **Centralize Dynamic Injections**
   - Create `DynamicPromptInjector` class
   - Move all dynamic injections (phase, debug, backend-specific) to one place
   - Clear interface for when/what gets injected

2. **Agent Type Profiles**
   - Create `OrchestratorPromptProfile` and `SpecialistPromptProfile`
   - Move type-specific logic from fragments to profiles
   - Fragments become purely content-focused

3. **Standardize Tool Documentation**
   - Create `ToolDocumentationGenerator` interface
   - Implement for both native and MCP tools
   - Consistent format for all tool instructions

4. **Improve Fragment Organization**
   - Group fragments by category (identity, guidelines, tools, context)
   - Clear naming convention (prefix with category)
   - Documentation for each fragment's purpose

5. **Enhanced Caching Strategy**
   - Define clear caching rules
   - Add cache key generation utilities
   - Mark more static content as cacheable

#### Benefits:
- Minimal disruption to existing code
- Gradual migration possible
- Immediate clarity improvements

#### Drawbacks:
- Doesn't address fundamental architectural issues
- Still multiple injection points
- Complexity remains, just better organized

### Plan B: Unified Prompt Pipeline (Medium Risk, 4-6 weeks)

Redesign prompt generation as a single, clear pipeline with defined stages.

#### Architecture:
```typescript
interface PromptPipeline {
  stages: PromptStage[];
  execute(context: PromptContext): SystemMessage[];
}

interface PromptStage {
  name: string;
  priority: number;
  canCache: boolean;
  process(context: PromptContext): PromptContent | null;
}
```

#### Stages:
1. **Identity Stage**: Agent identity and role
2. **Guidelines Stage**: General behavioral guidelines
3. **Project Context Stage**: PROJECT.md, inventory
4. **Tools Stage**: Available tools and instructions
5. **Conversation Stage**: History and context
6. **Phase Stage**: Current phase and transitions
7. **Dynamic Stage**: Runtime injections (debug, etc.)
8. **Backend Stage**: Backend-specific requirements

#### Implementation:
```typescript
// Single entry point for ALL prompt generation
class UnifiedPromptBuilder {
  private pipeline: PromptPipeline;
  
  buildPrompt(context: CompletePromptContext): SystemMessage[] {
    return this.pipeline.execute(context);
  }
}

// All context in one place
interface CompletePromptContext {
  agent: AgentInstance;
  conversation: Conversation;
  phase: Phase;
  triggeringEvent: NDKEvent;
  debugMode: boolean;
  backend: ExecutionBackend;
  // ... all other context
}
```

#### Benefits:
- Single source of truth for prompt generation
- Clear, traceable pipeline
- Easy to add/remove/reorder stages
- Better testability
- Clear caching boundaries

#### Drawbacks:
- Requires significant refactoring
- All consumers need updates
- Risk of regression

### Plan C: Component-Based Architecture (High Risk, 6-8 weeks)

Complete architectural overhaul using a component-based system with dependency injection.

#### Core Concepts:

```typescript
// Prompt components with dependencies
interface PromptComponent {
  id: string;
  dependencies: string[];
  provides: string[];
  render(context: RenderContext): PromptContent;
}

// Component registry with dependency resolution
class PromptComponentRegistry {
  register(component: PromptComponent): void;
  resolve(requirements: string[]): PromptComponent[];
}

// Agent-specific prompt specifications
interface PromptSpecification {
  agentType: "orchestrator" | "specialist";
  requires: string[];
  phases: PhaseSpecification[];
}

// Phase-specific modifications
interface PhaseSpecification {
  phase: Phase;
  add: string[];
  remove: string[];
  modify: ComponentModification[];
}
```

#### Example Usage:
```typescript
// Define what each agent needs
const specialistSpec: PromptSpecification = {
  agentType: "specialist",
  requires: ["identity", "guidelines", "tools", "boundaries"],
  phases: [
    {
      phase: "PLAN",
      add: ["planning-guidelines"],
      remove: ["execution-tools"]
    },
    {
      phase: "EXECUTE", 
      add: ["execution-guidelines", "mcp-tools"],
      remove: ["planning-guidelines"]
    }
  ]
};

// Components declare what they provide
const identityComponent: PromptComponent = {
  id: "agent-identity",
  dependencies: [],
  provides: ["identity"],
  render: (ctx) => generateIdentity(ctx.agent)
};

// Automatic dependency resolution
const builder = new ComponentPromptBuilder(registry);
const messages = builder.build(specialistSpec, context);
```

#### Advanced Features:

1. **Component Composition**
   - Components can depend on other components
   - Automatic ordering based on dependencies
   - Circular dependency detection

2. **Dynamic Component Loading**
   - Load components based on agent configuration
   - Plugin system for custom components
   - Hot-reloading in development

3. **Prompt Versioning**
   ```typescript
   interface VersionedPromptComponent extends PromptComponent {
     version: string;
     compatibleWith: string[];
   }
   ```

4. **Testing Framework**
   ```typescript
   class PromptTestHarness {
     withComponents(components: PromptComponent[]): this;
     withContext(context: Partial<RenderContext>): this;
     assertContains(text: string): this;
     assertOrder(first: string, second: string): this;
   }
   ```

#### Benefits:
- Maximum flexibility and extensibility
- Clear separation of concerns
- Highly testable
- Supports complex agent types
- Future-proof architecture

#### Drawbacks:
- Complete rewrite required
- High complexity initially
- Steep learning curve
- Risk of over-engineering

## Recommendation

**Recommended Approach: Plan B (Unified Prompt Pipeline)**

This provides the best balance of improvement vs risk. It addresses the core issues while maintaining a reasonable implementation timeline.

### Implementation Strategy:

1. **Phase 1** (Week 1-2): Build pipeline infrastructure alongside existing system
2. **Phase 2** (Week 2-3): Migrate fragments to pipeline stages
3. **Phase 3** (Week 3-4): Update consumers to use new pipeline
4. **Phase 4** (Week 4-5): Remove old system
5. **Phase 5** (Week 5-6): Optimization and caching improvements

### Success Metrics:

- Reduced lines of code for prompt generation
- Improved test coverage (target: >80%)
- Faster prompt generation (target: 20% improvement)
- Easier onboarding for new developers
- Clear documentation and examples

## Migration Path

Regardless of chosen plan, migration should follow these principles:

1. **Parallel Implementation**: Build new system alongside old
2. **Feature Flags**: Toggle between old/new per agent
3. **Incremental Migration**: One agent type at a time
4. **Comprehensive Testing**: Full regression suite
5. **Performance Monitoring**: Track metrics before/after
6. **Documentation First**: Update docs before code
7. **Team Review**: Architecture review at each milestone

## Conclusion

The current system prompt architecture, while functional, has accumulated technical debt through organic growth. The proposed restructuring plans offer paths to a more maintainable, performant, and understandable system. Plan B (Unified Prompt Pipeline) offers the best return on investment, providing significant improvements without excessive risk or complexity.