import type { Agent } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { Tool } from "@/tools/types";
import "@/prompts/fragments/phase-definitions";
import "@/prompts/fragments/referenced-article";
import "@/prompts/fragments/domain-expert-guidelines";

export interface BuildSystemPromptOptions {
    // Required data
    agent: Agent;
    phase: Phase;
    projectTitle: string;
    projectRepository?: string;

    // Optional runtime data
    availableAgents?: Agent[];
    conversation?: Conversation;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    mcpTools?: Tool[];
}

/**
 * Builds the system prompt for an agent using the exact same logic as production.
 * This is the single source of truth for system prompt generation.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const {
        agent,
        phase,
        projectTitle,
        projectRepository = "No repository",
        availableAgents = [],
        conversation,
        agentLessons,
        mcpTools = [],
    } = options;

    // Build system prompt with all agent and phase context
    const systemPromptBuilder = new PromptBuilder()
        .add("agent-system-prompt", {
            agent,
            phase,
            projectTitle,
            projectRepository,
        })
        .add("conversation-history-instructions", {
            isOrchestrator: agent.isOrchestrator || false,
        })
        .add("available-agents", {
            agents: availableAgents,
            currentAgent: agent,
        });

    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        systemPromptBuilder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Add project inventory context only for non-orchestrator agents
    if (!agent.isOrchestrator) {
        systemPromptBuilder.add("project-inventory-context", {
            phase,
        });

        // Add PROJECT.md fragment only for project-manager
        if (agent.slug === "project-manager") {
            systemPromptBuilder.add("project-md", {
                projectPath: process.cwd(),
                currentAgent: agent,
            });
        }
    }

    systemPromptBuilder
        .add("phase-definitions", {})
        .add("phase-context", {
            phase,
            phaseMetadata: conversation?.metadata,
            conversation,
        })
        .add("phase-constraints", {
            phase,
        })
        .add("retrieved-lessons", {
            agent,
            phase,
            conversation,
            agentLessons: agentLessons || new Map(),
        })
        .add("agent-tools", {
            agent,
        });
    
    // Only add MCP tools and reasoning instructions for non-orchestrator agents
    if (!agent.isOrchestrator) {
        systemPromptBuilder
            .add("agent-reasoning", {}) // Add reasoning instructions for non-orchestrator agents
            .add("mcp-tools", {
                tools: mcpTools,
            });
    }
    // .add("tool-use", {});

    // Add orchestrator-specific routing instructions for orchestrator agents using reason-act-loop backend
    // The routing backend doesn't need these instructions as it uses structured output
    if (agent.isOrchestrator && agent.backend !== "routing") {
        systemPromptBuilder
            .add("orchestrator-routing-instructions", {})
            .add("orchestrator-reasoning", {}); // Add orchestrator-specific reasoning
    } else if (!agent.isOrchestrator) {
        // Add expertise boundaries for non-orchestrator agents
        systemPromptBuilder.add("expertise-boundaries", {
            agentRole: agent.role,
            isOrchestrator: false,
        });
        
        // Add domain expert guidelines for all non-orchestrator agents
        systemPromptBuilder
            .add("domain-expert-guidelines", {})
            .add("expert-reasoning", {}); // Add expert-specific reasoning
    }

    return systemPromptBuilder.build();
}
