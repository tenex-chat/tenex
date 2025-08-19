import { formatAnyError } from "@/utils/error-formatter";
import { type NDKEvent, NDKKind, NDKTask } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationCoordinator } from "../conversations/ConversationCoordinator";
import { ExecutionQueueManager } from "../conversations/executionQueue";
import type { LLMService } from "../llm/types";
import { EVENT_KINDS } from "../llm/types";
import { getProjectContext } from "../services";
import { logger } from "../utils/logger";
import { handleNewConversation } from "./newConversation";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
import { handleTask } from "./task";

const logInfo = logger.info.bind(logger);

const IGNORED_EVENT_KINDS = [
    NDKKind.Metadata,
    EVENT_KINDS.PROJECT_STATUS as NDKKind,
    EVENT_KINDS.STREAMING_RESPONSE as NDKKind,
    EVENT_KINDS.TYPING_INDICATOR as NDKKind,
    EVENT_KINDS.TYPING_INDICATOR_STOP as NDKKind,
];

export class EventHandler {
    private conversationManager!: ConversationCoordinator;
    private agentExecutor!: AgentExecutor;
    private executionQueueManager?: ExecutionQueueManager;
    private isUpdatingProject = false;

    constructor(
        private projectPath: string,
        private llmService: LLMService,
        _ndk: NDK
    ) {}

    async initialize(): Promise<void> {
        // Create ExecutionQueueManager if we have project context
        try {
            const projectCtx = getProjectContext();
            if (projectCtx && projectCtx.pubkey) {
                const projectIdentifier = projectCtx.project.tagValue("d") || projectCtx.project.id;
                this.executionQueueManager = new ExecutionQueueManager(
                    this.projectPath,
                    projectCtx.pubkey,
                    projectIdentifier
                );
                await this.executionQueueManager.initialize();
            }
        } catch (err) {
            // ExecutionQueueManager is optional, continue without it
            logger.warn("Could not create ExecutionQueueManager:", err);
        }

        // Initialize DelegationRegistry singleton first
        await DelegationRegistry.initialize();

        // Initialize components directly
        this.conversationManager = new ConversationCoordinator(
            this.projectPath,
            undefined, // default persistence
            this.executionQueueManager
        );
        this.agentExecutor = new AgentExecutor(this.llmService, this.conversationManager);

        // Initialize components
        await this.conversationManager.initialize();
    }

    getExecutionQueueManager(): ExecutionQueueManager | undefined {
        return this.executionQueueManager;
    }

    async handleEvent(event: NDKEvent): Promise<void> {
        // Ignore kind 24010 (project status), 24111 (typing indicator), and 24112 (typing stop) events
        if (IGNORED_EVENT_KINDS.includes(event.kind)) return;

        const pTags = event.getMatchingTags("p").map(t => t[1].substring(0, 8));

        logger.info(`event handler, kind: ${event.kind} from ${event.pubkey} for (${pTags.join(', ')})`);

        switch (event.kind) {
            case EVENT_KINDS.GENERIC_REPLY:
                await handleChatMessage(event, {
                    conversationManager: this.conversationManager,
                    agentExecutor: this.agentExecutor,
                });
                break;

            case NDKKind.Thread:
                await handleNewConversation(event, {
                    conversationManager: this.conversationManager,
                    agentExecutor: this.agentExecutor,
                });
                break;

            case EVENT_KINDS.TASK:
                await handleTask(NDKTask.from(event), {
                    conversationManager: this.conversationManager,
                    agentExecutor: this.agentExecutor,
                });
                break;

            case EVENT_KINDS.PROJECT:
                if (this.isUpdatingProject) {
                    logger.warn("Project update already in progress, skipping event", {
                        eventId: event.id,
                    });
                    return;
                }

                this.isUpdatingProject = true;
                try {
                    await handleProjectEvent(event, this.projectPath);
                } finally {
                    this.isUpdatingProject = false;
                }
                break;

            case EVENT_KINDS.LLM_CONFIG_CHANGE:
                await this.handleLLMConfigChange(event);
                break;

            default:
                this.handleDefaultEvent(event);
        }
    }

