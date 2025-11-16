import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import type { NDKAgentLesson } from "@/events/NDKAgentLesson";
import { PromptBuilder } from "@/prompts/core/PromptBuilder";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import type { ModelMessage } from "ai";

// Import fragment registration manifest
import "@/prompts/fragments"; // This auto-registers all fragments

export interface BuildSystemPromptOptions {
    // Required data
    agent: AgentInstance;
    project: NDKProject;
    projectPath?: string; // Absolute path to the project working directory

    // Optional runtime data
    availableAgents?: AgentInstance[];
    conversation?: Conversation;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    isProjectManager?: boolean; // Indicates if this agent is the PM
    projectManagerPubkey?: string; // Pubkey of the project manager
}

export interface BuildStandalonePromptOptions {
    // Required data
    agent: AgentInstance;

    // Optional runtime data
    availableAgents?: AgentInstance[];
    conversation?: Conversation;
    agentLessons?: Map<string, NDKAgentLesson[]>;
    projectManagerPubkey?: string; // Pubkey of the project manager
}

export interface SystemMessage {
    message: ModelMessage;
    metadata?: {
        description?: string;
    };
}

/**
 * Add core agent fragments that are common to both project and standalone modes
 */
async function addCoreAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    conversation?: Conversation,
    agentLessons?: Map<string, NDKAgentLesson[]>
): Promise<void> {
    // Add referenced article context if present
    if (conversation?.metadata?.referencedArticle) {
        builder.add("referenced-article", conversation.metadata.referencedArticle);
    }

    // Add retrieved lessons
    builder.add("retrieved-lessons", {
        agent,
        conversation,
        agentLessons: agentLessons || new Map(),
    });

    // Add MCP resources if agent has MCP access and RAG subscription tools
    const hasMcpAccess = agent.mcp !== false;
    const hasRagSubscriptionTools = agent.tools.includes("rag_subscription_create");

    if (hasMcpAccess && hasRagSubscriptionTools) {
        // Lazy-load MCPManager to avoid circular dependency
        const { mcpManager } = await import("@/services/mcp/MCPManager");
        const runningServers = mcpManager.getRunningServers();

        // Fetch resources from all running servers
        const { logger } = await import("@/utils/logger");
        const resourcesPerServer = await Promise.all(
            runningServers.map(async (serverName) => {
                try {
                    const [resources, templates] = await Promise.all([
                        mcpManager.listResources(serverName),
                        mcpManager.listResourceTemplates(serverName),
                    ]);
                    logger.debug(
                        `Fetched ${resources.length} resources and ${templates.length} templates from '${serverName}'`
                    );
                    return { serverName, resources, templates };
                } catch (error) {
                    logger.warn(`Failed to fetch MCP resources from '${serverName}':`, error);
                    // Return empty resources if server fails
                    return { serverName, resources: [], templates: [] };
                }
            })
        );

        builder.add("mcp-resources", {
            agentPubkey: agent.pubkey,
            mcpEnabled: true,
            resourcesPerServer,
        });
    }
}

/**
 * Add agent-specific fragments
 */
function addAgentFragments(
    builder: PromptBuilder,
    agent: AgentInstance,
    availableAgents: AgentInstance[],
    projectManagerPubkey?: string
): void {
    // Add available agents for delegations
    builder.add("available-agents", {
        agents: availableAgents,
        currentAgent: agent,
        projectManagerPubkey,
    });
}

/**
 * Builds the system prompt messages for an agent, returning an array of messages
 * with optional caching metadata.
 * This is the single source of truth for system prompt generation.
 */
export async function buildSystemPromptMessages(
    options: BuildSystemPromptOptions
): Promise<SystemMessage[]> {
    const messages: SystemMessage[] = [];

    // Build the main system prompt
    const mainPrompt = await buildMainSystemPrompt(options);
    messages.push({
        message: { role: "system", content: mainPrompt },
        metadata: {
            description: "Main system prompt",
        },
    });

    return messages;
}

/**
 * Builds the main system prompt content
 */
async function buildMainSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
    const {
        agent,
        project,
        projectPath,
        availableAgents = [],
        conversation,
        agentLessons,
    } = options;

    const systemPromptBuilder = new PromptBuilder();

    // Add agent identity
    systemPromptBuilder.add("agent-identity", {
        agent,
        projectTitle: project.tagValue("title") || "Unknown Project",
        projectOwnerPubkey: project.pubkey,
        projectPath,
    });

    // Add agent phases awareness if agent has phases defined
    systemPromptBuilder.add("agent-phases", { agent });

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agent, conversation, agentLessons);

    // Add agent-specific fragments
    addAgentFragments(systemPromptBuilder, agent, availableAgents, options.projectManagerPubkey);

    return systemPromptBuilder.build();
}

/**
 * Builds system prompt messages for standalone agents (without project context).
 * Includes most fragments except project-specific ones.
 */
export async function buildStandaloneSystemPromptMessages(
    options: BuildStandalonePromptOptions
): Promise<SystemMessage[]> {
    const messages: SystemMessage[] = [];

    // Build the main system prompt
    const mainPrompt = await buildStandaloneMainPrompt(options);
    messages.push({
        message: { role: "system", content: mainPrompt },
        metadata: {
            description: "Main standalone system prompt",
        },
    });

    return messages;
}

/**
 * Builds the main system prompt for standalone agents
 */
async function buildStandaloneMainPrompt(options: BuildStandalonePromptOptions): Promise<string> {
    const { agent, availableAgents = [], conversation, agentLessons } = options;

    const systemPromptBuilder = new PromptBuilder();

    // For standalone agents, use a simplified identity without project references
    systemPromptBuilder.add("agent-identity", {
        agent,
        projectTitle: "Standalone Mode",
        projectOwnerPubkey: agent.pubkey, // Use agent's own pubkey as owner
    });

    // Add core agent fragments using shared composition
    await addCoreAgentFragments(systemPromptBuilder, agent, conversation, agentLessons);

    // Add agent-specific fragments only if multiple agents available
    if (availableAgents.length > 1) {
        addAgentFragments(
            systemPromptBuilder,
            agent,
            availableAgents,
            options.projectManagerPubkey
        );
    }

    return systemPromptBuilder.build();
}
