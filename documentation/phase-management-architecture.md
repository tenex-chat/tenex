# Phase Management and Transition Architecture

## Executive Summary

The Phase Management and Transition System is the sophisticated workflow orchestration engine that governs the lifecycle of all conversations in TENEX. This system implements a state machine with seven distinct phases (chat, brainstorm, plan, execute, verification, chores, reflection) that ensure quality, completeness, and learning across all agent interactions. Unlike traditional linear workflows, this architecture enables dynamic phase transitions based on conversation context while enforcing quality gates through mandatory verification and reflection phases. The system uniquely combines phase-aware routing decisions, agent-specific constraints, and orchestrator-driven transitions to maintain coherent progress through complex multi-agent workflows.

## Core Architecture

### System Overview

The phase management system operates as a distributed state machine across multiple layers:

```
┌─────────────────────────────────────────────────────────┐
│                   User Request                           │
│                  (Initial Trigger)                       │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│              Phase Determination Layer                   │
│         (Orchestrator Initial Routing)                   │
│    Analyzes request → Selects starting phase             │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│           Phase Execution Layer                          │
│        (Agent Execution with Constraints)                │
│    Agents operate within phase boundaries                │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│          Phase Transition Layer                          │
│        (Orchestrator Routing Decisions)                  │
│    Validates transitions → Routes to next phase          │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│         Phase Persistence Layer                          │
│       (ConversationManager State)                        │
│    Tracks transitions → Maintains history                │
└──────────────────────────────────────────────────────────┘
```

## Phase Definitions and Characteristics

### The Seven Phases

Each phase serves a specific purpose in the conversation lifecycle:

#### 1. CHAT Phase
- **Purpose**: Requirements gathering and clarification
- **Entry Conditions**: Unclear or ambiguous user requests
- **Key Activities**: 
  - Clarifying user intent
  - Gathering missing context
  - Confirming requirements
- **Exit Criteria**: Requirements are clear and actionable
- **Typical Agents**: project-manager
- **Constraints**: 
  - No codebase analysis
  - No implementation attempts
  - Focus on understanding intent

#### 2. BRAINSTORM Phase
- **Purpose**: Creative exploration and ideation
- **Entry Conditions**: Open-ended questions, "what if" scenarios
- **Key Activities**:
  - Exploring possibilities
  - Generating alternatives
  - Creative problem-solving
- **Exit Criteria**: User explicitly requests transition
- **Typical Agents**: project-manager, domain experts
- **Constraints**:
  - Embrace open-ended discussion
  - No rush to converge on solutions
  - Ask probing questions

#### 3. PLAN Phase
- **Purpose**: Architectural design and planning
- **Entry Conditions**: Complex tasks requiring design decisions
- **Key Activities**:
  - Creating technical specifications
  - Designing system architecture
  - Planning implementation approach
- **Exit Criteria**: Plan is approved and ready for execution
- **Typical Agents**: planner
- **Constraints**:
  - Focus on system design, not implementation
  - Reserved for genuinely complex decisions
  - Must produce actionable plans

#### 4. EXECUTE Phase
- **Purpose**: Implementation and execution
- **Entry Conditions**: Clear, actionable requirements
- **Key Activities**:
  - Writing code
  - Modifying files
  - Running commands
  - Implementing features
- **Exit Criteria**: Implementation complete
- **Typical Agents**: executor
- **Constraints**:
  - Use appropriate tools
  - Focus on delivering requested output
  - Explain key decisions

#### 5. VERIFICATION Phase
- **Purpose**: Functional verification of implemented work
- **Entry Conditions**: Completion of EXECUTE phase
- **Key Activities**:
  - Testing functionality
  - Verifying requirements met
  - Identifying issues
- **Exit Criteria**: Work verified or issues identified
- **Typical Agents**: executor, project-manager
- **Constraints**:
  - Focus on functional aspects
  - Test from user perspective
  - Provide reproducible issue reports

#### 6. CHORES Phase
- **Purpose**: Cleanup and documentation
- **Entry Conditions**: Successful verification
- **Key Activities**:
  - Updating documentation
  - Code formatting
  - Cleaning temporary artifacts
  - Organizing project files
- **Exit Criteria**: Cleanup complete
- **Typical Agents**: executor
- **Constraints**:
  - Focus on recent work
  - Maintain project organization
  - Ensure proper documentation

#### 7. REFLECTION Phase
- **Purpose**: Learning and insight capture
- **Entry Conditions**: Completion of CHORES phase
- **Key Activities**:
  - Recording lessons learned
  - Capturing project-specific insights
  - Identifying patterns
  - Metacognitive analysis
- **Exit Criteria**: All participating agents have reflected
- **Typical Agents**: All agents who participated
- **Constraints**:
  - Each agent reflects ONCE
  - Focus on actionable learnings
  - Avoid trivial lessons
  - Project-specific insights only

