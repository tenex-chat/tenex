/**
 * McpNotificationDelivery - Delivers MCP subscription notifications to conversations
 *
 * When an MCP resource update notification is received, this module:
 * 1. Formats the notification as a system-reminder message
 * 2. Publishes a kind:1 NDK event that replies to the conversation root
 * 3. The existing event routing infrastructure picks up the event and
 *    dispatches it to the correct agent in the correct conversation
 *
 * This approach leverages the existing AgentDispatchService flow rather than
 * directly calling AgentExecutor, ensuring consistent behavior with
 * cooldowns, RAL management, and conversation state.
 */

import type { McpSubscription } from "./McpSubscriptionService";
import { getNDK } from "@/nostr/ndkClient";
import { config } from "@/services/ConfigService";
import { wrapInSystemReminder } from "@/services/system-reminder";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";

/**
 * Deliver an MCP resource notification to the subscription's conversation.
 *
 * Publishes a kind:1 event that routes through the existing dispatch infrastructure:
 * - References the conversation root via "e" tag (reply threading)
 * - Targets the subscribing agent via "p" tag
 * - Tags with the project "a" tag for project routing
 * - Wraps content in a system-reminder format
 */
export async function deliverMcpNotification(
    subscription: McpSubscription,
    content: string
): Promise<void> {
    const ndk = getNDK();
    if (!ndk) {
        throw new Error("NDK not available for MCP notification delivery");
    }

    // Format notification content using the shared system-reminder utility.
    // Metadata is placed inside the tags (not as XML attributes) for parser compatibility.
    const reminderBody =
        `[MCP Resource Update | server: ${subscription.serverName} ` +
        `| resource: ${subscription.resourceUri} ` +
        `| subscription: ${subscription.id}]\n\n${content}`;
    const formattedContent = wrapInSystemReminder(reminderBody);

    // Create a kind:1 event that replies to the conversation root
    const event = new NDKEvent(ndk);
    event.kind = 1;
    event.content = formattedContent;

    const tags: string[][] = [
        // Reply to conversation root event (threading)
        ["e", subscription.rootEventId, "", "root"],
        // Target the subscribing agent
        ["p", subscription.agentPubkey],
        // Project reference for routing
        ["a", subscription.projectId],
        // Metadata tags for identification
        ["mcp-subscription-id", subscription.id],
    ];

    event.tags = tags;

    // Sign with backend signer (same pattern as SchedulerService)
    const privateKey = await config.ensureBackendPrivateKey();
    const signer = new NDKPrivateKeySigner(privateKey);

    await event.sign(signer);
    await event.publish();

    logger.info("Published MCP notification event", {
        subscriptionId: subscription.id,
        eventId: event.id?.substring(0, 12),
        conversationRoot: subscription.rootEventId.substring(0, 12),
        agent: subscription.agentSlug,
        contentLength: content.length,
    });

    trace.getActiveSpan()?.addEvent("mcp_notification.event_published", {
        "subscription.id": subscription.id,
        "event.id": event.id || "",
        "notification.content_length": content.length,
    });
}
