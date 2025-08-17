import type { AgentInstance } from "@/agents/types";
import type { Phase } from "@/conversations/phases";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { Tool } from "@/tools/types";
import "@/prompts/fragments/10-phase-definitions";
import "@/prompts/fragments/10-referenced-article";
import "@/prompts/fragments/20-voice-mode";
import "@/prompts/fragments/35-specialist-completion-guidance";
import "@/prompts/fragments/30-project-md";
import "@/prompts/fragments/01-specialist-identity";
import "@/prompts/fragments/01-orchestrator-identity";
import "@/prompts/fragments/25-specialist-tools";
import "@/prompts/fragments/85-specialist-reasoning";
import "@/prompts/fragments/15-specialist-available-agents";
import "@/prompts/fragments/15-orchestrator-available-agents";
import "@/prompts/fragments/24-retrieved-lessons";
import "@/prompts/fragments/30-project-inventory";
import "@/prompts/fragments/25-orchestrator-routing";
import { isVoiceMode } from "@/prompts/fragments/20-voice-mode";
import type { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";

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

export interface BuildStandalonePromptOptions {
    // Required data
    agent: AgentInstance;
    phase: Phase;

    // Optional runtime data
    availableAgents?: AgentInstance[];
    conversation?: Conversation;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    mcpTools?: Tool[];
    triggeringEvent?: NDKEvent;
}

export interface SystemMessage {
    message: Message;
    metadata?: {
        cacheable?: boolean;
        cacheKey?: string;
        description?: string;
    };
}

/**
 * Builds the system prompt messages for an agent, returning an array of messages
 * with optional caching metadata.
 * This is the single source of truth for system prompt generation.
 */
export function buildSystemPromptMessages(options: BuildSystemPromptOptions): SystemMessage[] {
    const messages: SystemMessage[] = [];
    
    // Build the main system prompt
    const mainPrompt = buildMainSystemPrompt(options);
    messages.push({
        message: new Message("system", mainPrompt),
        metadata: {
            description: "Main system prompt"
        }
    });
    
    // Add PROJECT.md as separate cacheable message for project-manager
    if (!options.agent.isOrchestrator && options.agent.slug === "project-manager") {
        const projectMdContent = buildProjectMdContent(options);
        if (projectMdContent) {
            messages.push({
                message: new Message("system", projectMdContent),
                metadata: {
                    cacheable: true,
                    cacheKey: `project-md-${options.project.id}`,
                    description: "PROJECT.md content"
                }
            });
        }
    }
    
    // Add project inventory as separate cacheable message for all agents
    const inventoryContent = buildProjectInventoryContent(options);
    if (inventoryContent) {
        messages.push({
            message: new Message("system", inventoryContent),
            metadata: {
                cacheable: true,
                cacheKey: `project-inventory-${options.project.id}-${options.phase}`,
                description: "Project inventory"
            }
        });
    }
    
    return messages;
}

/**
 * Builds the main system prompt content (without PROJECT.md and inventory)
 */
function buildMainSystemPrompt(options: BuildSystemPromptOptions): string {
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
    const systemPromptBuilder = new PromptBuilder();
    
    // Choose identity fragment based on agent type - NO conditionals in fragments
    if (agent.isOrchestrator) {
        systemPromptBuilder.add("orchestrator-identity", {
            agent,
            projectTitle: project.tagValue("title") || "Unknown Project",
            projectOwnerPubkey: project.pubkey,
        });
    } else {
        systemPromptBuilder.add("specialist-identity", {
            agent,
            projectTitle: project.tagValue("title") || "Unknown Project",
            projectOwnerPubkey: project.pubkey,
        });
    }
    
    // Add available agents - different fragment for orchestrator vs specialist
    if (agent.isOrchestrator) {
        systemPromptBuilder.add("orchestrator-available-agents", {
            agents: availableAgents,
        });
    } else {
        systemPromptBuilder.add("specialist-available-agents", {
            agents: availableAgents,
            currentAgent: agent,
        });
    }
    
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

    // Keep phase-definitions as it's foundational knowledge
    // Remove phase-context and phase-constraints as they'll be injected dynamically
    systemPromptBuilder
        .add("phase-definitions", {})
        .add("retrieved-lessons", {
            agent,
            phase,
            conversation,
            agentLessons: agentLessons || new Map(),
        });
    
    // Add tools for specialists only
    if (!agent.isOrchestrator) {
        systemPromptBuilder.add("specialist-tools", {
            agent,
            mcpTools,
        });
    }
    // .add("tool-use", {});

    // Add appropriate fragments based on agent type
    if (agent.isOrchestrator) {
        // Orchestrator only needs routing instructions, no reasoning tags
        systemPromptBuilder.add("orchestrator-routing-instructions", {});
    } else {
        // Specialists use reasoning tags
        // systemPromptBuilder.add("specialist-reasoning", {});
    }

    return systemPromptBuilder.build();
}

/**
 * Builds PROJECT.md content as a separate message
 */
function buildProjectMdContent(options: BuildSystemPromptOptions): string | null {
    const builder = new PromptBuilder();
    builder.add("project-md", {
        projectPath: process.cwd(),
        currentAgent: options.agent,
    });
    const content = builder.build();
    return content.trim() ? content : null;
}

/**
 * Builds project inventory content as a separate message
 */
function buildProjectInventoryContent(options: BuildSystemPromptOptions): string | null {
    const builder = new PromptBuilder();
    builder.add("project-inventory-context", {
        phase: options.phase,
    });
    const content = builder.build();
    return content.trim() ? content : null;
}

/**
 * Builds system prompt messages for standalone agents (without project context).
 * Includes most fragments except project-specific ones.
 */
export function buildStandaloneSystemPromptMessages(options: BuildStandalonePromptOptions): SystemMessage[] {
    const messages: SystemMessage[] = [];
    
    // Build the main system prompt
    const mainPrompt = buildStandaloneMainPrompt(options);
    messages.push({
        message: new Message("system", mainPrompt),
        metadata: {
            description: "Main standalone system prompt"
        }
    });
    
    return messages;
}

/**
 * Builds the main system prompt for standalone agents
 */
function buildStandaloneMainPrompt(options: BuildStandalonePromptOptions): string {
    const {
        agent,
        phase,
        availableAgents = [],
        conversation,
        agentLessons,
        mcpTools = [],
        triggeringEvent,
    } = options;

    const systemPromptBuilder = new PromptBuilder();
    
    // For standalone agents, use a simplified identity without project references
    systemPromptBuilder.add("specialist-identity", {
        agent,
        projectTitle: "Standalone Mode",
        projectOwnerPubkey: agent.pubkey, // Use agent's own pubkey as owner
    });
    
    // Add available agents if any (for potential handoffs in standalone mode)
    if (availableAgents.length > 1) {
        systemPromptBuilder.add("specialist-available-agents", {
            agents: availableAgents,
            currentAgent: agent,
        });
    }
    
    // Add voice mode instructions if applicable
    if (isVoiceMode(triggeringEvent)) {
        systemPromptBuilder.add("voice-mode", {
            isVoiceMode: true,
        });
    }

    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        systemPromptBuilder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Keep phase definitions as foundational knowledge
    systemPromptBuilder
        .add("phase-definitions", {})
        .add("retrieved-lessons", {
            agent,
            phase,
            conversation,
            agentLessons: agentLessons || new Map(),
        });
    
    // Add tools
    systemPromptBuilder.add("specialist-tools", {
        agent,
        mcpTools,
    });

    // Specialists use reasoning tags
    // systemPromptBuilder.add("specialist-reasoning", {});

    // Add completion guidance for non-orchestrator agents
    systemPromptBuilder.add("specialist-completion-guidance", {});

    return systemPromptBuilder.build();
}

/**
 * Legacy function that returns a single concatenated system prompt string.
 * @deprecated Use buildSystemPromptMessages instead for better caching support
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const messages = buildSystemPromptMessages(options);
    return messages.map(m => m.message.content).join("\n\n");
}
