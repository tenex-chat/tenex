import { shortenConversationId, shortenPubkey } from "@/utils/conversation-id";
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
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { getProjectContext } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { wrapInSystemReminder } from "ai-sdk-context-management";
import { logger } from "@/utils/logger";
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
    const notificationTimestamp = Date.now();
    const notificationEventId = `mcp-notification:${subscription.id}:${notificationTimestamp}`;

    // Look up the subscribing agent
    const agent = projectCtx.getAgentByPubkey(subscription.agentPubkey);
    if (!agent) {
        throw new Error(
            `Agent not found for MCP notification delivery: pubkey=${shortenPubkey(subscription.agentPubkey)}`
        );
    }

    // Format notification content as a system-reminder
    const reminderBody =
        `[MCP Resource Update | server: ${subscription.serverName} ` +
        `| resource: ${subscription.resourceUri} ` +
        `| subscription: ${subscription.id}]\n\n${content}`;
    const formattedContent = wrapInSystemReminder({
        type: "mcp-notification",
        content: reminderBody,
    });

    // Get or load the conversation store
    const store = ConversationStore.getOrLoad(subscription.conversationId);
    const metadata = store.getMetadata();
    const senderPrincipal: InboundEnvelope["principal"] = {
        id: `mcp:subscription:${subscription.id}`,
        transport: "mcp",
        displayName: subscription.serverName,
        kind: "system",
    };
    const recipientPrincipal: InboundEnvelope["principal"] = {
        id: `nostr:${subscription.agentPubkey}`,
        transport: "nostr",
        linkedPubkey: subscription.agentPubkey,
        displayName: agent.slug,
        kind: "agent",
    };

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
            formattedContent,
            {
                senderPrincipal,
                targetedPrincipals: [recipientPrincipal],
                eventId: notificationEventId,
            }
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
        pubkey: "",
        content: formattedContent,
        messageType: "text",
        eventId: notificationEventId,
        role: "user",
        timestamp: Math.floor(Date.now() / 1000),
        targetedPubkeys: [subscription.agentPubkey],
        targetedPrincipals: [recipientPrincipal],
        senderPrincipal,
    });
    await store.save();

    const syntheticEnvelope: InboundEnvelope = {
        transport: "mcp",
        principal: senderPrincipal,
        channel: {
            id: `mcp:conversation:${subscription.conversationId}`,
            transport: "mcp",
            kind: "conversation",
            projectBinding: subscription.projectId,
        },
        message: {
            id: `mcp:${notificationEventId}`,
            transport: "mcp",
            nativeId: notificationEventId,
        },
        recipients: [recipientPrincipal],
        content: formattedContent,
        occurredAt: Math.floor(notificationTimestamp / 1000),
        capabilities: ["mcp-subscription-notification", "direct-agent-execution"],
        metadata: {
            eventKind: 1,
            branchName: metadata.branch,
        },
    };

    // Create execution context and run the agent
    const executionContext = await createExecutionContext({
        agent,
        conversationId: subscription.conversationId,
        projectBasePath: projectCtx.agentRegistry.getBasePath(),
        triggeringEnvelope: syntheticEnvelope,
        mcpManager: projectCtx.mcpManager,
    });

    const agentExecutor = new AgentExecutor();
    await agentExecutor.execute(executionContext);

    logger.info("Delivered MCP notification via direct AgentExecutor invocation", {
        subscriptionId: subscription.id,
        agent: agent.slug,
        conversationId: shortenConversationId(subscription.conversationId),
        contentLength: content.length,
    });

    trace.getActiveSpan()?.addEvent("mcp_notification.delivered_direct", {
        "subscription.id": subscription.id,
        "notification.content_length": content.length,
    });
}
