# TENEX E2E Testing Framework

## Overview

This document describes the End-to-End (E2E) testing framework for TENEX, which enables comprehensive testing of agent workflows without relying on actual LLM services. The framework uses deterministic mock responses to simulate complete agent interactions, including multi-agent conversations, phase transitions, and tool executions.

## Architecture

### Core Components

1. **Test Harness** (`test-harness.ts`) - Provides the complete test environment setup and execution utilities
2. **Mock LLM Service** - Simulates LLM responses based on predefined triggers
3. **Execution Flow Engine** - Automatically orchestrates multi-agent conversations
4. **Assertion Utilities** - Specialized assertions for validating agent workflows
5. **Execution Tracing** - Comprehensive tracking of all agent interactions

### Key Design Decisions

1. **Deterministic Responses**: All LLM responses are predefined based on configurable triggers
2. **Real Component Integration**: Uses real ConversationManager, AgentRegistry, and tool implementations
3. **Automatic Orchestration**: The framework automatically handles orchestrator routing and agent handoffs
4. **Comprehensive Mocking**: Mocks LLM, Nostr publisher, file system, and other external dependencies
5. **Execution Tracing**: Records every agent execution, phase transition, tool call, and routing decision

## Test Structure

### 1. Setup Phase
```typescript
import { 
    setupE2ETest, 
    cleanupE2ETest,
    createConversation,
    executeConversationFlow,
    type E2ETestContext
} from "./test-harness";

let context: E2ETestContext;

beforeEach(async () => {
    // Setup test environment with optional scenarios
    context = await setupE2ETest([]);
    
    // Define mock LLM responses
    const scenarios = [
        {
            trigger: {
                systemPrompt: /You must respond with ONLY a JSON object/,
                userMessage: /implement authentication/i
            },
            response: {
                content: JSON.stringify({
                    agents: ["executor"],
                    phase: "execute",
                    reason: "Routing to executor for implementation"
                })
            },
            priority: 100
        }
    ];
    
    // Add responses to mock LLM
    scenarios.forEach(s => context.mockLLM.addResponse(s));
});

afterEach(async () => {
    await cleanupE2ETest(context);
});
```

### 2. Execution Phase
```typescript
// Create a conversation
const conversationId = await createConversation(
    context,
    "Task Title",
    "User request content",
    [["additional", "tags"]] // optional
);

// Execute the complete conversation flow automatically
const trace = await executeConversationFlow(
    context,
    conversationId,
    "Initial user message",
    {
        maxIterations: 10,
        onAgentExecution: (agent, phase) => {
            console.log(`Executing ${agent} in ${phase} phase`);
        },
        onPhaseTransition: (from, to) => {
            console.log(`Phase transition: ${from} → ${to}`);
        }
    }
);
```

### 3. Validation Phase
```typescript
// Verify agent execution sequence
assertAgentSequence(trace,
    "orchestrator",
    "executor",
    "orchestrator",
    "project-manager"
);

// Verify phase transitions
assertPhaseTransitions(trace,
    "execute",
    "verification",
    "complete"
);

// Verify tool calls by agent
assertToolCalls(trace, "executor", "continue", "complete");

// Verify feedback propagation
const feedbackPropagated = assertFeedbackPropagated(
    trace,
    "project-manager",  // from agent
    "executor",         // to agent
    "security"          // keyword to find
);
expect(feedbackPropagated).toBe(true);
```

## Mock LLM Response Configuration

### Response Triggers

The mock LLM matches responses based on various trigger conditions:

```typescript
interface MockLLMTrigger {
    // Agent-based triggers
    agentName?: string;              // Match specific agent (e.g., "executor")
    
    // Message content triggers
    systemPrompt?: string | RegExp;  // Match system prompt content
    userMessage?: string | RegExp;   // Match user message content
    messageContains?: string | RegExp; // Match any message content
    
    // Context triggers
    phase?: string;                  // Match conversation phase
    previousAgent?: string;          // Match after specific agent execution
    previousTools?: string[];        // Match after specific tools used
    iterationCount?: number;         // Match on nth execution of agent
}
```

### Response Structure

```typescript
interface MockLLMResponse {
    trigger: MockLLMTrigger;
    response: {
        content: string;             // Text response
        toolCalls?: ToolCall[];      // Optional tool invocations
    };
    priority: number;                // Higher priority checked first
}
```

### Example Scenarios

#### 1. Orchestrator Routing Response
```typescript
{
    trigger: {
        systemPrompt: /You must respond with ONLY a JSON object/,
        userMessage: /implement authentication/i
    },
    response: {
        content: JSON.stringify({
            agents: ["executor"],
            phase: "execute",
            reason: "User wants authentication implemented"
        })
    },
    priority: 100
}
```

