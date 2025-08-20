# Claude Code Integration

## Overview

TENEX integrates Claude Code (Anthropic's code generation and execution model) through two distinct patterns, each serving different use cases and optimizing for different goals.

## Two Patterns of Claude Code Usage

### 1. ClaudeBackend Pattern (Direct Execution)

**Purpose:** Enables direct, efficient execution of Claude Code when the orchestrator determines that an entire agent turn should be handled by Claude.

**How it works:**
- Agents configured with `backend: "claude"` (e.g., Executor, Planner)
- Orchestrator routes directly to the agent
- Agent's entire execution is handled by ClaudeBackend
- No intermediate LLM call needed - the prompt passes through directly to Claude Code

**Benefits:**
- **No extra LLM calls** - Direct pass-through from orchestrator to Claude
- **No translation risk** - The original prompt is preserved exactly
- **Lower cost** - Eliminates redundant LLM invocations
- **Faster execution** - Direct path without intermediary reasoning

**Use cases:**
- When the orchestrator wants Claude to handle a complete task
- For agents whose primary purpose is Claude Code execution (Executor, Planner)
- When the entire agent turn IS the Claude Code execution

### 2. claude_code Tool Pattern (Deliberate Invocation)

**Purpose:** Allows agents using the `reason-act-loop` backend to invoke Claude Code as one step in a multi-step reasoning process.

**How it works:**
- Available as a tool in the tool registry
- **Automatically added to ALL agents using `reason-act-loop` backend** (as of latest update)
- Agents can also explicitly include `"claude_code"` in their tools array
- Agent makes an LLM call to decide when/how to use the tool
- Tool wraps ClaudeTaskOrchestrator for consistent behavior

**Benefits:**
- **Composability** - Claude Code becomes one capability among many
- **Flexibility** - Agents can combine Claude with other tools
- **Deliberate invocation** - The "extra" LLM call is intentional, part of the agent's reasoning
- **Session continuity** - Maintains claudeSessionId across invocations

**Use cases:**
- Specialist agents that need Claude for specific subtasks
- Multi-step workflows where Claude is one component
- When an agent needs to:
  1. Analyze existing code
  2. Use Claude to generate a solution
  3. Validate and integrate the result
  4. Report findings

## Implementation Details

### Shared Core: ClaudeTaskOrchestrator

Both patterns share the same underlying implementation:
- `ClaudeTaskOrchestrator` handles the actual Claude Code execution
- Manages NDKTask lifecycle for auditing and progress tracking
- Uses DelayedMessageBuffer for smooth UI updates
- Tracks execution time for metrics
- Publishes task events to Nostr

### Session Management

Both patterns support session continuity:
- `claudeSessionId` is stored in ConversationManager's agent state
- Sessions can be resumed for iterative development
- Each agent maintains its own session state

### Tool Configuration

The `claude_code` tool accepts:
- `prompt` (required): The prompt for Claude Code
- `systemPrompt` (optional): Additional context or constraints
- `title` (optional): Task title for tracking
- `branch` (optional): Git branch for the task

## When to Use Each Pattern

### Use ClaudeBackend when:
- The agent's primary purpose is Claude Code execution
- You want to minimize LLM calls and costs
- The orchestrator's instructions should pass directly to Claude
- The entire agent turn is dedicated to Claude Code

### Use claude_code Tool when:
- The agent needs Claude as part of a larger workflow
- Multiple tools need to be coordinated
- The agent needs to make decisions about when/how to use Claude
- You're building specialist agents with diverse capabilities

## Example Configurations

### Agent with ClaudeBackend
```typescript
export const EXECUTOR_AGENT = {
    name: "Executor",
    backend: "claude",  // Direct Claude execution
    // ... other configuration
};
```

### Agent with claude_code Tool (Automatic)
```typescript
export const SPECIALIST_AGENT = {
    name: "Code Reviewer",
    backend: "reason-act-loop",  // Default reasoning backend
    tools: [
        "analyze",
        "read_path",
        // claude_code is automatically added for all reason-act-loop agents
        "complete"
    ],
    // ... other configuration
};
```

### Note on Automatic Availability
As of the latest update, the `claude_code` tool is **automatically available** to all agents using the `reason-act-loop` backend. This means:
- Project Manager can use Claude Code for complex analysis
- Specialist agents can leverage Claude Code without explicit configuration
- Any dynamically hired agent with `reason-act-loop` backend gets Claude Code access
- Agents with `backend: "claude"` continue to use the direct ClaudeBackend pattern

## Architecture Benefits

This dual-pattern approach provides:
- **Efficiency** for direct Claude execution scenarios
- **Flexibility** for complex, multi-tool workflows
- **Clear separation of concerns** in the execution model
- **Optimal cost** by avoiding unnecessary LLM calls where not needed
- **Progressive capability** - agents can be configured for either pattern based on their role