# E2E Testing Architecture - The Original Design

> Status: Design document. The mock LLM service exists under `src/test-utils/mock-llm`, but the end-to-end harness and trace assertions described here are not implemented in this repo.

## Core Philosophy

**The e2e testing infrastructure was designed to test TENEX's multi-agent conversation workflows end-to-end with deterministic, predictable LLM responses.**

Instead of calling real LLM APIs (which are slow, expensive, and non-deterministic), it uses a sophisticated **Mock LLM Service** that returns pre-scripted responses based on conversation context, enabling fast, reliable, and repeatable tests of complex agent interactions.

---

## The Three Pillars

### 1. **Deterministic LLM Mocking**
**Purpose:** Replace real LLM API calls with scripted responses that match conversation context

**Components:**
- `MockLLMService` - LLM service implementation that matches triggers and returns scripted responses
- `MockLLMScenario` - Pre-defined workflows (error-handling, concurrency, state-persistence, etc.)
- `MockLLMResponse` - Individual response with trigger conditions and response content

**How it works:**
```typescript
// Define what triggers a response
{
  trigger: {
    systemPrompt: /You are the executor/i,    // Match system prompt
    userMessage: /implement auth/i,           // Match user input
    agentName: "executor",                    // Match specific agent
    iterationCount: 2,                        // Match 2nd time agent is called
    previousAgent: "test-pm",                 // Match after PM executed
    messageContains: /security/i,             // Match message content
  },
  response: {
    content: "I've fixed the security issues...",
    toolCalls: [{
      name: "continue",
      params: { phase: "verification" }
    }]
  },
  priority: 90  // Higher priority = checked first
}
```

**Why this is powerful:**
- Context-aware: Different responses based on agent, iteration, previous agent, phase
- Workflow simulation: Can script entire multi-turn conversations
- Debugging: Can test edge cases and error conditions easily

### 2. **Execution Tracing**
**Purpose:** Record everything that happens during a conversation flow for assertions

**What gets traced:**
```typescript
interface ExecutionTrace {
  conversationId: string;
  executions: AgentExecutionRecord[];     // Who executed when
  toolCalls: ToolCallRecord[];            // What tools were called
  routingDecisions: RoutingDecision[];    // How orchestrator routed
  agentInteractions: AgentExecutionRecord[]; // Agent-to-agent interactions
}
```

**Example trace:**
```
Execution #1: orchestrator (phase: discovery)
  → Routing: ["executor"] for "execute" phase

Execution #2: executor (phase: execute)
  → Tool: writeContextFile(...)
  → Tool: continue({ phase: "verification" })

Execution #3: orchestrator (phase: execute)
  → Routing: ["test-pm"] for "verification" phase

Execution #4: test-pm (phase: verification)
  → Message: "Security issues found..."
  → Tool: continue({ phase: "execute" })
```

**Why this is powerful:**
- Complete audit trail of agent interactions
- Can assert on execution order, tool calls, phase transitions
- Debug why a workflow failed

### 3. **Workflow Assertions**
**Purpose:** Express test expectations in high-level, readable assertions

**Available assertions:**
```typescript
// Assert agents executed in correct order
assertAgentSequence(trace,
  "orchestrator", "executor", "orchestrator", "test-pm"
);

// Assert phase transitions happened correctly
assertPhaseTransitions(trace,
  "discovery", "execute", "verification"
);

// Assert specific tools were called by an agent
assertToolCalls(trace, "executor",
  "writeContextFile", "shell", "continue"
);

// Assert feedback was propagated between agents
assertFeedbackPropagated(trace,
  "test-pm",      // from agent
  "executor",     // to agent
  "security"      // keyword in feedback
);
```

**Why this is powerful:**
- Tests read like documentation of the workflow
- Easy to understand what the test is validating
- Failures are clear and actionable

---

## The Test Flow

