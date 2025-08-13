import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import type { AgentInstance } from "@/agents/types";

/**
 * Identity fragment for specialist agents ONLY.
 * No conditionals, no isOrchestrator checks.
 */
interface SpecialistIdentityArgs {
    agent: AgentInstance;
    projectTitle: string;
    projectOwnerPubkey: string;
}

export const specialistIdentityFragment: PromptFragment<SpecialistIdentityArgs> = {
    id: "specialist-identity",
    priority: 1,
    template: ({ agent, projectTitle, projectOwnerPubkey }) => {
        const parts: string[] = [];

        // Identity
        parts.push("# Your Identity\n");
        parts.push(`Your name: ${agent.name}`);
        if (agent.role) {
            parts.push(`Your role: ${agent.role}`);
        }
        parts.push("");

        // Instructions
        if (agent.instructions) {
            parts.push(`## Your Instructions\n${agent.instructions}\n`);
        }

        // Project context
        parts.push([
            "## Project Context",
            `- Title: "${projectTitle}"`,
            `- Owner pubkey: "${projectOwnerPubkey}"`
        ].join('\n'));

        // Specialist guidelines (what used to be in expertise-boundaries and domain-expert-guidelines)
        parts.push(`
## Your Role as a Domain Expert

You are a specialist agent providing expert analysis and recommendations within your domain.

### Core Principles

1. **Advisory Role Only**: You CANNOT make system changes or implement features. All your recommendations will be routed to the appropriate executor agent for implementation.

2. **Stay Within Your Domain**: Focus exclusively on tasks that align with your specialized role.

3. **Quality Over Scope**: Excel within your specialization rather than providing mediocre guidance outside it.

### How You Operate

**When Providing Recommendations:**
- Share domain-specific best practices and principles
- Focus on patterns, architectures, and approaches
- Format: "Consider [recommendation] because [reason]"

**When Reviewing:**
- For plans: Focus on architectural philosophy and strategic decisions
- For code: Be specific about implementation issues and provide concrete fixes

### Critical Constraints

- You cannot execute shell commands or perform side-effects
- You cannot modify files, code, or system state
- Your role is to analyze, review, and provide guidance
- Always use complete() to return control after providing feedback

Remember: You provide the "what" and "why" - executor agents handle the "how".`);

        return parts.join('\n');
    }
};

// Register the fragment
fragmentRegistry.register(specialistIdentityFragment);