# Complete Routing System Design & Implementation Plan

## Core Principles

1. **Orchestrator as Silent Router**: Never speaks to users, only routes
2. **Phase Outputs via complete()**: Each phase has defined input/output
3. **Automatic Quality Control**: PLAN and EXECUTE phases include review cycles
4. **Direct Message Passing**: No rephrasing or interpretation by orchestrator
5. **Organic User Communication**: Users see all agent complete() messages naturally

## Phase Flow Architecture

```
User Message → Orchestrator (analyzes, routes)
     ↓
Phase Agent (works, completes)
     ↓
Orchestrator (decides next action)
     ↓
[Continue until all phases complete]
```

## Detailed Phase Behaviors

### CHAT Phase
**Input**: User's raw message  
**Agent**: project-manager  
**Output**: Clear requirements/understanding  

```
Example 1 - Clear Request:
User: "Fix the typo in the login page title"
Orchestrator → project-manager: "Fix the typo in the login page title"
project-manager complete(): "Clear task: Fix typo in login page title"
Orchestrator: Recognizes trivial task → Skip to EXECUTE
```

```
Example 2 - Ambiguous Request:
User: "Make the app faster"
Orchestrator → project-manager: "Make the app faster"
project-manager complete(): "Requirements gathered: User wants performance improvements. Need to identify specific bottlenecks and optimization targets."
Orchestrator: Recognizes need for planning → PLAN phase
```

### PLAN Phase
**Input**: Requirements from CHAT  
**Process**: Plan → Review → Refine (if needed)  
**Output**: Actionable implementation plan  

```
Example Flow:
1. Orchestrator → planner: [requirements from CHAT]
   planner complete(): "Plan: 1) Profile current performance 2) Optimize database queries 3) Add caching layer"

2. Orchestrator analyzes plan, identifies relevant experts
   → @database-expert, @performance-expert: "Review this plan"
   
3. Experts respond:
   database-expert complete(): "Consider connection pooling for step 2"
   performance-expert complete(): "LGTM"
   
4. Orchestrator → planner: "Feedback: Consider connection pooling for step 2"
   planner complete(): "Updated plan: 1) Profile 2) Optimize queries with connection pooling 3) Add caching"
   
5. All satisfied → EXECUTE phase
```

### EXECUTE Phase
**Input**: Plan from PLAN phase (or requirements if skipped PLAN)  
**Process**: Recommendations → Implementation → Review → Fix (if needed)  
**Output**: Completed implementation  

```
Example - With Domain Experts:
1. Pre-work consultation:
   Orchestrator identifies relevant experts from plan
   → @ndkswift, @nostr: "Provide recommendations"
   
   ndkswift complete(): "Use maxAge: 0 for real-time streaming"
   nostr complete(): "Limit relay connections to necessary ones only"

2. Implementation:
   Orchestrator → executor: 
   "<work_on>[plan details]</work_on>
    <recommendations>
    - Use maxAge: 0 for real-time streaming
    - Limit relay connections to necessary ones only
    </recommendations>"
   
   executor complete(): "Implemented: Added streaming with maxAge:0, optimized relay connections"

3. Review:
   Orchestrator → @ndkswift, @project-manager: "Review implementation"
   
   ndkswift complete(): "Issue: Missing error handling for connection failures"
   project-manager complete(): "LGTM"
   
4. Fix cycle:
   Orchestrator → executor: "Feedback: Missing error handling for connection failures"
   executor complete(): "Fixed: Added connection failure handling with retry logic"
   
5. Final review → All satisfied → VERIFICATION
```

### VERIFICATION Phase
**Input**: Implementation details  
**Agent**: project-manager (or dedicated tester)  
**Output**: Functional test results  

```
Example:
Orchestrator → project-manager: [implementation details]
project-manager complete(): "Tested: All features working correctly. Performance improved by 40%."
→ CHORES
```

### CHORES Phase
**Input**: Work summary  
**Agent**: documentation-agent (or similar)  
**Output**: Cleanup/documentation summary  

