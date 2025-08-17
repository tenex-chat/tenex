# PM-Centric Routing Architecture

## Overview

We are fundamentally reimagining how TENEX orchestrates agent collaboration. Instead of a hidden, system-level orchestrator making routing decisions behind the scenes, we're moving to a model where the Project Manager (PM) agent is the visible, intelligent coordinator of all workflows. This shift brings transparency, flexibility, and simplicity to the system.

## The Core Insight

The key realization is that orchestration doesn't need to be a system-level concern. By making the PM the explicit orchestrator, we turn routing decisions into visible parts of the conversation. Users can see why the PM chose a particular workflow, agents can understand the context of their invocation, and the entire system becomes debuggable through conversation history.

## How the New System Works

### The Entry Point

When a user starts a new conversation, the system now follows a simple rule:
- If the user @mentions a specific agent (e.g., "@executor fix the bug"), that agent receives the message directly
- Otherwise, ALL new conversations route to the Project Manager

This means the PM becomes the default entry point for all user interactions. The PM's first job is to understand what the user wants - and critically, the PM can engage in conversation to clarify ambiguous requests rather than immediately delegating.

```
User: "Hey, I have a question"
PM: "I'd be happy to help! What would you like to know about the project?"
User: "How does the authentication work?"
PM: [Might answer directly from project knowledge, or delegate to architect for detailed explanation]
```

### The Phase System: Vocabulary, Not State Machine

We maintain the concept of "phases" (CHAT, PLAN, EXECUTE, VERIFICATION, CHORES, REFLECTION), but these are now **modes of work** rather than rigid states. The PM uses phases as a shared vocabulary that all agents understand, but there are no hardcoded transition rules.

The PM might decide:
- "This is a one-line typo fix" → Skip directly to EXECUTE phase
- "This is a complex feature" → Full workflow: PLAN → EXECUTE → VERIFICATION → CHORES → REFLECTION  
- "User wants to explore ideas" → BRAINSTORM → PLAN → EXECUTE
- "Emergency production fix" → EXECUTE → END (fix now, clean up later)

### Phase Transitions Through Tools

The PM changes phases explicitly using a new `switch_phase` tool:

```typescript
switch_phase("EXECUTE", "Implementing the authentication fix the user requested")
```

This tool call:
1. Updates the conversation's current phase in ConversationManager
2. Provides the "reason" which becomes the goal/context for the next phase
3. Creates an auditable record of why the PM chose this transition

When agents are invoked after a phase switch, ConversationManager injects context:

```
=== CURRENT PHASE: EXECUTE ===
Goal: Implementing the authentication fix the user requested
Your role: Implementation and code changes
Expected outcome: Working authentication system
```

### The Delegation Model: Formal Sub-Tasking with NDKTask Events

Delegation is the universal mechanism for agent collaboration, but it's much more sophisticated than simple message passing. Every delegation creates formal, auditable sub-tasks using NDKTask events (Nostr kind 1934). This provides structure, parallelism, and traceability to all inter-agent collaboration.

#### How Delegation Works

When an agent (the "Delegator") calls the `delegate()` tool with one or more recipients (the "Delegatees"), the system decomposes this into individual, parallel sub-tasks:

1. **Task Creation**: For EACH recipient agent, the system:
   - Creates a new, unique NDKTask event
   - Signs it with the Delegator's key
   - Sets the task content to the delegation request
   - Adds a p-tag for the recipient's pubkey (formal assignment)
   - **Crucially**: Adds an e-tag pointing to the root conversation event (context link)

2. **State Management**: After creating all NDKTask events, the Delegator:
   - Enters a dormant `pendingDelegation` state
   - ConversationManager tracks all taskIds it's waiting for
   - The agent becomes inactive until ALL sub-tasks complete

3. **Parallel Execution**: Each Delegatee:
   - Gets activated by their NDKTask event
   - Works independently and in parallel with other Delegatees
   - Publishes progress updates as replies to their NDKTask (not the main conversation)
   - This isolates "workflow noise" from the main conversation thread

4. **Completion and Return**: When a Delegatee finishes:
   - Calls `complete()` with their results
   - System recognizes this is a sub-task completion
   - Publishes completion as a reply to the NDKTask, p-tagging the Delegator