### Setup Phase
```typescript
beforeEach(async () => {
  // 1. Setup test environment
  context = await setupE2ETest([]);

  // 2. Define mock LLM scenario for this test
  const scenario = [
    { trigger: {...}, response: {...}, priority: 100 },
    { trigger: {...}, response: {...}, priority: 90 },
    // ... more responses
  ];

  // 3. Load scenario into mock LLM
  context.mockLLM.addResponses(scenario);
});
```

### Execution Phase
```typescript
it("should complete executor → PM → executor cycle", async () => {
  // 1. Create conversation
  const convId = await createConversation(
    context,
    "Implement authentication"
  );

  // 2. Execute conversation flow
  const trace = await executeConversationFlow(
    context,
    convId,
    "Implement authentication with JWT",
    {
      maxIterations: 20,
      onAgentExecution: (agent, phase) => {
        console.log(`Agent ${agent} executing in ${phase}`);
      }
    }
  );

  // 3. Assert on the trace
  assertAgentSequence(trace,
    "orchestrator", "executor",
    "orchestrator", "test-pm",
    "orchestrator", "executor",
    "orchestrator", "test-pm"
  );

  assertToolCalls(trace, "executor", "continue", "continue");
  assertToolCalls(trace, "test-pm", "continue", "complete");
});
```

### Cleanup Phase
```typescript
afterEach(async () => {
  await cleanupE2ETest(context);
});
```

---

## Key Concepts

### 1. **Orchestrator-First Execution**
Every iteration starts with the orchestrator making routing decisions:

```typescript
while (iteration < maxIterations) {
  // 1. Orchestrator decides which agent(s) to route to
  const orchestratorResult = await executeAgent("orchestrator");
  const routing = extractRoutingDecision(orchestratorResult);

  // 2. Execute target agents
  for (const targetAgent of routing.agents) {
    if (targetAgent === "END") break;
    await executeAgent(targetAgent);
  }

  // 3. Check for phase transitions
  // 4. Record everything in trace
}
```

### 2. **Context-Aware Triggers**
Mock responses can match on rich context:

```typescript
{
  trigger: {
    agentName: "executor",
    iterationCount: 2,           // Second time executor runs
    previousAgent: "test-pm",    // After PM gave feedback
    messageContains: /fix.*security/i,
  },
  response: {
    content: "I've implemented bcrypt hashing, rate limiting, and CSRF tokens",
    toolCalls: [{ name: "continue", params: { phase: "verification" }}]
  }
}
```

This allows the mock to return different responses based on:
- Which agent is being called
- How many times it's been called
- What the previous agent said/did
- What phase we're in
- Message content

### 3. **Iterative Feedback Loops**
Tests can validate multi-round feedback cycles:

```
User → Orchestrator → Executor (implements)
                   ↓
Executor → Orchestrator → PM (finds issues)
                       ↓
PM → Orchestrator → Executor (fixes issues)
                 ↓
Executor → Orchestrator → PM (approves)
```

### 4. **Predefined Scenarios**
Common workflows are packaged as reusable scenarios:

- **error-handling** - Tests error detection and recovery
- **concurrency-workflow** - Tests multiple concurrent conversations
- **state-persistence** - Tests state saves/loads correctly
- **network-resilience** - Tests handling of network issues
- **threading-workflow** - Tests thread-based conversation management

### 5. **Test Environment Isolation**
Each test gets:
- Isolated temp directory
- Fresh conversation coordinator
- Isolated agent registry
- Clean mock LLM state
- Automatic cleanup

---

## The Mock LLM Service Deep Dive

### Trigger Matching Logic
```typescript
// Priority-sorted list of responses
responses = [
  { priority: 120, trigger: {...}, response: {...} },
  { priority: 110, trigger: {...}, response: {...} },
  { priority: 90, trigger: {...}, response: {...} },
];

// On each LLM request:
for (const mockResponse of responses) {
  if (matchesTrigger(mockResponse.trigger, context)) {
    return mockResponse.response;
  }
}

// Fallback
return defaultResponse;
```

### Trigger Conditions
All conditions in a trigger must match:

```typescript
function matchesTrigger(trigger, context): boolean {
  if (trigger.systemPrompt && !matches(context.systemPrompt, trigger.systemPrompt))
    return false;

  if (trigger.userMessage && !matches(context.userMessage, trigger.userMessage))
    return false;

  if (trigger.agentName && context.agentName !== trigger.agentName)
    return false;

  if (trigger.iterationCount && context.iterations[agent] !== trigger.iterationCount)
    return false;

  if (trigger.previousAgent && context.lastAgent !== trigger.previousAgent)
    return false;

  // ... all conditions must pass
  return true;
}
```

### Context Tracking
The mock LLM maintains conversation context:

```typescript
conversationContext: Map<conversationId, {
  lastContinueCaller?: string,      // Who called continue last
  iteration: number,                // Overall iteration count
  agentIterations: Map<agent, number>, // Per-agent iteration counts
  lastAgentExecuted?: string,       // Previous agent
}>
```

---

## Example: Complete Test

```typescript
describe("E2E: Executor-Verification Cycle", () => {
  let context: E2ETestContext;

  beforeEach(async () => {
    context = await setupE2ETest([]);

    // Define the workflow
    const scenario = [
      // Step 1: User request → Orchestrator routes to Executor
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          userMessage: /implement auth/i
        },
        response: {
          content: JSON.stringify({
            agents: ["executor"],
            phase: "execute",
            reason: "Routing to executor for implementation"
          })
        },
        priority: 100
      },

      // Step 2: Executor implements
      {
        trigger: { agentName: "executor", iterationCount: 1 },
        response: {
          content: "Implemented basic auth with plaintext passwords",
          toolCalls: [{
            name: "continue",
            params: { phase: "verification" }
          }]
        },
        priority: 90
      },

      // Step 3: Orchestrator routes to PM
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          previousAgent: "executor"
        },
        response: {
          content: JSON.stringify({
            agents: ["test-pm"],
            phase: "verification",
            reason: "Executor completed, routing to PM for verification"
          })
        },
        priority: 90
      },

      // Step 4: PM finds issues
      {
        trigger: { agentName: "test-pm", iterationCount: 1 },
        response: {
          content: "SECURITY ISSUE: Passwords stored in plaintext!",
          toolCalls: [{
            name: "continue",
            params: { phase: "execute", feedback: "Hash passwords" }
          }]
        },
        priority: 90
      },

      // Step 5: Orchestrator routes back to Executor
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          previousAgent: "test-pm",
          messageContains: /plaintext/i
        },
        response: {
          content: JSON.stringify({
            agents: ["executor"],
            phase: "execute",
            reason: "PM found security issues, routing back to executor"
          })
        },
        priority: 90
      },

      // Step 6: Executor fixes issues
      {
        trigger: { agentName: "executor", iterationCount: 2 },
        response: {
          content: "Implemented bcrypt password hashing",
          toolCalls: [{
            name: "continue",
            params: { phase: "verification" }
          }]
        },
        priority: 90
      },

      // Step 7: Orchestrator routes to PM again
      {
        trigger: {
          systemPrompt: /orchestrator/i,
          previousAgent: "executor",
          messageContains: /bcrypt/i
        },
        response: {
          content: JSON.stringify({
            agents: ["test-pm"],
            phase: "verification",
            reason: "Executor fixed issues, routing to PM for verification"
          })
        },
        priority: 90
      },

      // Step 8: PM approves
      {
        trigger: { agentName: "test-pm", iterationCount: 2 },
        response: {
          content: "All security checks passed!",
          toolCalls: [{
            name: "complete",
            params: { summary: "Auth system approved" }
          }]
        },
        priority: 90
      }
    ];

    context.mockLLM.addResponses(scenario);
  });

  afterEach(async () => {
    await cleanupE2ETest(context);
  });

  it("should complete implement → verify → fix → verify cycle", async () => {
    // Execute
    const convId = await createConversation(context, "Implement auth");
    const trace = await executeConversationFlow(
      context,
      convId,
      "Implement authentication"
    );

    // Assert agent sequence
    assertAgentSequence(trace,
      "orchestrator", // Initial routing
      "executor",     // First implementation
      "orchestrator", // Re-routing
      "test-pm",      // First verification (fails)
      "orchestrator", // Re-routing with feedback
      "executor",     // Fix implementation
      "orchestrator", // Re-routing
      "test-pm"       // Final verification (passes)
    );

    // Assert phase transitions
    assertPhaseTransitions(trace,
      "execute",
      "verification",
      "execute",
      "verification"
    );

    // Assert feedback propagation
    expect(assertFeedbackPropagated(
      trace,
      "test-pm",    // From PM
      "executor",   // To Executor
      "plaintext"   // Keyword in feedback
    )).toBe(true);

    // Assert tool calls
    assertToolCalls(trace, "executor", "continue", "continue");
    assertToolCalls(trace, "test-pm", "continue", "complete");
  });
});
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        E2E Test                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  1. Setup test environment                           │   │
│  │  2. Define mock LLM scenario                         │   │
│  │  3. Execute conversation flow                        │   │
│  │  4. Assert on execution trace                        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    setupE2ETest()                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ • Creates temp directory                             │   │
│  │ • Initializes ConversationCoordinator                │   │
│  │ • Initializes AgentRegistry                          │   │
│  │ • Creates MockLLMService                             │   │
│  │ • Mocks external dependencies (NDK, file system)     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              executeConversationFlow()                      │
│                                                             │
│   while (iteration < maxIterations):                       │
│     1. Execute orchestrator                                │
│        ├─→ MockLLM matches triggers                        │
│        └─→ Returns routing decision                        │
│                                                             │
│     2. For each target agent:                              │
│        ├─→ Execute agent with MockLLM                      │
│        ├─→ Record execution in trace                       │
│        ├─→ Record tool calls in trace                      │
│        └─→ Check for phase transitions                     │
│                                                             │
│     3. Check for END condition                             │
│                                                             │
│     4. Update conversation context                         │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   MockLLMService                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ complete(messages, options):                         │   │
│  │   1. Extract context (agent, iteration, phase)       │   │
│  │   2. Find matching response (priority-sorted)        │   │
│  │   3. Return response { content, toolCalls }          │   │
│  │   4. Update context tracking                         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Triggers:                                                  │
│  • systemPrompt: /pattern/                                  │
│  • userMessage: /pattern/                                   │
│  • agentName: "executor"                                    │
│  • iterationCount: 2                                        │
│  • previousAgent: "test-pm"                                 │
│  • messageContains: /keyword/                               │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   ExecutionTrace                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ • executions: [{agent, phase, message, toolCalls}]   │   │
│  │ • toolCalls: [{agent, tool, arguments}]              │   │
│  │ • routingDecisions: [{agents, phase, reason}]        │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Assertions                               │
│  • assertAgentSequence(trace, ...agents)                    │
│  • assertPhaseTransitions(trace, ...phases)                 │
│  • assertToolCalls(trace, agent, ...tools)                  │
│  • assertFeedbackPropagated(trace, from, to, keyword)       │
└─────────────────────────────────────────────────────────────┘
```