## Phase Transition Mechanics

### Valid Transition Paths

The system enforces a directed graph of valid phase transitions:

```typescript
PHASE_TRANSITIONS = {
    CHAT: [EXECUTE, PLAN, BRAINSTORM],
    BRAINSTORM: [CHAT, PLAN, EXECUTE],
    PLAN: [EXECUTE],
    EXECUTE: [VERIFICATION, CHAT],
    VERIFICATION: [CHORES, EXECUTE, CHAT],
    CHORES: [REFLECTION],
    REFLECTION: [CHAT]
}
```

### Transition Decision Logic

Phase transitions are determined by the orchestrator through a sophisticated decision process:

1. **Initial Phase Selection** (src/prompts/fragments/orchestrator-routing.ts:37-70)
   - Analyzes user request semantics
   - Defaults to action (EXECUTE) over discussion (CHAT)
   - Clear requests with action verbs → EXECUTE
   - Complex architectural needs → PLAN
   - Unclear requirements → CHAT
   - Creative exploration → BRAINSTORM

2. **Quality Phase Enforcement** (src/prompts/fragments/orchestrator-routing.ts:71-101)
   - After EXECUTE → Must go to VERIFICATION
   - After VERIFICATION → Must go to CHORES
   - After CHORES → Must go to REFLECTION
   - This sequence ensures quality and learning

3. **Transition Validation** (src/conversations/phases.ts:187-189)
   - System validates all transitions against allowed paths
   - Invalid transitions are rejected
   - Ensures workflow coherence

### Transition State Management

Phase transitions create detailed records for context preservation:

```typescript
interface PhaseTransition {
    from: Phase;              // Previous phase
    to: Phase;                // New phase
    message: string;          // Comprehensive context
    timestamp: number;        // When transition occurred
    agentPubkey: string;      // Initiating agent
    agentName: string;        // Human-readable name
    reason?: string;          // Brief description
    summary?: string;         // State summary for handoff
}
```

## Orchestrator Routing Integration

### Routing Decision Structure

The orchestrator makes phase-aware routing decisions (src/agents/execution/RoutingBackend.ts:18-24):

```typescript
interface RoutingDecision {
    agents: string[];        // Target agent slugs
    phase?: string;         // Target phase (optional)
    reason: string;         // Routing rationale
}
```

### Orchestrator Turn Management

Each routing decision creates an orchestrator turn (src/conversations/ConversationManager.ts:820-854):

1. **Turn Creation**: Unique ID generated for tracking
2. **Agent Routing**: Multiple agents can be routed in parallel
3. **Completion Tracking**: System tracks when all agents complete
4. **Turn Closure**: Marked complete when all expected agents finish

### Phase-Aware Agent Execution

Agents receive phase context that influences their behavior:

1. **Phase Constraints** (src/prompts/fragments/phase.ts:11-26)
   - Each phase has specific constraints
   - Constraints are injected into agent prompts
   - Agents operate within phase boundaries

2. **Phase-Specific Tools** 
   - Some tools are phase-aware (e.g., complete tool)
   - Tool behavior adapts to current phase
   - Phase influences tool availability

## State Persistence and Recovery

### Conversation State Structure

The ConversationManager maintains comprehensive phase state (src/conversations/types.ts:10-28):

```typescript
interface Conversation {
    phase: Phase;                          // Current phase
    phaseStartedAt?: number;              // Phase start timestamp
    phaseTransitions: PhaseTransition[];  // Complete transition history
    orchestratorTurns: OrchestratorTurn[]; // Routing decision history
    // ... other fields
}
```

### Phase Update Process

Phase updates follow a precise sequence (src/conversations/ConversationManager.ts:145-211):

1. **Validation**: Ensure conversation exists
2. **Logging**: Create execution log entry
3. **Transition Record**: Create detailed transition record
4. **State Update**: Update conversation phase if changed
5. **Special Handling**: Clear readFiles on REFLECTION→CHAT
6. **Persistence**: Save updated state

### Recovery Mechanisms

The system can recover phase state from:
- Persistent conversation files
- Event history reconstruction
- Phase transition records
- Orchestrator turn history

## Phase-Driven Agent Behavior

### Agent Phase Awareness

Agents receive phase information through multiple channels:

1. **Execution Context** (src/agents/execution/types.ts:14)
   - Current phase passed in context
   - Previous phase for transition awareness
   - Handoff information for continuity

2. **Prompt Fragments** (src/prompts/fragments/phase-definitions.ts)
   - Phase definitions injected into prompts
   - Phase-specific constraints applied
   - Clear expectations per phase

3. **Tool Behavior** (src/tools/implementations/complete.ts:31-40)
   - Tools adapt to current phase
   - Different completion messages per phase
   - Phase-aware tool descriptions

### Phase-Specific Agent Selection

The orchestrator selects agents based on phase requirements:

