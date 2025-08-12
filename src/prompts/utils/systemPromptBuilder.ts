import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { Tool } from "@/tools/types";
import "@/prompts/fragments/phase-definitions";
import "@/prompts/fragments/referenced-article";
import "@/prompts/fragments/domain-expert-guidelines";
import "@/prompts/fragments/voice-mode";
import "@/prompts/fragments/agent-completion-guidance";
import { isVoiceMode } from "@/prompts/fragments/voice-mode";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";

export interface BuildSystemPromptOptions {
    // Required data
    agent: AgentInstance;
    phase: Phase;
    project: NDKProject;

    // Optional runtime data
    availableAgents?: AgentInstance[];
    conversation?: Conversation;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    mcpTools?: Tool[];
    triggeringEvent?: NDKEvent;
}

/**
 * Builds the system prompt for an agent using the exact same logic as production.
 * This is the single source of truth for system prompt generation.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const {
        agent,
        phase,
        project,
        availableAgents = [],
        conversation,
        agentLessons,
        mcpTools = [],
        triggeringEvent,
    } = options;

    // Build system prompt with all agent and phase context
    const systemPromptBuilder = new PromptBuilder().add("agent-system-prompt", {
        agent,
        phase,
        projectTitle: project.title,
        projectOwnerPubkey: project.pubkey,
    });
    
    // Only add conversation-history instructions for non-orchestrator agents
    // Orchestrator receives structured JSON, not conversation history
    if (!agent.isOrchestrator) {
        systemPromptBuilder.add("conversation-history-instructions", {
            isOrchestrator: false,
        });
    }
    
    systemPromptBuilder.add("available-agents", {
        agents: availableAgents,
        currentAgent: agent,
    });
    
    // Add voice mode instructions if this is a voice mode event
    // But skip for orchestrator since it doesn't speak to users
    if (!agent.isOrchestrator && isVoiceMode(triggeringEvent)) {
        systemPromptBuilder.add("voice-mode", {
            isVoiceMode: true,
        });
    }

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
    if (agent.isOrchestrator) {
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
            .add("expert-reasoning", {}) // Add expert-specific reasoning
            .add("agent-completion-guidance", {
                phase,
                isOrchestrator: false,
            });
    }

    return systemPromptBuilder.build();
}