5. **Re-activation**: The Delegator:
   - Receives each completion reply
   - Updates its `pendingDelegation` state
   - Remains dormant until ALL tasks complete
   - Gets re-activated with a synthesized summary of all responses

#### Visual Example: Parallel Delegation

```
PM creates tasks for multiple agents:
├── NDKTask #1 → Planner
│   - content: "Create implementation plan"
│   - p-tag: planner-pubkey
│   - e-tag: conversation-root
│
├── NDKTask #2 → Architect
│   - content: "Review architecture implications"
│   - p-tag: architect-pubkey
│   - e-tag: conversation-root
│
└── NDKTask #3 → Security Expert
    - content: "Identify security considerations"
    - p-tag: security-pubkey
    - e-tag: conversation-root

[PM enters dormant state, waiting for all 3 tasks]

Parallel execution:
- Planner working on Task #1...
- Architect working on Task #2...
- Security Expert working on Task #3...

Completions arrive (in any order):
- Security Expert completes → PM's state updates (1/3 done)
- Planner completes → PM's state updates (2/3 done)
- Architect completes → PM's state updates (3/3 done)

[PM re-activates with all three responses synthesized]
```

#### The Call Stack with NDKTasks

When delegations are nested, they create a natural task hierarchy:

```
PM delegates to Planner (creates NDKTask #1)
│
└── Planner receives Task #1
    ├── Delegates to Expert A (creates NDKTask #2)
    ├── Delegates to Expert B (creates NDKTask #3)
    └── [Planner goes dormant]
    
    Expert A works on Task #2
    └── Completes → replies to Task #2 → Planner updated
    
    Expert B works on Task #3
    └── Completes → replies to Task #3 → Planner updated
    
    [Planner re-activates with both expert responses]
    └── Completes Task #1 → replies to Task #1 → PM updated

[PM re-activates with Planner's synthesized response]
```

#### Benefits of NDKTask-Based Delegation

1. **Formal Structure**: Each delegation is a first-class task with ID, status, and history
2. **True Parallelism**: Multiple agents work simultaneously without blocking
3. **Audit Trail**: Every sub-task is recorded as a Nostr event
4. **Context Preservation**: e-tags ensure delegatees can access full conversation history
5. **Progress Isolation**: Intermediate updates don't clutter main conversation
6. **Clean Synthesis**: Delegator receives organized summary of all sub-responses

### Phase Leadership: Mini-Orchestrators

The key insight is that when PM delegates to a phase lead (like Planner or Executor), it's not just asking for a deliverable - it's **handing over temporary leadership of that entire phase**. The phase lead becomes a mini-orchestrator with full autonomy to manage their phase's workflow.

#### The Planner as PLAN Phase Orchestrator

When PM delegates planning to the Planner, here's the complete workflow the Planner orchestrates:

**Step 1: PM Initiates Planning**
```
PM: switch_phase("PLAN", "Design secure authentication feature")
PM: delegate(["planner"], "Create comprehensive auth implementation plan")
PM: [Goes dormant, waiting for planner's final output]
```

**Step 2: Planner Gathers Guidelines**
The Planner, now active, analyzes what expertise is needed:
```
Planner: "This involves security and architecture. I need expert input first."
Planner: delegate(["security-expert", "architect"], 
                  "Provide guidelines for auth feature design")
Planner: [Goes dormant, waiting for expert responses]
```

**Step 3: Experts Provide Guidelines (in parallel)**
```
Security Expert: "Use Argon2 hashing, implement rate limiting, require MFA"
Architect: "Separate auth service, use JWTs with short access tokens"
[Both complete back to Planner]
```

**Step 4: Planner Creates Plan**
Planner re-activates with synthesized expert guidelines:
```
Planner: "Now I'll create the plan incorporating all guidelines"
Planner: claude_code("Generate auth plan with: [expert guidelines + requirements]")
[Receives detailed plan from claude_code]
```

**Step 5: Planner Validates Plan**
Before returning to PM, Planner ensures quality:
```
Planner: delegate(["security-expert", "architect"],
                  "Validate this plan: [full plan text]")
Planner: [Goes dormant again]

Security Expert: "LGTM, but add CSRF protection"
Architect: "Approved with minor suggestions"
[Both complete back to Planner]
```

