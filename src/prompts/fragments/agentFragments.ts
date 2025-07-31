import type { Agent } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { buildAgentPrompt } from "./agent-common";
import { agentCompletionGuidanceFragment } from "./agent-completion-guidance";

// ========================================================================
// EXECUTION & SYSTEM PROMPT FRAGMENTS
// ========================================================================

// Complete agent system prompt for execution
interface AgentSystemPromptArgs {
    agent: Agent;
    phase: Phase;
    projectTitle: string;
}

export const agentSystemPromptFragment: PromptFragment<AgentSystemPromptArgs> = {
    id: "agent-system-prompt",
    priority: 1,
    template: ({ agent, phase, projectTitle }) => {
        const parts: string[] = [];

        // Orchestrator should not have identity section - it's invisible
        if (agent.isOrchestrator) {
            // Only add instructions for orchestrator, no identity
            if (agent.instructions) {
                parts.push(`## Your Instructions\n${agent.instructions}`);
            }
            
            // Add project context
            if (projectTitle) {
                parts.push(`## Project Context\n- Project Name: "${projectTitle}"`);
            }
        } else {
            // Use shared agent prompt builder for non-orchestrator agents
            parts.push(
                buildAgentPrompt({
                    name: agent.name,
                    role: agent.role,
                    instructions: agent.instructions || "",
                    projectName: projectTitle,
                })
            );
        }

        // Add completion guidance for non-orchestrator agents
        if (!agent.isOrchestrator) {
            const completionGuidance = agentCompletionGuidanceFragment.template({
                phase,
                isOrchestrator: false
            });
            if (completionGuidance) {
                parts.push(completionGuidance);
            }
        }

        return parts.join("\n\n");
    },
};

// ========================================================================
// CONVERSATION & INTERACTION FRAGMENTS
// ========================================================================

// Phase context
interface PhaseContextArgs {
    phase: Phase;
    phaseMetadata?: Record<string, unknown>;
    conversation?: Conversation;
}

export const phaseContextFragment: PromptFragment<PhaseContextArgs> = {
    id: "phase-context",
    priority: 15,
    template: ({ phase, conversation }) => {
        const parts = [`## Current Phase: ${phase.toUpperCase()}`];

        // Add phase-specific context from conversation transitions
        const context = getPhaseContext(phase, conversation);
        if (context) {
            parts.push(context);
        }

        return parts.join("\n\n");
    },
    validateArgs: (args): args is PhaseContextArgs => {
        return (
            typeof args === "object" &&
            args !== null &&
            typeof (args as PhaseContextArgs).phase === "string"
        );
    },
};

// ========================================================================
// HELPER FUNCTIONS
// ========================================================================

function getPhaseContext(phase: Phase, conversation?: Conversation): string | null {
    if (!conversation?.phaseTransitions?.length) {
        return null;
    }

    // Get the most recent transition into this phase
    const latestTransition = conversation.phaseTransitions
        .filter((t) => t.to === phase)
        .sort((a, b) => b.timestamp - a.timestamp)[0];

    if (latestTransition) {
        return `### Context from Previous Phase\n${latestTransition.message}`;
    }

    return null;
}

// Register fragments
fragmentRegistry.register(agentSystemPromptFragment);
fragmentRegistry.register(phaseContextFragment);
