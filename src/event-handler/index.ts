import { formatAnyError } from "@/utils/error-formatter";
import { type NDKEvent, NDKKind, NDKTask } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { ConversationManager } from "../conversations/ConversationManager";
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
    private conversationManager!: ConversationManager;
    private agentExecutor!: AgentExecutor;
    private isUpdatingProject = false;

    constructor(
        private projectPath: string,
        private llmService: LLMService,
        _ndk: NDK
    ) {}

    async initialize(): Promise<void> {
        // Initialize components directly
        this.conversationManager = new ConversationManager(this.projectPath);
        this.agentExecutor = new AgentExecutor(this.llmService, this.conversationManager);

        // Initialize components
        await this.conversationManager.initialize();
    }

    async handleEvent(event: NDKEvent): Promise<void> {
        // Ignore kind 24010 (project status), 24111 (typing indicator), and 24112 (typing stop) events
        if (IGNORED_EVENT_KINDS.includes(event.kind)) return;

        logger.info(`event handler, kind: ${event.kind} from ${event.pubkey}`);

        switch (event.kind) {
            case EVENT_KINDS.GENERIC_REPLY:
                await handleChatMessage(event, {
                    conversationManager: this.conversationManager,
                    agentExecutor: this.agentExecutor,
                });
                break;

            case EVENT_KINDS.NEW_CONVERSATION:
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
            // Extract the agent pubkey and new model from the event tags
            const agentPubkey = event.tagValue("p");
            const newModel = event.tagValue("model");

            if (!agentPubkey || !newModel) {
                logger.warn("LLM_CONFIG_CHANGE event missing required tags", {
                    eventId: event.id,
                    hasAgentPubkey: !!agentPubkey,
                    hasModel: !!newModel,
                });
                return;
            }

            logger.info(`Received LLM config change request`, {
                agentPubkey,
                newModel,
                eventId: event.id,
                from: event.pubkey,
            });

            // Get the agent from the project context
            const projectContext = getProjectContext();
            const agent = Array.from(projectContext.agents.values()).find(
                (a) => a.pubkey === agentPubkey
            );

            if (!agent) {
                logger.warn("Agent not found for LLM config change", {
                    agentPubkey,
                    availableAgents: Array.from(projectContext.agents.keys()),
                });
                return;
            }

            // Update the agent's LLM configuration persistently
            const { AgentRegistry } = await import("@/agents/AgentRegistry");
            const agentRegistry = new AgentRegistry(this.projectPath, false);
            await agentRegistry.loadFromProject();
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
        } catch (error) {
            logger.error("Failed to handle LLM config change", {
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
