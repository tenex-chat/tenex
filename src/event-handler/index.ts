import { type NDKEvent, type NDKKind, NDKTask } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { AgentExecutor } from "../agents/execution/AgentExecutor";
import { getEventKindName } from "../commands/run/constants";
import { ConversationManager } from "../conversations/ConversationManager";
import type { LLMService } from "../llm/types";
import { EVENT_KINDS } from "../llm/types";
import { logger } from "../utils/logger";
import { handleNewConversation } from "./newConversation";
import { handleProjectEvent } from "./project";
import { handleChatMessage } from "./reply";
import { handleTask } from "./task";

const logInfo = logger.info.bind(logger);

const IGNORED_EVENT_KIDNS = [
    EVENT_KINDS.PROJECT_STATUS as NDKKind,
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
        private ndk: NDK
    ) {}

    async initialize(): Promise<void> {
        // Initialize components directly
        this.conversationManager = new ConversationManager(this.projectPath);
        this.agentExecutor = new AgentExecutor(this.llmService, this.ndk, this.conversationManager);

        // Initialize components
        await this.conversationManager.initialize();
    }

    async handleEvent(event: NDKEvent): Promise<void> {
        // Ignore kind 24010 (project status), 24111 (typing indicator), and 24112 (typing stop) events
        if (IGNORED_EVENT_KIDNS.includes(event.kind)) return;

        logInfo(chalk.gray("\n📥 Event received:", event.id));

        const timestamp = new Date().toLocaleTimeString();
        const eventKindName = getEventKindName(event.kind);

        logInfo(chalk.gray(`\n[${timestamp}] `) + chalk.cyan(`${eventKindName} received`));
        logInfo(chalk.gray("From:    ") + chalk.white(event.author.npub));
        logInfo(chalk.gray("Event:   ") + chalk.gray(event.encode()));

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

            default:
                this.handleDefaultEvent(event);
        }
    }

    private handleDefaultEvent(event: NDKEvent): void {
        if (event.content) {
            logInfo(
                chalk.gray("Content: ") +
                    chalk.white(
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