**Step 6: Planner Completes to PM**
```
Planner: [Incorporates final feedback]
Planner: complete("Plan complete and validated by experts: [final plan]")
[Returns control to PM]
```

The entire multi-step planning workflow is **encapsulated within the Planner's execution**, keeping the main conversation clean. The PM only sees the initial delegation and the final, validated plan.

#### The Executor as EXECUTE Phase Orchestrator

The Executor is a sophisticated implementation manager that orchestrates the entire code-review-revise cycle:

**Step 1: PM Initiates Execution**
```
PM: switch_phase("EXECUTE", "Implement Share to Nostr button")
PM: delegate(["executor"], "Implement the Share to Nostr button per plan")
PM: [Goes dormant]
```

**Step 2: Executor's First Action - Always Delegate to claude_code**
```
Executor: [Receives high-level task]
Executor: "My first step is always to pass this to claude_code"
Executor: claude_code("Implement the Share to Nostr button per plan")
Executor: [Goes dormant, waiting for claude_code]
```

**Step 3: claude_code Implements**
```
claude_code: [Creates src/components/ShareButton.tsx]
claude_code: [Updates src/pages/UserProfile.tsx]
claude_code: Returns report: "Created ShareButton component with NDK integration"
[Tool completes back to Executor]
```

**Step 4: Executor Orchestrates Review**
```
Executor: [REACTIVATES with claude_code's report]
Executor: "Implementation done. Need expert review of UI and Nostr integration"
Executor: delegate(["ui-expert", "nostr-expert"], 
                  "Review implementation: [claude_code's report]")
Executor: [Goes dormant, waiting for reviews]
```

**Step 5: Experts Review (in parallel)**
```
UI Expert: "Functional but needs aria-label for accessibility"
Nostr Expert: "NDK call correct but needs try/catch for errors"
[Both complete to Executor]
```

**Step 6: Executor Decides - Loop or Complete**
```
Executor: [REACTIVATES with expert feedback]
Executor: "Reviews require changes. Sending back to claude_code with feedback"
Executor: claude_code("Revise implementation with feedback:
                      - Add aria-label for accessibility
                      - Wrap NDK call in try/catch")
Executor: [Goes dormant again]

[claude_code makes revisions, returns updated report]

Executor: [REACTIVATES]
Executor: delegate(["ui-expert", "nostr-expert"], "Verify fixes: [updated report]")
[Experts approve]

Executor: complete("Implementation complete with all reviews passed:
                   - Share button with accessibility
                   - Error handling for NDK
                   - All expert approvals received")
[Returns control to PM]
```

**Key Points:**
- Executor NEVER implements directly - always delegates to claude_code first
- Executor manages the implementation-review-revise loop
- Executor only completes when all reviews pass
- This keeps implementation quality high without PM involvement

#### Key Principles of Phase Leadership

1. **Full Autonomy**: Phase leads have complete control over their phase workflow
2. **Encapsulation**: Internal delegations and iterations are hidden from PM
3. **Quality Gates**: Phase leads ensure deliverables meet standards before returning
4. **Parallel Work**: Phase leads can delegate to multiple experts simultaneously
5. **Iterative Refinement**: Phase leads can iterate based on feedback without PM involvement
6. **Delegate Intent, Not Implementation**: Phase leads receive high-level goals, not specific implementation details. When PM delegates to Planner or Executor, it passes the user's intent (e.g., "implement password reset"), NOT file paths or code snippets. The specialist agent is responsible for using its tools (analyze, shell, readFile) to discover the necessary implementation details. This boundary ensures specialists own their domain expertise.

### Handling Ambiguity and Context

The PM no longer needs to immediately understand and route every request. It can engage in conversation:

```
User: "Make it better"
PM: "I'd like to help improve things! Could you clarify what aspect you'd like me to focus on? 
     Are you concerned about performance, code quality, user experience, or something else?"
User: "The API is too slow"
PM: "I understand - you're experiencing performance issues with the API. Let me coordinate 
     a performance analysis and optimization workflow."
[PM switches to EXECUTE phase and delegates to executor with full context]
```

### Loop Prevention Through Intelligence

Without the OrchestratorTurnTracker's elaborate routing history, how does PM prevent loops? Through intelligent analysis of the conversation history. The PM's prompt includes instructions to recognize patterns like:

- Same error occurring multiple times
- Agents requesting the same information repeatedly  
- Circular delegation patterns
- Lack of progress despite multiple attempts

