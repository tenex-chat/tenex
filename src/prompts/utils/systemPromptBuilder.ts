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
import "@/prompts/fragments/project-md";
import { isVoiceMode } from "@/prompts/fragments/voice-mode";
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
    
    // Add project inventory as separate cacheable message for non-orchestrator agents
    if (!options.agent.isOrchestrator) {
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

    // Keep phase-definitions as it's foundational knowledge
    // Remove phase-context and phase-constraints as they'll be injected dynamically
    systemPromptBuilder
        .add("phase-definitions", {})
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
        // Remove agent-completion-guidance as it will be injected dynamically with phase context
        systemPromptBuilder
            .add("domain-expert-guidelines", {})
            .add("expert-reasoning", {}); // Add expert-specific reasoning
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
 * Legacy function that returns a single concatenated system prompt string.
 * @deprecated Use buildSystemPromptMessages instead for better caching support
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
    const messages = buildSystemPromptMessages(options);
    return messages.map(m => m.message.content).join("\n\n");
}