    private async handleLLMConfigChange(event: NDKEvent): Promise<void> {
        try {
            // Extract the agent pubkey from the event tags
            const agentPubkey = event.tagValue("p");
            if (!agentPubkey) {
                logger.warn("LLM_CONFIG_CHANGE event missing agent pubkey", {
                    eventId: event.id,
                });
                return;
            }

            // Get the agent from the project context
            const projectContext = getProjectContext();
            const agent = Array.from(projectContext.agents.values()).find(
                (a) => a.pubkey === agentPubkey
            );

            if (!agent) {
                logger.warn("Agent not found for config change", {
                    agentPubkey,
                    availableAgents: Array.from(projectContext.agents.keys()),
                });
                return;
            }

            // Load the agent registry for persistent updates
            const { AgentRegistry } = await import("@/agents/AgentRegistry");
            const agentRegistry = new AgentRegistry(this.projectPath, false);
            await agentRegistry.loadFromProject();

            // Check for model configuration change
            const newModel = event.tagValue("model");
            if (newModel) {
                logger.info(`Received LLM config change request`, {
                    agentPubkey,
                    newModel,
                    eventId: event.id,
                    from: event.pubkey,
                });

                // Update the agent's LLM configuration persistently
                const updated = await agentRegistry.updateAgentLLMConfig(agentPubkey, newModel);
                
                if (updated) {
                    // Also update in memory for immediate effect
                    agent.llmConfig = newModel;
                    logger.info(`Updated and persisted LLM configuration for agent`, {
                        agentName: agent.name,
                        agentPubkey: agent.pubkey,
                        newModel,
                    });
                } else {
                    // Fallback: at least update in memory for this session
                    agent.llmConfig = newModel;
                    logger.warn(`Updated LLM configuration in memory only (persistence failed)`, {
                        agentName: agent.name,
                        agentPubkey: agent.pubkey,
                        newModel,
                    });
                }
            }

            // Check for tools configuration change
            // Extract all tool tags - these represent the exhaustive list of tools the agent should have
            const toolTags = event.tags.filter(tag => tag[0] === "tool");
            if (toolTags.length > 0) {
                // Extract tool names from tags (format: ["tool", "<tool-name>"])
                const newToolNames = toolTags.map(tag => tag[1]).filter(name => name);
                
                logger.info(`Received tools config change request`, {
                    agentPubkey,
                    agentSlug: agent.slug,
                    newTools: newToolNames,
                    eventId: event.id,
                    from: event.pubkey,
                });

                // Update the agent's tools persistently
                const updated = await agentRegistry.updateAgentTools(agentPubkey, newToolNames);
                
                if (updated) {
                    logger.info(`Updated and persisted tools configuration for agent`, {
                        agentName: agent.name,
                        agentPubkey: agent.pubkey,
                        newTools: newToolNames,
                    });
                } else {
                    logger.warn(`Failed to update tools configuration`, {
                        agentName: agent.name,
                        agentPubkey: agent.pubkey,
                        newTools: newToolNames,
                    });
                }
            }

            // If neither model nor tools were provided, log a warning
            if (!newModel && toolTags.length === 0) {
                logger.warn("LLM_CONFIG_CHANGE event has neither model nor tool tags", {
                    eventId: event.id,
                    agentPubkey,
                });
            }
        } catch (error) {
            logger.error("Failed to handle config change", {
                eventId: event.id,
                error: formatAnyError(error),
            });
        }
    }

    private handleDefaultEvent(event: NDKEvent): void {
        if (event.content) {
            logInfo(
              chalk.white(`[handleDefaultEvent ${event.id.substring(0, 6)}] Handling event kind ${event.kind}`) +
              chalk.white(`[handleDefaultEvent ${event.id.substring(0, 6)}] Content: `) +
                chalk.gray(
                  event.content.substring(0, 100) + (event.content.length > 100 ? "..." : "")
                )
            );
        }
    }

    async cleanup(): Promise<void> {
        // Save all conversations before shutting down
        await this.conversationManager.cleanup();
        logInfo("EventHandler cleanup completed");
    }
}