---

## Rebuilding the E2E Test Infrastructure

If this testing infrastructure ever needs to be rebuilt, follow these guidelines to ensure the core principles are maintained.

### 1. **Build the `MockLLMService` First**
This is the cornerstone of the entire system. It must be able to:
- **Accept a scenario** of trigger-response pairs.
- **Match triggers** based on a variety of context attributes (agent name, iteration, message content, etc.).
- **Prioritize matches** to handle overlapping triggers.
- **Return scripted responses**, including both text content and tool calls.
- **Track conversation state** internally to support context-aware triggers.

### 2. **Develop the Test Harness (`setupE2ETest`)**
This harness must create an isolated environment for each test, including:
- A temporary directory for file system operations.
- An instance of the real `ConversationCoordinator` to manage state.
- A real `AgentRegistry` populated with the agents under test.
- The `MockLLMService` to intercept LLM calls.
- Mocks for any external I/O, such as Nostr relays or network requests.

### 3. **Implement the Orchestration Loop (`executeConversationFlow`)**
This function drives the multi-agent conversation, and its responsibilities include:
- Executing the orchestrator agent at the start of each iteration.
- Parsing the orchestrator's routing decisions.
- Executing the designated agents in the correct order.
- Recording every action (agent executions, tool calls, routing decisions) in an `ExecutionTrace`.
- Handling termination conditions, such as a maximum number of iterations or an `END` signal.