- **CHAT/BRAINSTORM**: project-manager for requirements
- **PLAN**: planner for architecture
- **EXECUTE/VERIFICATION/CHORES**: executor for implementation
- **REFLECTION**: All participating agents

## Quality Gates and Enforcement

### Mandatory Phase Sequence

The system enforces quality through mandatory phases:

1. **VERIFICATION After EXECUTE**
   - Ensures all work is tested
   - Catches issues before finalization
   - Provides feedback loop to EXECUTE if needed

2. **CHORES After VERIFICATION**
   - Ensures documentation is updated
   - Maintains project cleanliness
   - Organizes work products

3. **REFLECTION After CHORES**
   - Captures lessons learned
   - Builds institutional knowledge
   - Improves future performance

### Skip Conditions

Quality phases are rarely skipped:
- Only when user explicitly requests quick implementation
- System warns about quality implications
- Default is always to enforce quality phases

## Special Phase Behaviors

### END Agent Mechanism

The system uses a special "END" agent to terminate conversations (src/agents/execution/RoutingBackend.ts:95-110):
- Detected in routing decisions
- Cleanly terminates conversation
- Typically used after REFLECTION phase
- Prevents further agent execution

### Phase Handoffs

Phase transitions can include handoff information:
- Summary of work completed
- Context for receiving agent
- Recent transition detection (30-second window)
- Enables smooth continuity between agents

### Phase-Based Cleanup

Certain phase transitions trigger cleanup:
- REFLECTION→CHAT clears readFiles metadata
- Prevents stale context in new cycles
- Maintains clean state for fresh interactions

## Performance Considerations

### Phase Transition Overhead

- Transitions create database writes
- Multiple persistence operations per transition
- Consider batching in high-throughput scenarios

### Parallel Agent Execution

Within a phase, multiple agents can execute in parallel:
- Orchestrator routes to multiple agents
- Agents work concurrently
- Completions tracked independently
- Turn marked complete when all finish

### Phase History Growth

Long conversations accumulate transition history:
- Each transition adds ~200 bytes
- History used for context and debugging
- Consider pruning strategies for very long conversations

## Integration Points

### Event Handler Integration

Event handlers determine initial phase routing (src/event-handler/reply.ts:124-138):
- Check for recent phase transitions
- Extract handoff information
- Pass phase context to execution

### Tool System Integration

Tools receive phase context for appropriate behavior:
- Complete tool formats messages per phase
- Learn tool activated in REFLECTION
- Tools can check phase for conditional logic

### Prompt System Integration

Phase information flows through prompt construction:
- Phase definitions included in base prompts
- Phase constraints added dynamically
- Phase-specific instructions per agent type

## Edge Cases and Special Handling

### Invalid Agent Routing Recovery

When orchestrator routes to non-existent agent (src/agents/execution/RoutingBackend.ts:165-256):
1. System detects invalid agent slug
2. Sends corrective feedback to orchestrator
3. Records lesson for future reference
4. Re-attempts routing with correction
5. Continues workflow despite error

### Phase Transition Conflicts

When invalid transition attempted:
- System validates against allowed transitions
- Logs error but doesn't crash
- Maintains current phase
- Orchestrator must choose valid transition

### Conversation Without Phases

System handles legacy conversations:
- Defaults to CHAT phase if missing
- Creates phase on first update
- Maintains backward compatibility

## Questions and Uncertainties

### Architectural Questions

1. **Phase Transition Atomicity**: Are phase transitions truly atomic, or can race conditions occur when multiple agents complete simultaneously?

2. **Phase Rollback**: Is there a mechanism to rollback to a previous phase if something goes catastrophically wrong, or is forward-only progression enforced?

3. **Custom Phase Definition**: Can projects define custom phases beyond the seven built-in ones, or is the phase set fixed?

### Implementation Uncertainties

4. **Parallel Phase Execution**: Can multiple phases execute in parallel for different aspects of the same conversation, or is it strictly sequential?

5. **Phase Timeout**: Is there a timeout mechanism for phases that get stuck, particularly in REFLECTION where all agents must complete?

6. **Cross-Conversation Phase Coordination**: How do phases coordinate when multiple related conversations are active simultaneously?

### Behavioral Questions

7. **Phase Skip Authorization**: Who has authority to skip quality phases - just the user, or can agents make this decision?

8. **Phase Metrics**: Are phase durations and transition patterns tracked for optimization, or is this data discarded?

9. **Phase-Specific Model Selection**: Does the LLM model selection vary by phase, or do all phases use the same model configuration?

### Integration Uncertainties

10. **MCP Tool Phase Awareness**: Do MCP-integrated tools receive phase context, and can they influence phase transitions?

11. **Phase Event Emission**: Are phase transitions emitted as Nostr events for external systems to track?

12. **Phase Persistence Granularity**: What happens to in-progress phase work if the system crashes mid-phase?