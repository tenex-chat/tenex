import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import { fragmentRegistry } from "../core/FragmentRegistry";
import type { PromptFragment } from "../core/types";
import { buildAgentPrompt } from "./agent-common";

// ========================================================================
// EXECUTION & SYSTEM PROMPT FRAGMENTS
// ========================================================================

// Complete agent system prompt for execution
interface AgentSystemPromptArgs {
  agent: AgentInstance;
  phase: Phase;
  projectTitle: string;
  projectOwnerPubkey: string;
}

export const agentSystemPromptFragment: PromptFragment<AgentSystemPromptArgs> = {
    id: "agent-system-prompt",
    priority: 1,
    template: ({ agent, phase, projectTitle, projectOwnerPubkey }) => {
        const parts: string[] = [];

        // Orchestrator should not have identity section - it's invisible
        if (agent.isOrchestrator) {
            // Only add instructions for orchestrator, no identity
            if (agent.instructions) {
                parts.push(`## Your Instructions\n${agent.instructions}`);
            }
            
            // Add project context
            const projectContextParts = [];
            if (projectTitle) {
                projectContextParts.push(`- Project Title: "${projectTitle}"`);
            }
            projectContextParts.push(`- Project Owner Pubkey: ${projectOwnerPubkey}`);
            if (projectContextParts.length > 0) {
                parts.push(`## Project Context\n${projectContextParts.join('\n')}`);
            }
        } else {
            // Use shared agent prompt builder for non-orchestrator agents
            parts.push(
                buildAgentPrompt({
                    name: agent.name,
                    role: agent.role,
                    instructions: agent.instructions || "",
                    projectTitle,
                    projectOwnerPubkey,
                })
            );
        }

        // Completion guidance is now injected dynamically with phase transitions
        // so it's not included in the base system prompt

        return parts.join("\n\n");
    },
};

// ========================================================================
// CONVERSATION & INTERACTION FRAGMENTS
// ========================================================================

// Conversation history handling instructions
interface ConversationHistoryInstructionsArgs {
    isOrchestrator: boolean;
}

export const conversationHistoryInstructionsFragment: PromptFragment<ConversationHistoryInstructionsArgs> = {
    id: "conversation-history-instructions",
    priority: 5,
    template: ({ isOrchestrator }) => {
        if (isOrchestrator) {
            return `## Understanding Conversation Context

When you see a "=== MESSAGES WHILE YOU WERE AWAY ===" section, these are HISTORICAL messages provided for context only. These messages have already been processed and acted upon. Do NOT route or act on these messages again - they are only there to help you understand the conversation flow.

CRITICAL ROUTING RULE: Your ONLY responsibility is to process and route the message that appears AFTER the "=== NEW INTERACTION ===" marker. Do not reference historical context for routing decisions or new tasks. If no "=== NEW INTERACTION ===" marker is present, only route based on the most recent user message outside of any historical message sections.`;
        } else {
            return `## Understanding Conversation Context

When you see a "=== MESSAGES WHILE YOU WERE AWAY ===" section, these are HISTORICAL messages provided for your awareness only. These messages have already been handled by other agents or yourself in the past. Do NOT act on these messages - they are only there to help you understand what has happened so far.

CRITICAL EXECUTION RULE: Your ONLY responsibility is to respond to and act on the message that appears AFTER the "=== NEW INTERACTION ===" marker. Do not execute tasks or take actions based on historical context. If no "=== NEW INTERACTION ===" marker is present, only act on the most recent message outside of any historical message sections. Historical context is provided solely to inform your understanding, not to prompt new actions.`;
        }
    },
};

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
fragmentRegistry.register(conversationHistoryInstructionsFragment);