### 4. **Create High-Level Assertion Helpers**
To keep tests readable and maintainable, create a suite of assertion functions that operate on the `ExecutionTrace`, such as:
- `assertAgentSequence`: Verifies that agents executed in the expected order.
- `assertPhaseTransitions`: Checks that the workflow moved through the correct phases.
- `assertToolCalls`: Ensures that specific tools were called with the correct parameters.
- `assertFeedbackPropagated`: Confirms that feedback from one agent was received by another.

### 5. **Package Reusable Scenarios**
Define common agent workflows as reusable scenarios that can be imported and used across multiple tests. Good candidates for scenarios include:
- Error handling and recovery.
- Multi-round feedback loops.
- State persistence and resumption.

---

## Key Architectural Principles

This testing architecture is built on a foundation of seven key principles:

1. **Determinism First**: Every test run must produce the exact same result. All sources of non-determinism, especially the LLM, are replaced with predictable mocks.
2. **Context-Aware Mocking**: The mock LLM's responses are not static; they are dynamically chosen based on the full context of the conversation, including which agent is speaking, what has been said before, and how many times the agent has been called.
3. **Comprehensive Traceability**: Every significant event in the workflow is recorded in an `ExecutionTrace`. This provides a complete audit trail that is used for both assertions and debugging.
4. **High-Level, Readable Assertions**: Tests should be easy to read and understand, even for those unfamiliar with the implementation details. Assertions are expressed in terms of the workflow itself (e.g., "the executor was called after the planner").
5. **Strict Test Isolation**: Each test runs in a completely isolated environment, with its own temporary file system, conversation state, and mock LLM scenario. This prevents tests from interfering with one another.
6. **Use Real Components Where Possible**: The system under test should be as close to the production version as possible. We use the real `ConversationCoordinator` and `AgentRegistry`, only mocking the boundaries of the system (the LLM and external I/O).
7. **Clear Mock Boundaries**: Mocks are used sparingly and strategically. We only mock the LLM API and external network requests (e.g., Nostr relays), ensuring that the core logic of the agent coordination system is tested thoroughly.

---

## What Makes This Architecture Powerful

The combination of these principles results in a testing system that is:

- **Fast**: With no real LLM API calls, the entire test suite can run in seconds, enabling rapid feedback during development.
- **Deterministic**: Tests are 100% repeatable, eliminating the frustration of flaky tests that pass or fail unpredictably.
- **Capable of Testing Complex Workflows**: The context-aware mocking allows for the scripting of sophisticated multi-agent, multi-turn interactions that would be impossible to test reliably with a real LLM.
- **Excellent for Edge Cases**: It is easy to simulate error conditions, timeouts, and other unusual situations, ensuring the system is resilient.
- **Highly Debuggable**: When a test fails, the `ExecutionTrace` provides a detailed, step-by-step account of what happened, making it easy to pinpoint the root cause.
- **Maintainable**: Scenarios are reusable, and the high-level assertions make it easy to update tests when the underlying workflow changes.
- **Executable Documentation**: The tests themselves serve as clear, executable documentation of the system's expected behavior.

---

## The Contract

**Input:**
- User message
- Conversation context
- Available agents
- Mock LLM scenario

**Process:**
- Orchestrator routes to agents
- Agents execute (with mock LLM responses)
- Tool calls recorded
- Phase transitions tracked
- Context updated

**Output:**
- ExecutionTrace with full audit trail
- Assertions validate expected behavior

This contract enables testing the **entire multi-agent conversation flow** without any real LLM API calls or external dependencies.