#### 2. Agent with Tool Call
```typescript
{
    trigger: {
        agentName: "executor",
        phase: "execute"
    },
    response: {
        content: "I've implemented the authentication system",
        toolCalls: [{
            id: "1",
            type: "function",
            function: {
                name: "continue",
                arguments: JSON.stringify({
                    agents: ["orchestrator"],
                    phase: "verification",
                    reason: "Ready for verification"
                })
            }
        }]
    },
    priority: 90
}
```

#### 3. Iteration-Based Response
```typescript
{
    trigger: {
        agentName: "project-manager",
        iterationCount: 2  // Second time PM is called
    },
    response: {
        content: "All issues resolved, approving implementation",
        toolCalls: [{
            id: "2",
            type: "function",
            function: {
                name: "complete",
                arguments: JSON.stringify({
                    summary: "Task completed successfully"
                })
            }
        }]
    },
    priority: 85
}

```

## Key Features

### executeConversationFlow

The `executeConversationFlow` function is the centerpiece of the E2E framework. It automatically:

1. **Executes the orchestrator** after each agent to determine routing
2. **Parses routing decisions** from orchestrator JSON responses
3. **Executes target agents** based on routing decisions
4. **Handles tool calls** including `continue` and `complete`
5. **Updates conversation phases** based on routing decisions
6. **Tracks everything** in a comprehensive execution trace

### Execution Trace

The execution trace provides complete visibility into the conversation flow:

```typescript
interface ExecutionTrace {
    conversationId: string;
    executions: AgentExecutionRecord[];      // All agent executions
    phaseTransitions: PhaseTransitionRecord[]; // Phase changes
    toolCalls: ToolCallRecord[];             // Tool invocations
    routingDecisions: RoutingDecisionRecord[]; // Orchestrator decisions
}
```

### Available Test Utilities

- `setupE2ETest()` - Initialize test environment with mocked dependencies
- `cleanupE2ETest()` - Clean up test environment
- `createConversation()` - Create a new conversation
- `executeAgent()` - Execute a single agent (manual mode)
- `executeConversationFlow()` - Execute complete conversation flow (automatic)
- `getConversationState()` - Get current conversation state
- `waitForPhase()` - Wait for specific phase transition

### Assertion Helpers

- `assertAgentSequence()` - Verify agents executed in correct order
- `assertPhaseTransitions()` - Verify phase transitions occurred
- `assertToolCalls()` - Verify specific tools were called by agents
- `assertFeedbackPropagated()` - Verify information passed between agents

## Test Patterns

### 1. Complete Workflow Test
```typescript
it("should handle complete authentication implementation", async () => {
    // Setup mock responses for entire flow
    const scenarios = createAuthenticationScenarios();
    scenarios.forEach(s => context.mockLLM.addResponse(s));
    
    // Execute flow
    const trace = await executeConversationFlow(
        context,
        conversationId,
        "Implement secure authentication"
    );
    
    // Verify complete workflow
    assertAgentSequence(trace,
        "orchestrator", "planner",
        "orchestrator", "executor",
        "orchestrator", "project-manager",
        "orchestrator", "executor",  // Fix cycle
        "orchestrator", "project-manager"  // Final approval
    );
});
```

### 2. Feedback Loop Test
```typescript
it("should propagate feedback between agents", async () => {
    const trace = await executeConversationFlow(context, conversationId, message);
    
    // Verify PM feedback reaches executor
    const feedbackPropagated = assertFeedbackPropagated(
        trace,
        "project-manager",
        "executor",
        "security vulnerabilities"
    );
    expect(feedbackPropagated).toBe(true);
    
    // Verify executor addresses feedback
    const executorMessages = trace.executions
        .filter(e => e.agent === "executor")
        .map(e => e.message);
    expect(executorMessages[1]).toContain("fixed security");
});
```

### 3. Phase Transition Test
```typescript
it("should transition through correct phases", async () => {
    const phaseChanges: string[] = [];
    
    const trace = await executeConversationFlow(
        context,
        conversationId,
        "Build feature with testing",
        {
            onPhaseTransition: (from, to) => {
                phaseChanges.push(`${from}->${to}`);
            }
        }
    );
    
    expect(phaseChanges).toContain("plan->execute");
    expect(phaseChanges).toContain("execute->verification");
    expect(phaseChanges).toContain("verification->complete");
});
```

### 4. Error Recovery Test
```typescript
it("should handle agent errors gracefully", async () => {
    // Add error response
    context.mockLLM.addResponse({
        trigger: { agentName: "executor" },
        response: {
            content: "Error: Unable to access database",
            toolCalls: [{
                function: {
                    name: "continue",
                    arguments: JSON.stringify({
                        agents: ["orchestrator"],
                        phase: "error",
                        reason: "Database connection failed"
                    })
                }
            }]
        }
    });
    
    const trace = await executeConversationFlow(context, conversationId, message);
    
    // Verify error handling
    expect(trace.phaseTransitions.some(t => t.to === "error")).toBe(true);
});

```

## Running Tests

