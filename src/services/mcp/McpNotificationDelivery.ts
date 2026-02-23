/**
 * McpNotificationDelivery - Delivers MCP subscription notifications to conversations
 *
 * When an MCP resource update notification is received, this module:
 * 1. Formats the notification as a system-reminder message
 * 2. Adds a user-role message directly to the ConversationStore
 * 3. Invokes the AgentExecutor to wake up the agent in the existing conversation
 *
 * This approach directly starts a new agent run without publishing Nostr events,
 * ensuring the agent processes only the new content from the resource update.
 */

import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { wrapInSystemReminder } from "@/services/system-reminder";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type { McpSubscription } from "./McpSubscriptionService";

/**
 * Deliver an MCP resource notification by directly invoking the AgentExecutor.
 *
 * Adds a user-role message to the conversation and starts a new agent run:
 * - Wraps content in a system-reminder format with subscription metadata
 * - Adds the message to ConversationStore as a user-role entry
 * - Creates an execution context and runs the agent directly
 * - If the agent is already streaming, queues the message for pickup
 */
export async function deliverMcpNotification(
    subscription: McpSubscription,
    content: string
): Promise<void> {
    const projectCtx = getProjectContext();

    // Look up the subscribing agent
    const agent = projectCtx.getAgentByPubkey(subscription.agentPubkey);
    if (!agent) {
        throw new Error(
            `Agent not found for MCP notification delivery: pubkey=${subscription.agentPubkey.substring(0, 12)}`
        );
    }

    // Format notification content as a system-reminder
    const reminderBody =
        `[MCP Resource Update | server: ${subscription.serverName} ` +
        `| resource: ${subscription.resourceUri} ` +
        `| subscription: ${subscription.id}]\n\n${content}`;
    const formattedContent = wrapInSystemReminder(reminderBody);

    // Get or load the conversation store
    const store = ConversationStore.getOrLoad(subscription.conversationId);

    // Check if the agent already has an active streaming RAL in this conversation.
    // If so, queue the message as an injection rather than starting a new execution.
    const ralRegistry = RALRegistry.getInstance();
    const activeRal = ralRegistry.getState(agent.pubkey, subscription.conversationId);

    if (activeRal?.isStreaming) {
        // Agent is actively streaming — queue the notification for the active execution
        ralRegistry.queueUserMessage(
            agent.pubkey,
            subscription.conversationId,
            activeRal.ralNumber,
            formattedContent
        );

        logger.info("MCP notification queued for active streaming execution", {
            subscriptionId: subscription.id,
            agent: agent.slug,
            ralNumber: activeRal.ralNumber,
            contentLength: content.length,
        });

        trace.getActiveSpan()?.addEvent("mcp_notification.queued_for_active_stream", {
            "subscription.id": subscription.id,
            "ral.number": activeRal.ralNumber,
        });
        return;
    }

    // Add the notification as a user-role message in the conversation
    store.addMessage({
        pubkey: subscription.agentPubkey,
        content: formattedContent,
        messageType: "text",
        role: "user",
        timestamp: Math.floor(Date.now() / 1000),
        targetedPubkeys: [subscription.agentPubkey],
    });
    await store.save();

    // Create a synthetic triggering event for the execution context.
    // This carries the conversation's branch tag so the executor resolves
    // the correct working directory (worktree or project root).
    const ndk = getNDK();
    const syntheticEvent = new NDKEvent(ndk);
    syntheticEvent.id = subscription.rootEventId;
    syntheticEvent.kind = 1;
    syntheticEvent.pubkey = subscription.agentPubkey;
    syntheticEvent.created_at = Math.floor(Date.now() / 1000);
    syntheticEvent.content = formattedContent;

    // Carry forward the branch tag from conversation metadata
    const metadata = store.getMetadata();
    const tags: string[][] = [];
    if (metadata.branch) {
        tags.push(["branch", metadata.branch]);
    }
    syntheticEvent.tags = tags;

    // Create execution context and run the agent
    const executionContext = await createExecutionContext({
        agent,
        conversationId: subscription.conversationId,
        projectBasePath: projectCtx.agentRegistry.getBasePath(),
        triggeringEvent: syntheticEvent,
        mcpManager: projectCtx.mcpManager,
    });

    const agentExecutor = new AgentExecutor();
    await agentExecutor.execute(executionContext);

    logger.info("Delivered MCP notification via direct AgentExecutor invocation", {
        subscriptionId: subscription.id,
        agent: agent.slug,
        conversationId: subscription.conversationId.substring(0, 12),
        contentLength: content.length,
    });

    trace.getActiveSpan()?.addEvent("mcp_notification.delivered_direct", {
        "subscription.id": subscription.id,
        "notification.content_length": content.length,
    });
}