```
Orchestrator → documentation-agent: [work summary]
documentation-agent complete(): "Updated: API docs, README, and changelog"
→ REFLECTION
```

### REFLECTION Phase
**Input**: Complete conversation history  
**Agent**: lessons-learned-agent  
**Output**: Lessons published as nostr events  

```
Orchestrator → lessons-learned-agent: [full context]
lessons-learned-agent complete(): "Published 3 lessons about performance optimization patterns"
→ Conversation naturally ends
```

## Orchestrator Decision Logic

```typescript
// Pseudo-code for orchestrator's decision making
function onAgentComplete(agent, completion, phase) {
  if (waitingForOthers()) return;
  
  switch(phase) {
    case "chat":
      if (isTrivialTask(completion)) {
        continue({ phase: "execute", agents: ["executor"] });
      } else if (needsPlanning(completion)) {
        continue({ phase: "plan", agents: ["planner"] });
      } else {
        gatherExpertRecommendations();
      }
      break;
      
    case "plan":
      if (!hasBeenReviewed()) {
        const reviewers = findRelevantExperts(completion) || ["project-manager"];
        continue({ agents: reviewers, message: "Review this plan" });
      } else if (hasOnlyApprovals()) {
        gatherExpertRecommendations();
      } else {
        continue({ agents: ["planner"], message: formatFeedback() });
      }
      break;
      
    case "execute":
      if (!hasRecommendations() && shouldGetRecommendations()) {
        const experts = findRelevantExperts();
        continue({ agents: experts, message: "Provide recommendations" });
      } else if (!hasBeenReviewed()) {
        const reviewers = findRelevantExperts() || ["project-manager"];
        continue({ agents: reviewers, message: "Review implementation" });
      } else if (hasOnlyApprovals()) {
        continue({ phase: "verification", agents: ["project-manager"] });
      } else {
        continue({ agents: ["executor"], message: formatFeedback() });
      }
      break;
      
    // Continue for other phases...
  }
}
```

## Implementation Plan

### Phase 1: Core Orchestrator Changes

#### 1.1 Update orchestrator instructions
**Files to modify:**
- `/src/agents/constants.ts` - Ensure proper tool configuration
- `/src/prompts/fragments/orchestrator-routing.ts` - Update routing instructions

#### 1.2 Update orchestrator instructions
**File:** `/src/claude/orchestrator.ts`
```typescript
instructions: `You are a silent router that NEVER communicates with users directly.

CRITICAL RULES:
- You ONLY use the continue() tool - NEVER speak to users
- Pass messages EXACTLY as received - no interpretation or modification
- After receiving complete() from agents, immediately decide next routing
- You are invisible to users - they only see agent outputs

Your ONLY job:
1. Receive user messages when no agent is p-tagged
2. Route to appropriate phase/agent based on content
3. Coordinate review cycles in PLAN and EXECUTE phases
4. Manage phase transitions

Phase routing logic:
- CHAT: Route all new conversations to project-manager first
- Trivial tasks (typos, simple fixes): Can skip from CHAT → EXECUTE
- Complex tasks: CHAT → PLAN → EXECUTE → VERIFICATION → CHORES → REFLECTION
- Each phase must complete before the next begins`
```

#### 1.3 Enhance continue() tool usage
**File:** `/src/prompts/fragments/orchestrator-routing.ts`
```typescript
`When routing to multiple agents:
- For recommendations: "Provide recommendations for: [task description]"
- For reviews: "Review this [plan/implementation]"
- For phase work: Simply forward the previous phase output

Quality control:
- For complex tasks, ensure thorough review through multiple agent interactions
- For simple tasks, use judgment to avoid unnecessary overhead
- If review cycles exceed 3 iterations without progress, consider the task stalled

Expert selection:
- Analyze agent descriptions to identify domain experts
- When in doubt, include more experts rather than fewer
- Always include project-manager as fallback reviewer

