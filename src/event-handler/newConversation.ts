import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKArticle } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import chalk from "chalk";
import type { AgentExecutor } from "../agents/execution/AgentExecutor";
import { createExecutionContext } from "../agents/execution/ExecutionContextFactory";
import { ConversationStore } from "../conversations/ConversationStore";
import type { ConversationMetadata } from "../conversations/types";
import { AgentEventDecoder } from "../nostr/AgentEventDecoder";
import { getNDK } from "../nostr/ndkClient";
import { TagExtractor } from "../nostr/TagExtractor";
import { getProjectContext } from "@/services/projects";
import { formatAnyError } from "@/lib/error-formatter";
import { logger } from "../utils/logger";
import { AgentRouter } from "@/services/dispatch/AgentRouter";

/**
 * Fetch a kind 30023 (NDKArticle) from an a-tag reference.
 * @param aTagValue - The a-tag value in format "30023:pubkey:d-tag"
 * @returns The article metadata or null if not found
 */
async function fetchReferencedArticle(
    aTagValue: string
): Promise<ConversationMetadata["referencedArticle"] | null> {
    try {
        const parts = aTagValue.split(":");
        if (parts.length < 3 || parts[0] !== "30023") {
            return null;
        }

        const [, pubkey, ...dTagParts] = parts;
        const dTag = dTagParts.join(":"); // Handle d-tags that contain colons

        const ndk = getNDK();
        const filter = {
            kinds: [30023],
            authors: [pubkey],
            "#d": [dTag],
        };

        const events = await ndk.fetchEvents(filter);
        if (events.size === 0) {
            logger.debug(chalk.yellow(`Referenced article not found: ${aTagValue}`));
            return null;
        }

        const event = Array.from(events)[0];
        const article = NDKArticle.from(event);

        logger.info(chalk.cyan(`📄 Fetched referenced article: "${article.title || dTag}"`));

        return {
            title: article.title || dTag,
            content: article.content || "",
            dTag,
        };
    } catch (error) {
        logger.debug(chalk.yellow(`Failed to fetch referenced article: ${formatAnyError(error)}`));
        return null;
    }
}

/**
 * Extract and fetch the first kind 30023 article reference from an event's a-tags.
 * @param event - The event to extract article references from
 * @returns The article metadata or null if none found
 */
async function extractReferencedArticle(
    event: NDKEvent
): Promise<ConversationMetadata["referencedArticle"] | null> {
    const aTags = TagExtractor.getATags(event);

    // Find the first a-tag referencing a kind 30023 (article)
    const articleATag = aTags.find((tag) => tag.startsWith("30023:"));
    if (!articleATag) {
        return null;
    }

    return fetchReferencedArticle(articleATag);
}

interface EventHandlerContext {
    agentExecutor: AgentExecutor;
    /**
     * Project directory (normal git repository root).
     * Worktrees are in .worktrees/ subdirectory.
     */
    projectBasePath: string;
}

export const handleNewConversation = async (
    event: NDKEvent,
    context: EventHandlerContext
): Promise<void> => {
    try {
        // Create conversation
        const conversation = await ConversationStore.create(event);

        // Check for referenced kind 30023 articles and populate metadata
        const referencedArticle = await extractReferencedArticle(event);
        if (referencedArticle) {
            conversation.updateMetadata({ referencedArticle });
            await conversation.save();

            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
                activeSpan.addEvent("referenced_article_loaded", {
                    "article.title": referencedArticle.title,
                    "article.dTag": referencedArticle.dTag,
                    "article.content_length": referencedArticle.content.length,
                });
            }
        }

        // Get project context
        const projectCtx = getProjectContext();

        // Use AgentRouter to resolve target agents (includes project validation for global agents)
        const targetAgents = AgentRouter.resolveTargetAgents(event, projectCtx);

        // Add telemetry for routing decision
        const activeSpan = trace.getActiveSpan();
        if (activeSpan) {
            const mentionedPubkeys = AgentEventDecoder.getMentionedPubkeys(event);
            activeSpan.addEvent("agent_routing", {
                "routing.mentioned_pubkeys_count": mentionedPubkeys.length,
                "routing.resolved_agent_count": targetAgents.length,
                "routing.agent_names": targetAgents.map((a) => a.name).join(", "),
                "routing.agent_roles": targetAgents.map((a) => a.role).join(", "),
            });
        }

        // If no valid agents found (filtered by project context), return
        if (targetAgents.length === 0) {
            logger.info(
                chalk.gray(
                    "New conversation - no valid agents to route to (may have been filtered by project context)"
                )
            );
            if (activeSpan) {
                activeSpan.addEvent("agent_routing_failed", { reason: "no_agents_resolved" });
            }
            return;
        }

        // Use first agent for new conversation
        const targetAgent = targetAgents[0];

        // Create execution context (new conversations don't have branch tags)
        const executionContext = await createExecutionContext({
            agent: targetAgent,
            conversationId: conversation.id,
            projectBasePath: context.projectBasePath,
            triggeringEvent: event,
            mcpManager: projectCtx.mcpManager,
        });

        // Execute with the appropriate agent
        await context.agentExecutor.execute(executionContext);

        logger.info(chalk.green("✅ Conversation routed successfully"));
    } catch (error) {
        logger.info(chalk.red(`❌ Failed to route conversation: ${formatAnyError(error)}`));
    }
};