When PM detects these patterns, it can:
- Try a different approach
- Engage the user for guidance
- Skip to a different phase
- Bring in different experts

### The Complete Workflow

Here's how a typical feature request flows through the system, showing the full depth of phase leadership:

```
1. USER: "Add password reset functionality"
   ↓
2. PM: [Recognizes this is a feature request needing planning]
   - Calls switch_phase("PLAN", "Design password reset feature")
   - Delegates to Planner: "Create implementation plan for password reset"
   - [PM GOES DORMANT]
   ↓
3. PLANNER TAKES OVER PLAN PHASE:
   
   3a. Planner: "Need expert guidelines first"
       - delegate(["security-expert", "architect"], "Guidelines for password reset?")
       - [PLANNER GOES DORMANT]
   
   3b. Experts work in parallel:
       - Security: "Use time-limited tokens, implement rate limiting..."
       - Architect: "Separate reset service, event-driven flow..."
       - [Both complete to Planner]
   
   3c. Planner: [REACTIVATES with expert responses]
       - claude_code("Create plan with these guidelines: [expert inputs]")
       - Gets detailed plan from Claude
   
   3d. Planner: "Need validation before returning to PM"
       - delegate(["security-expert", "architect"], "Validate plan: [full plan]")
       - [PLANNER GOES DORMANT]
   
   3e. Experts validate:
       - Security: "Add CSRF protection, otherwise good"
       - Architect: "Consider caching strategy for tokens"
       - [Both complete to Planner]
   
   3f. Planner: [REACTIVATES, incorporates feedback]
       - complete("Validated plan ready: [final plan with all feedback]")
   ↓
4. PM: [REACTIVATES with completed plan]
   - Reviews plan output
   - Calls switch_phase("EXECUTE", "Implement password reset functionality")
   - Delegates to Executor: "Implement the password reset feature as planned"
   - [PM GOES DORMANT - Note: PM does NOT specify files or implementation details]
   ↓
5. EXECUTOR TAKES OVER EXECUTE PHASE:
   
   5a. Executor: [First action - always delegate to claude_code]
       - claude_code("Implement the password reset feature as planned")
       - [EXECUTOR GOES DORMANT]
   
   5b. claude_code: [Does all implementation work]
       - Analyzes codebase structure
       - Creates src/services/passwordReset.ts
       - Updates src/models/user.ts with reset token fields
       - Adds endpoints to src/api/auth.routes.ts
       - Returns: "Implemented password reset with token service"
   
   5c. Executor: [REACTIVATES, orchestrates review]
       - "Need security and architecture review"
       - delegate(["security-expert", "architect"], 
                  "Review password reset implementation: [claude_code report]")
       - [EXECUTOR GOES DORMANT]
   
   5d. Experts review in parallel:
       - Security: "Found timing attack in token comparison"
       - Architect: "Extract token service interface for testability"
       - [Both complete to Executor]
   
   5e. Executor: [REACTIVATES, sends back for revision]
       - claude_code("Revise implementation with feedback:
                     - Fix timing attack in token comparison
                     - Extract token service interface")
       - [EXECUTOR GOES DORMANT]
   
   5f. claude_code: [Makes revisions]
       - Implements constant-time comparison
       - Extracts TokenService interface
       - Returns: "Revisions complete"
   
   5g. Executor: [REACTIVATES, final review]
       - delegate(["security-expert", "architect"], "Verify fixes: [revision report]")
       - [EXECUTOR GOES DORMANT]
       - Experts: "All issues resolved"
   
   5h. Executor: [REACTIVATES, completes]
       - complete("Implementation complete with all reviews passed")
   ↓
6. PM: [REACTIVATES with implementation complete]
   - Calls switch_phase("VERIFICATION", "Verify password reset works")
   - Might handle verification itself or delegate to QA expert
   ↓
7. [Continue through CHORES, REFLECTION as needed]
   ↓
8. PM: "Password reset feature successfully implemented and tested!"
```

Note how the main conversation only shows PM's high-level orchestration, while each phase lead manages complex sub-workflows internally. This keeps the conversation clean while ensuring thorough, expert-validated work.

## Implementation Architecture

### What We've Already Done

We've successfully completed the first major step: **Unified Execution Backend**