Review interpretation:
- "LGTM", "looks good", "no issues" = approval
- Any specific feedback = needs addressing
- Mixed feedback = route back to primary agent with ALL feedback
- If 3+ review cycles occur without progress, auto-complete with unresolved issues summary`
```

### Phase 2: Domain Expert Prompts

#### 2.1 Update expert agent instructions
**Pattern for all domain expert agents:**
```typescript
`When asked for recommendations:
- Provide HIGH-LEVEL guidance within your expertise ONLY
- Focus on best practices and common pitfalls
- Do NOT hallucinate system details or implementation specifics
- Keep recommendations concise and actionable
- Format: "Consider [recommendation] because [reason]"

When asked to review:
- Be SPECIFIC about issues found
- Provide ACTIONABLE feedback with clear reasoning
- Include examples when possible
- If everything looks good, respond with just "LGTM" or "No issues"
- Focus ONLY on your domain of expertise
- Don't review aspects outside your expertise
- If feedback is unclear or needs more context, explicitly state what information is needed

ALWAYS use complete() to return control to orchestrator.`
```

### Phase 3: Completion System Enhancement

#### 3.1 No structural changes needed
The current completion system already works well for this architecture.

### Phase 4: Review Cycle Implementation

#### 4.1 Add review state tracking
**File:** `/src/agents/execution/ReasonActLoop.ts`
- Track which agents have been consulted
- Detect review cycles vs initial work

#### 4.2 Update conversation context
**File:** `/src/conversations/ConversationCoordinator.ts`
- Ensure phase context includes review state
- Pass recommendations to executor properly

### Phase 5: Phase Skip Logic

#### 5.1 Add to orchestrator routing fragment
```typescript
`Phase skipping guidelines:
- Trivial fixes (typos, formatting): CHAT → EXECUTE
- Clear, specific implementation tasks: Can skip PLAN if unambiguous
- User explicitly says "just do X": Respect their directness
- Emergency fixes: Can skip VERIFICATION/CHORES/REFLECTION if critical

Always use judgment - when in doubt, follow full phase sequence.`
```

### Phase 6: Testing & Validation

#### 6.1 Test scenarios to implement:
1. **Simple typo fix** - Should skip most phases
2. **Complex feature** - Full phase sequence with reviews
3. **Failed review** - Multiple review cycles
4. **No experts available** - Fallback to project-manager
5. **Multiple domain overlap** - Multiple experts consulted

#### 6.2 Key test files to update:
- `/src/agents/execution/__tests__/complete-reminder.test.ts`
- `/src/prompts/fragments/__tests__/orchestrator-routing-clarity.test.ts`
- Add new test: `orchestrator-silent-routing.test.ts`

### Rollout Strategy

1. **Phase 1**: Implement orchestrator changes (1 day)
2. **Phase 2**: Update all domain expert prompts (1 day)
3. **Phase 3**: Test with simple scenarios (1 day)
4. **Phase 4**: Test complex review cycles (1 day)
5. **Phase 5**: Fine-tune prompts based on testing (1 day)

### Key Metrics to Track

- Review cycle efficiency (avoid infinite loops)
- Expert selection accuracy
- Phase skip appropriateness
- User satisfaction (implicit through conversation flow)
- Escalation triggers (review cycles exceeding 3 iterations)

### Edge Case Handling

#### Review Stalemates (3+ iterations)
- Auto-complete with a summary of unresolved issues
- Include all feedback received in the summary
- Future enhancement: consider human escalation mechanism

#### Ambiguous Feedback
- Experts should explicitly request clarification if needed
- Use phrases like "Need more context about X to provide useful feedback"
- Avoid vague statements that don't lead to actionable improvements

#### Execution Context Simplification
- Consider consolidating execution context types to reduce complexity
- Ensure consistent context passing throughout the pipeline

This architecture creates a clean, predictable system where the orchestrator truly becomes an invisible router, and all user communication happens organically through agent complete() messages.