```bash
# Run all E2E tests
bun test tests/e2e

# Run specific test file
bun test tests/e2e/executor-verification-flow.test.ts

# Run with debug output (shows mock LLM matching)
DEBUG=true bun test tests/e2e/executor-verification-flow.test.ts

# Run with extended timeout
bun test tests/e2e/executor-verification-flow.test.ts --timeout 30000

# Run tests matching pattern
bun test tests/e2e --test-name-pattern "feedback"
```

## Best Practices

### 1. Mock Response Design
- **Use high priority (90-120)** for specific scenarios
- **Add low priority (1-10)** fallback responses
- **Match on multiple conditions** for precision
- **Use RegExp** for flexible content matching

### 2. Test Organization
```typescript
// Group related scenarios
const authenticationScenarios = [
    orchestratorInitialRouting,
    executorImplementation,
    projectManagerVerification,
    executorFixes,
    projectManagerApproval
];

// Add all at once
authenticationScenarios.forEach(s => context.mockLLM.addResponse(s));
```

### 3. Debugging Failed Tests
```typescript
// Get request history
const history = context.mockLLM.getRequestHistory();
console.log("Requests made:", history.length);

// Examine specific request
const lastRequest = history[history.length - 1];
console.log("Last request:", {
    agent: lastRequest.options?.agentName,
    messages: lastRequest.messages,
    response: lastRequest.response
});
```

### 4. Complex Workflow Testing
```typescript
// Use previousAgent trigger for sequential flows
{
    trigger: {
        systemPrompt: /orchestrator/,
        previousAgent: "executor"  // Only match after executor
    },
    response: {
        content: JSON.stringify({
            agents: ["project-manager"],
            phase: "verification"
        })
    }
}
```

## Mocked Dependencies

The test harness mocks the following modules:

1. **@/lib/fs** - File system operations
2. **@/llm/router** - LLM service routing
3. **@/nostr** - Nostr publisher and NDK
4. **@/agents/AgentPublisher** - Agent profile publishing
5. **@/agents/execution/ClaudeBackend** - Claude Code execution
6. **@/logging/ExecutionLogger** - Execution logging
7. **@/tracing** - Tracing context
8. **@/services/ProjectContext** - Project context

## Available Test Files

Current E2E tests cover various scenarios:

- `executor-verification-flow.test.ts` - Complete verification cycle with feedback
- `orchestrator-workflow.test.ts` - Basic orchestrator routing
- `complete-tool-integration.test.ts` - Tool execution flows
- `state-persistence.test.ts` - Conversation state management
- `concurrency-multiple-conversations.test.ts` - Parallel conversations
- `agent-error-recovery.test.ts` - Error handling scenarios

## Writing New E2E Tests

### Step 1: Define Your Scenario
```typescript
describe("E2E: My Feature", () => {
    let context: E2ETestContext;
    
    beforeEach(async () => {
        context = await setupE2ETest([]);
        
        // Define your mock responses
        const scenarios = [
            // ... your scenarios
        ];
        
        scenarios.forEach(s => context.mockLLM.addResponse(s));
    });
});
```

### Step 2: Execute the Flow
```typescript
it("should handle my feature", async () => {
    const conversationId = await createConversation(
        context,
        "Feature Test",
        "Test my feature"
    );
    
    const trace = await executeConversationFlow(
        context,
        conversationId,
        "Test my feature"
    );
    
    // Assertions...
});
```

### Step 3: Verify Results
```typescript
// Use provided assertions
assertAgentSequence(trace, "orchestrator", "my-agent");
assertPhaseTransitions(trace, "plan", "execute");
assertToolCalls(trace, "my-agent", "my-tool");

// Or custom checks
expect(trace.executions[0].message).toContain("expected text");
expect(trace.routingDecisions[0].toAgents).toContain("my-agent");
```

## Troubleshooting

### Common Issues

1. **"No matching response found"**
   - Enable debug mode: `process.env.DEBUG = 'true'`
   - Check trigger conditions match exactly
   - Verify priority ordering

2. **Unexpected agent sequence**
   - Check orchestrator routing responses
   - Verify `previousAgent` triggers
   - Ensure phase transitions are correct

3. **Tool calls not executing**
   - Verify tool call JSON is valid
   - Check tool name matches exactly
   - Ensure arguments are properly stringified

### Debug Utilities

```typescript
// Enable verbose logging
process.env.DEBUG = 'true';

// Examine mock LLM state
console.log("Request count:", context.mockLLM.getRequestHistory().length);
console.log("Active scenarios:", context.mockLLM.scenarios);

// Track execution flow
const trace = await executeConversationFlow(context, conversationId, message, {
    onAgentExecution: (agent, phase) => {
        console.log(`[EXEC] ${agent} in ${phase}`);
    },
    onPhaseTransition: (from, to) => {
        console.log(`[PHASE] ${from} → ${to}`);
    }
});
```