All agents now use the ReasonActLoop (RAL) execution model. We've:
- Deleted `ClaudeBackend.ts` and `RoutingBackend.ts`
- Removed the `backend` property from agent definitions
- Made `claude_code` available as a tool rather than a backend
- Simplified AgentExecutor to use one consistent execution path

The PM has been given initial workflow coordination responsibilities and access to the `delegate()` tool.

### What Needs to Be Built

#### The switch_phase Tool

We need to create `src/tools/implementations/switch_phase.ts`:

```typescript
const switchPhaseSchema = z.object({
    phase: z.enum(["CHAT", "BRAINSTORM", "PLAN", "EXECUTE", "VERIFICATION", "CHORES", "REFLECTION"]),
    reason: z.string().describe("The goal or purpose of entering this phase")
});

export const switchPhaseTool = createToolDefinition({
    name: "switch_phase",
    description: "Switch the conversation to a new phase",
    schema: switchPhaseSchema,
    execute: async (input, context) => {
        const { phase, reason } = input.value;
        
        // Update conversation phase
        await context.conversationManager.updatePhase(
            context.conversationId,
            phase,
            reason,
            context.agent.pubkey,
            context.agent.name,
            reason
        );
        
        return success({
            message: `Switched to ${phase} phase`,
            phase,
            reason
        });
    }
});
```

This tool will be exclusive to the PM - added only to its toolset.

#### NDKTask-Based Delegation Implementation

The `delegate()` tool needs to be enhanced to create formal NDKTask events:

```typescript
// In delegate tool execute function
for (const recipientPubkey of resolvedPubkeys) {
    // Create a new NDKTask for this specific recipient
    const task = new NDKTask(ndk);
    task.content = fullRequest;
    task.tags = [
        ["p", recipientPubkey],  // Assign to this agent
        ["e", conversationRootEvent.id, "", "root"],  // Link to conversation
        ["status", "pending"],
    ];
    
    // Sign and publish the task
    await task.sign(context.agent.signer);
    await task.publish();
    
    // Track this task in pendingDelegation state
    pendingTasks.set(task.id, {
        recipientPubkey,
        status: "pending",
        createdAt: Date.now()
    });
}

// Update agent state to track all pending tasks
await context.conversationManager.updateAgentState(
    context.conversationId,
    context.agent.slug,
    {
        pendingDelegation: {
            taskIds: Array.from(pendingTasks.keys()),
            tasks: pendingTasks,
            originalRequest: fullRequest,
            timestamp: Date.now(),
        }
    }
);
```

The `complete()` tool needs to detect if it's completing a sub-task:

```typescript
// In handleAgentCompletion
if (context.triggeringEvent?.kind === NDKKind.Task) {
    // This is a sub-task completion
    const completionReply = new NDKEvent(ndk);
    completionReply.content = response;
    completionReply.tags = [
        ["e", context.triggeringEvent.id, "", "reply"],  // Reply to the task
        ["p", context.triggeringEvent.pubkey],  // Notify the delegator
        ["status", "complete"],
    ];
    await completionReply.sign(agent.signer);
    await completionReply.publish();
} else {
    // Regular conversation completion (existing logic)
}
```

#### Task-Scoped Claude Code Session Management

To support intelligent, iterative refinement of code, the `claude_code` session is scoped to the agent's current NDKTask, not the entire conversation. This ensures that when an agent gets feedback and re-invokes `claude_code`, it's iterating within the same context.

The workflow is as follows:

**1. Session Creation**
On the first call to `claude_code` within an NDKTask, a new Claude Code session is created. The resulting `sessionId` is immediately persisted to that agent's `AgentState` in the ConversationManager:

```typescript
// In claude_code tool execute function
const result = await claudeCodeSDK.execute(prompt);
if (result.sessionId && !context.claudeSessionId) {
    // First call - persist the new session ID
    await context.conversationManager.updateAgentState(
        context.conversationId,
        context.agent.slug,
        { claudeSessionId: result.sessionId }
    );
}
```

**2. Session Retrieval**
Before any subsequent tool call, the AgentExecutor reads the agent's current state. If a `claudeSessionId` exists, it is passed into the ExecutionContext:

