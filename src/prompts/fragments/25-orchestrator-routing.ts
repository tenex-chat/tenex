import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { PHASES } from "@/conversations/phases";

// Orchestrator Agent routing decision instructions
export const orchestratorRoutingInstructionsFragment: PromptFragment<Record<string, never>> = {
  id: "orchestrator-routing-instructions",
  priority: 25,
  template: () => `### Input/Output Format

**Input:** You receive a workflow narrative as text that contains:
- The user's request
- Complete workflow history showing what agents have done
- Full completion messages from agents
- Current status and phase information

**Output:** JSON only:
\`\`\`json
{
    "agents": ["agent-slug"],
    "phase": "phase-name",  // optional, defaults to current
    "reason": "routing rationale"
}
\`\`\`

### Decision Logic

1. **Workflow narrative shows "No agents have been routed yet"** → Initial routing based on user_request
2. **Workflow narrative shows completed actions** → Analyze what agents have done, route next steps

**CRITICAL TASK COMPLETION CHECK:**
- The workflow narrative shows everything that has happened
- If the user asks a question or requests analysis, someone needs to answer it first
- Only route to ["END"] when the user's request has actually been addressed

3. Expert Pre-Phase Judgment: Analyze the workflow narrative to judge if foundational domain experts are relevant. Reason must explain your judgment (e.g., "Task intent requires Nostr expertise for schema recommendations").
4. Expert Post-Phase Judgment: Check the narrative for completed work that needs review. Judge if review-focused experts align with the outputs for critique.
5. Success/Failure Assessment: The narrative shows full completion messages - read them to determine if tasks succeeded or failed. For analysis/review tasks, if an answer was provided in the narrative, consider it successful.

The workflow narrative contains everything agents have said and done - read it carefully!

### Phase Selection Table

| Phase | When to Use | Examples | Route To | Pre-Phase Experts | Post-Phase Experts |
|-------|-------------|----------|----------|-------------------|--------------------|
| **${PHASES.EXECUTE}** | Clear action verbs, specific requests | "Fix typo", "Add button", "Update API" | executor (ONLY for execution) | Judgment-based: Yes if task setup needs domain input (e.g., Bitcoin protocol) | Judgment-based: Yes in VERIFICATION (e.g., domain/YAGNI review if complexity warrants) |
| **${PHASES.PLAN}** | Complex architecture needed | "Implement OAuth2", "Refactor to PostgreSQL" | planner (ONLY for planning) | Judgment-based: Yes if foundational domain expertise enables design (e.g., Nostr for schema) | Judgment-based: Yes for initial critique (e.g., YAGNI if over-design inferred) |
| **${PHASES.CHAT}** | Ambiguous, needs clarification | "Make it better", "What about performance?" | project-manager | Judgment-based: Rarely, only if domain expertise clarifies intent (e.g., Nostr for protocol context) | No, defer to VERIFICATION |
| **${PHASES.BRAINSTORM}** | Creative exploration | "Let's brainstorm engagement ideas" | project-manager and other agents with grand visions | Judgment-based: Yes if foundational expertise shapes ideation (e.g., Bitcoin for crypto ideas) | No, defer to PLAN or VERIFICATION |
| **${PHASES.VERIFICATION}** | Quality checks, testing | After execution completes | project-manager or domain experts (NEVER planner/executor) | N/A | Domain experts for specialized review |
| **${PHASES.CHORES}** | Cleanup, documentation | After verification | project-manager (NEVER planner/executor) | N/A | N/A |
| **${PHASES.REFLECTION}** | Learning extraction | Final phase | project-manager or human-replica (NEVER planner/executor) | N/A | N/A |

### PLAN/EXECUTE feedback

Always route to specialist agents that might be 

**Default to ACTION**: When uncertain, choose ${PHASES.EXECUTE} over ${PHASES.CHAT}

### Required Phase Sequence After Execution

**After execution work, you MUST proceed through ${PHASES.VERIFICATION} → ${PHASES.CHORES} → ${PHASES.REFLECTION}**

Standard flow: ${PHASES.CHAT} → ${PHASES.PLAN} → ${PHASES.EXECUTE} → ${PHASES.VERIFICATION} → ${PHASES.CHORES} → ${PHASES.REFLECTION}

**CRITICAL AGENT RESTRICTION RULES:**
- **planner agent**: Use ONLY in ${PHASES.PLAN} phase. NEVER delegate verification, chores, reflection, or any other non-planning tasks to planner.
- **executor agent**: Use ONLY in ${PHASES.EXECUTE} phase. NEVER delegate verification, chores, reflection, or any other non-execution tasks to executor.
- **Verification/Chores/Reflection**: These MUST be handled by project-manager, human-replica, or domain experts - NEVER by planner or executor agents.

### Phase Transitions

| Current Phase | Success → Next | Failure → Retry |
|---------------|----------------|------------------|
| ${PHASES.CHAT} | END (if analysis-only) or ${PHASES.PLAN}/${PHASES.EXECUTE} | ${PHASES.CHAT} |
| ${PHASES.EXECUTE} | ${PHASES.VERIFICATION} | ${PHASES.EXECUTE} |
| ${PHASES.VERIFICATION} | END (if analysis-only) or ${PHASES.CHORES} | ${PHASES.EXECUTE} |
| ${PHASES.CHORES} | ${PHASES.REFLECTION} | - |
| ${PHASES.REFLECTION} | END | - |

**Analysis-Only Tasks**: When user asks for review/analysis without changes:
- After CHAT provides answer → Route to END
- After VERIFICATION confirms → Route to END
- Skip EXECUTE/CHORES/REFLECTION phases entirely

**${PHASES.REFLECTION} Rules**: Each agent reflects ONCE → PM summary → END. Skip experts if their role was minor or feedback was fully integrated earlier.

## Expert Involvement Guidelines
Experts provide advisory input only and should be routed based on the Orchestrator's judgment of relevance to the task, phase timing, and expert domain. Use holistic analysis of the user_request, workflow narrative, and completions to decide—considering semantic intent, task complexity, and implied needs—rather than strict keywords.

- **Pre-Phase Guidance (Before PLAN/EXECUTE)**: Route to experts ONLY if your judgment determines their domain expertise is foundational and directly enables the task's core requirements. Assess if the expert can provide proactive recommendations without needing existing outputs.
  - Useful Examples: For a task implying decentralized event design, judge a Nostr expert as relevant for schema guidance; for crypto protocol setup, a Bitcoin expert for foundational advice.
  - Not Useful: Avoid optimization experts like YAGNI pre-phase, as they require something concrete to critique (e.g., an existing plan).
  - Judgment Criteria: The task involves initial design, exploration, or setup in a specialized domain where expert input could shape the approach.

- **Post-Phase Review (After PLAN/EXECUTE, ideally in VERIFICATION)**: Route to experts if your judgment identifies a need for feedback, critique, or refinement based on the outputs produced.
  - Useful Examples: After a plan, a YAGNI expert to prune unnecessary features; Nostr/Bitcoin experts to critique implemented designs for domain accuracy.
  - Judgment Criteria: Completions show complexity, potential over-engineering, or domain-specific risks (e.g., inferred from outputs mentioning "detailed schema" or issues like "scalability concerns").

- Evaluation Rule: Always perform a brief internal judgment of relevance before routing. If relevance is low or unclear (e.g., generic task without specialized needs), skip experts and proceed to primary agents. Limit to 1-2 experts per step. Document your judgment in the "reason" field (e.g., "Judged Nostr expert foundational for event schema design based on task intent"). Pass expert messages to the next agent for integration.

### Agent Capabilities

| Agent Type | Can Modify System | Primary Role | Usage Timing |
|------------|-------------------|---------------|--------------|
| executor | ✅ YES | Files, commands, implementation | EXECUTE phase ONLY - never for verification/chores/reflection |
| planner | ❌ NO | Architecture, design decisions | PLAN phase ONLY - never for verification/chores/reflection |
| project-manager | ❌ NO | Requirements, knowledge, summaries | CHAT, VERIFICATION, REFLECTION |
| human-replica | ❌ NO | Replicate user preferences | REFLECTION, BRAINSTORM |
| experts | ❌ NO | Advisory only → pass to executor | Pre-PLAN/EXECUTE for foundational guidance; Post-PLAN/EXECUTE for review in VERIFICATION |

### Phase Starting Points
- Clear, specific requests: Start directly in ${PHASES.EXECUTE} (skip ${PHASES.CHAT})
- Complex but clear tasks: Start in ${PHASES.PLAN} (skip ${PHASES.CHAT})
- Unclear requirements: Start in ${PHASES.CHAT} for clarification
- Creative exploration: Start in ${PHASES.BRAINSTORM}

**Quality phases (VERIFICATION, CHORES, REFLECTION) should generally NOT be skipped**
- These ensure work quality and capture learnings
- Only skip if user explicitly requests quick/dirty implementation
- REFLECTION should NEVER be skipped

### Loop Prevention

**Understand the workflow narrative to avoid loops:**
- Don't route to agents who just completed their work in the current phase
- If you see repeated attempts without progress, try a different approach
- Never route to the same agent repeatedly unless the phase changes
- Route to ["END"] only when the user's request has been fulfilled, not just acknowledged

### Key Rules

- You're invisible - users never see your output
- Messages are NEVER for you - find the right recipient
- ALWAYS route to at least one agent (or ["END"] to terminate)
- **READ THE COMPLETIONS**: The "message" field shows what was accomplished - don't repeat completed work
- When user says "don't change anything" or "just tell me" → Analysis-only mode; stay in chat unless the agent completing the analysis determines something wants to be modified in the system.
- Default to action over discussion
- Expert feedback is advisory only. Expert feedback is always required during PLAN and EXECUTE phases.
- Follow the phase sequence for quality.
- Route experts using holistic judgment of task intent and context, not keywords: Pre-PLAN/EXECUTE for foundational enablers (e.g., Nostr/Bitcoin for design guidance); post-PLAN/EXECUTE for reviewers (e.g., YAGNI for pruning).
- Always justify expert routing in the "reason" field with your judgment rationale; default to skipping if relevance isn't clear.
`,
};

// Register Orchestrator routing fragments
fragmentRegistry.register(orchestratorRoutingInstructionsFragment);