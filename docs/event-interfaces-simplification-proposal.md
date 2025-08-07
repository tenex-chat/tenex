# Event Interfaces Simplification Proposal

## Current State

The ExecutionLogger system currently defines 10+ granular event interfaces that may be overly complex:

### Current Event Types
- `AgentThinkingEvent` - Tracks agent reasoning
- `AgentDecisionEvent` - Records agent decisions  
- `AgentHandoffEvent` - Logs handoffs between agents
- `PhaseTransitionTriggerEvent` - Captures phase transition triggers
- `PhaseTransitionDecisionEvent` - Records phase transition decisions
- `PhaseTransitionExecutedEvent` - Logs executed phase transitions
- `RoutingAnalysisEvent` - Tracks routing analysis
- `RoutingDecisionEvent` - Records routing decisions
- `ToolExecutionStartEvent` - Logs tool execution starts
- `ToolExecutionCompleteEvent` - Logs tool execution completions

## Analysis

After searching the codebase, most of these event types appear to be:
1. Only used in mock/test code (`agentThinking()`, `routingDecision()` in test-harness.ts)
2. Never actually called in production code
3. Creating unnecessary complexity in the type system

The only events that appear to have actual usage are:
- Phase transitions (used in conversation state tracking)
- Tool execution events (used for logging tool calls)

## Proposed Simplification

### Option 1: Minimal Event System
Reduce to just 3 core event types:

```typescript
interface ExecutionEvent {
    type: "tool" | "phase" | "routing";
    timestamp: Date;
    conversationId: string;
    agent: string;
    details: Record<string, any>;
}

interface ToolEvent extends ExecutionEvent {
    type: "tool";
    toolName: string;
    status: "start" | "complete" | "error";
    args?: any;
    result?: any;
    duration?: number;
}

interface PhaseEvent extends ExecutionEvent {
    type: "phase";
    from: Phase;
    to: Phase;
    reason: string;
}
```

### Option 2: Remove Unused Events
Keep the current structure but remove events that aren't used:
- Remove: `AgentThinkingEvent`, `AgentDecisionEvent`, `RoutingAnalysisEvent`
- Keep: Tool execution events, phase transitions, routing decisions

### Option 3: Generic Event System
Use a single generic event type with discriminated unions:

```typescript
type LogEvent = {
    timestamp: Date;
    conversationId: string;
    agent: string;
} & (
    | { type: "tool_call"; tool: string; args: any; }
    | { type: "tool_result"; tool: string; result: any; duration: number; }
    | { type: "phase_transition"; from: Phase; to: Phase; reason: string; }
    | { type: "routing"; targetAgents: string[]; reason: string; }
);
```

## Recommendation

**Recommended: Option 3 - Generic Event System**

Benefits:
1. Simple, extensible structure
2. Type-safe with discriminated unions
3. Easy to add new event types without changing interfaces
4. Reduces code complexity significantly
5. Maintains all necessary logging capabilities

Implementation steps:
1. Create new simplified event types
2. Update ExecutionLogger to use new types
3. Migrate existing logging calls
4. Remove unused event interfaces
5. Update tests

This would reduce ~200 lines of interface definitions to ~30 lines while maintaining full functionality.