```typescript
// In AgentExecutor.execute()
const agentState = conversation?.agentStates.get(context.agent.slug);
const claudeSessionId = agentState?.claudeSessionId;

const fullContext: ExecutionContext = {
    ...context,
    claudeSessionId, // Pass existing session if available
};
```

**3. Session Resumption**
When the agent calls `claude_code` again for revisions, the tool receives the `sessionId` from the context and passes it to the Claude Code SDK, successfully resuming the session with full context:

```typescript
// In claude_code tool
const sessionId = context.claudeSessionId; // From ExecutionContext
const result = await claudeCodeSDK.execute(prompt, { sessionId });
// Claude Code now has full context of previous implementation
```

**4. Session Cleanup**
When an agent calls `complete()`, signaling the end of its work on that NDKTask, the completionHandler is responsible for clearing the `claudeSessionId` from the agent's state. This ensures the agent starts fresh on its next delegated task:

```typescript
// In handleAgentCompletion
if (context.triggeringEvent?.kind === NDKKind.Task) {
    // Clear the Claude session as task is complete
    await context.conversationManager.updateAgentState(
        context.conversationId,
        context.agent.slug,
        { claudeSessionId: null }
    );
}
```

This scoping ensures:
- Each NDKTask gets its own isolated Claude Code session
- Revisions within a task maintain full context
- No session bleed between different tasks
- Clean slate for each new delegation

#### Task Activation and Response Synthesis

The event handler needs to recognize and route NDKTask events:

```typescript
// In event handler
case NDKKind.Task:
    const task = NDKTask.from(event);
    const assignedAgent = findAgentByPubkey(task.assignee);
    
    if (assignedAgent) {
        // Activate the agent with the task
        await agentExecutor.execute({
            agent: assignedAgent,
            conversationId: task.rootEventId,  // From e-tag
            triggeringEvent: task,
            isSubTask: true,
            // ... other context
        });
    }
    break;
```

When all sub-tasks complete, the system synthesizes responses:

```typescript
// In ConversationManager or AgentExecutor
function checkPendingDelegations(agentState) {
    const pending = agentState.pendingDelegation;
    if (!pending) return;
    
    // Check if all tasks are complete
    const allComplete = pending.taskIds.every(taskId => 
        pending.tasks.get(taskId).status === "complete"
    );
    
    if (allComplete) {
        // Synthesize all responses into a summary
        const synthesis = pending.tasks.map(task => ({
            agent: task.recipientPubkey,
            response: task.completionResponse
        }));
        
        // Re-activate the delegator with synthesized responses
        reactivateAgent(agentState.agentId, synthesis);
    }
}
```

#### PM Instructions Overhaul

The PM needs comprehensive instructions that include:

1. **Workflow Patterns** - When to use which phases
2. **Routing Logic** - Transferred from the old orchestrator prompt
3. **Loop Detection** - How to recognize and break cycles
4. **Completion Detection** - When the user's request has been fulfilled
5. **Ambiguity Handling** - How to engage users for clarification
6. **Task Management** - How to create and track NDKTask delegations
7. **CRITICAL Delegation Boundary**: 
   - **DO NOT** make assumptions about implementation details
   - **DO NOT** specify file paths, function names, or code snippets in delegation requests
   - **DO** pass the user's high-level intent to specialist agents
   - **DO** trust specialists to figure out the "how" and "where"
   - Example: Say "implement user authentication" NOT "modify src/auth/login.ts"

#### Specialist Agent Instructions Update

Specialist agents (Planner, Executor) need updated instructions:

**Executor Instructions - Complete Rewrite:**
```
You are the manager of the implementation phase. Your workflow is a strict, multi-step process:

Step 1: Initial Implementation
- Upon receiving a request from the Project Manager, your ONLY first action is to call the claude_code tool
- Pass the request to claude_code VERBATIM - do not analyze or modify it

Step 2: Orchestrate Review  
- After claude_code returns its report, analyze what was changed
- Determine which expert agents should review the implementation
- Use delegate() to send the report to appropriate experts for feedback

Step 3: Synthesize and Decide
After receiving all expert reviews, you must decide:
a) If work is approved: Call complete() with final implementation report
b) If revisions needed: Do NOT complete(). Instead, call claude_code again with:
   - The original request
   - Clear, synthesized summary of feedback to address

CRITICAL: You must NOT use file system or shell tools directly. Your entire job is to coordinate between claude_code and expert reviewers until implementation is approved.

Your toolset: ["claude_code", "delegate", "complete"] only.
```

