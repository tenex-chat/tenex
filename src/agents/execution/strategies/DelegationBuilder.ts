/**
 * DelegationBuilder - Builds delegation context for message rendering
 *
 * This module handles:
 * - Building delegation maps from events
 * - Matching delegation responses to requests
 * - Rendering delegations as XML blocks
 */

import { DelegationXmlFormatter } from "@/conversations/formatters/DelegationXmlFormatter";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { getPubkeyService } from "@/services/PubkeyService";
import type { ModelMessage } from "ai";
import type { DelegationData, EventWithContext } from "./types/EventWithContext";

/**
 * Build a map of delegations and their responses from events
 */
export async function buildDelegationMap(
    events: EventWithContext[],
    agentPubkey: string
): Promise<{
    delegationMap: Map<string, DelegationData>;
    delegationResponseEventIds: Set<string>;
}> {
    const nameRepo = getPubkeyService();
    const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;

    const delegationMap = new Map<string, DelegationData>();
    const delegationResponseEventIds = new Set<string>();

    // Build delegation map from event tags (no registry needed)
    for (const eventContext of events) {
        const { event } = eventContext;

        if (eventContext.isDelegationRequest && eventContext.delegationId) {
            // Get agent names from project context or pubkey service
            const fromAgent = projectCtx?.getAgentByPubkey(agentPubkey);
            const fromSlug = fromAgent?.slug || (await nameRepo.getName(agentPubkey));

            const toAgent = eventContext.delegatedToPubkey
                ? projectCtx?.getAgentByPubkey(eventContext.delegatedToPubkey)
                : undefined;
            const toSlug = toAgent?.slug ||
                (eventContext.delegatedToPubkey
                    ? await nameRepo.getName(eventContext.delegatedToPubkey)
                    : "unknown");

            // Get phase from event tags
            const phaseTag = event.tags.find((t) => t[0] === "phase");
            const phase = phaseTag?.[1];

            // Use full event ID for map key (delegationId is truncated)
            const fullId = event.id;
            if (!delegationMap.has(fullId)) {
                delegationMap.set(fullId, {
                    id: eventContext.delegationId,
                    from: fromSlug,
                    recipients: [toSlug],
                    phase,
                    message: eventContext.delegationContent || "",
                    requestEventId: event.id,
                    requestEvent: event,
                    responses: [],
                });
            } else {
                // Add recipient to existing delegation (multi-recipient case)
                const delegation = delegationMap.get(fullId);
                if (delegation && toSlug && !delegation.recipients.includes(toSlug)) {
                    delegation.recipients.push(toSlug);
                }
            }
        }

        if (eventContext.isDelegationResponse && eventContext.delegationId) {
            // Find the delegation this responds to by matching e-tags
            const eTags = event.getMatchingTags("e");
            for (const eTag of eTags) {
                const delegationEventId = eTag[1];
                const delegation = delegationMap.get(delegationEventId);
                if (delegation) {
                    // Get responder name from project context or pubkey service
                    const responderAgent = projectCtx?.getAgentByPubkey(event.pubkey);
                    const responderSlug = responderAgent?.slug || (await nameRepo.getName(event.pubkey));

                    delegation.responses.push({
                        from: responderSlug,
                        content: event.content || "",
                        eventId: event.id,
                        status: "completed",
                    });

                    delegationResponseEventIds.add(event.id);
                    break;
                }
            }
        }
    }

    return { delegationMap, delegationResponseEventIds };
}

/**
 * Identify tool-call events for delegate tool that should be skipped
 */
export function identifyDelegateToolCallEvents(events: EventWithContext[]): Set<string> {
    const toolCallEventIds = new Set<string>();

    for (const eventWithContext of events) {
        const toolTag = eventWithContext.event.tags.find((t) => t[0] === "tool");
        if (toolTag && toolTag[1] === "delegate") {
            toolCallEventIds.add(eventWithContext.event.id);
        }
    }

    return toolCallEventIds;
}

/**
 * Render a delegation as an XML system message
 */
export function renderDelegationMessage(delegation: DelegationData, debug: boolean): ModelMessage {
    const xml = DelegationXmlFormatter.render(delegation, debug);
    return {
        role: "system",
        content: xml,
    };
}