**Planner Instructions Addition:**
- "You receive high-level objectives, not implementation details"
- "First gather guidelines from relevant experts via delegation"
- "Use claude_code to generate the actual plan with expert input"
- "Get plan validated by experts before completing back to PM"
- "Your plan should be based on expert consensus, not assumptions"

#### Universal Delegation

Currently only PM has the `delegate()` tool. We need to:
1. Add it to the default toolset in `getDefaultToolsForAgent()`
2. Ensure all agents understand when and how to use it
3. Update agent instructions to include delegation patterns
4. Ensure specialists know they own discovery and implementation details

#### Entry Point Modification

In `handleNewConversation`, we need to change:

```typescript
// OLD: Complex logic to find orchestrator
const orchestratorAgent = projectCtx.getProjectAgent();

// NEW: Simple default to PM
const targetAgent = mentionedAgent || projectCtx.getAgent("project-manager");
```

#### Phase Context Injection

ConversationManager needs to inject phase context into agent prompts:

```typescript
// In buildAgentMessages
if (conversation.phase) {
    messages.push(new Message("system", `
=== CURRENT PHASE: ${conversation.phase} ===
Goal: ${conversation.phaseTransitions[conversation.phaseTransitions.length - 1]?.reason}
Your role: ${getPhaseRoleForAgent(agent, conversation.phase)}
Expected outcome: ${getPhaseExpectations(conversation.phase)}
    `));
}
```

#### Cleanup

We need to remove:
- Orchestrator prompt fragments (`01-orchestrator-identity.ts`, `25-orchestrator-routing.ts`)
- OrchestratorTurnTracker (the workflow narrative system)
- Phase transition validation in PhaseManager
- All references to "orchestrator" throughout the codebase

## Benefits of This Architecture

### Transparency
Every routing decision is visible in the conversation. Users can see the PM's reasoning: "I'm routing this to the executor because it's a simple fix that doesn't require planning."

### Flexibility  
The PM can adapt workflows to context. A critical production bug might skip planning entirely. A complex architectural change might involve multiple rounds of planning and validation.

### Natural Collaboration
Agents work together like a human team would. The executor can ask the architect for clarification. The planner can get input from domain experts. It's peer-to-peer, not hub-and-spoke.

### Simplicity
One execution model (ReasonActLoop), one coordination mechanism (delegation), one source of truth (conversation history). The system is conceptually much simpler.

### Debuggability
When something goes wrong, the entire workflow is visible in the conversation. You can see exactly what the PM decided, why it made that decision, and how agents collaborated.

## Design Tradeoffs

### PM as Single Point of Failure
If the PM fails, the conversation stalls. This is acceptable because:
- PM has the simplest logic (mostly routing decisions)
- PM is less likely to fail than complex agents like executor
- Users can manually recover by @mentioning another agent
- We could add PM health monitoring if needed

### No Concurrent Phases
We explicitly chose not to support concurrent phases. One conversation = one phase at a time. This keeps the mental model simple and avoids complex synchronization issues.

### Loss of Workflow Narrative
The OrchestratorTurnTracker's elaborate narrative system is gone. Instead, PM builds its understanding from conversation history. This is simpler but potentially less structured.

## Migration Path

The beauty of this architecture is that it's largely a simplification. We're not adding complex new systems; we're removing abstraction layers and making the system more direct. The migration can happen incrementally:

1. **Phase 1**: Create switch_phase tool, update PM instructions
2. **Phase 2**: Modify delegation return paths, make delegate() universal
3. **Phase 3**: Update entry points to route to PM
4. **Phase 4**: Remove orchestrator infrastructure
5. **Phase 5**: Update specialist agents for phase leadership

Each phase can be tested independently, reducing risk.

## Conclusion

This architecture transforms TENEX from a system with hidden orchestration to one with transparent, intelligent coordination. The PM becomes a true project manager - understanding context, making decisions, and coordinating the team. Agents become more autonomous, able to collaborate directly when needed. The entire system becomes simpler, more flexible, and more maintainable.

The key insight is that orchestration doesn't need to be magic - it can be a visible, understandable part of the conversation. By making the PM the orchestrator, we align the system architecture with how human teams actually work.