/**
 * EventGatherer - Responsible for gathering and filtering events for message building
 *
 * This module handles:
 * - Delegation detection and subthread gathering
 * - Thread path computation
 * - Event filtering based on relevance to the agent
 * - Public broadcast detection
 */

import { hasReasoningTag } from "@/conversations/utils/content-utils";
import { getTargetedAgentPubkeys, isEventFromUser } from "@/nostr/utils";
import { getProjectContext, isProjectContextInitialized } from "@/services/projects";
import { getPubkeyService } from "@/services/PubkeyService";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { trace } from "@opentelemetry/api";
import type { ExecutionContext } from "../types";
import type { EventWithContext, PreviousSubthread } from "./types/EventWithContext";

/**
 * Detects if this is a delegated execution (this agent was delegated to by another agent)
 */
export function isDelegatedExecution(context: ExecutionContext): boolean {
    const triggeringEvent = context.triggeringEvent;
    const agentPubkey = context.agent.pubkey;

    // Check if triggering event is from another agent and targets this agent
    if (triggeringEvent.pubkey === agentPubkey) {
        return false; // Self-triggered, not a delegation
    }

    // Check if this agent is in the p-tags (delegation target)
    const pTags = triggeringEvent.getMatchingTags("p");
    const isTargeted = pTags.some((tag) => tag[1] === agentPubkey);

    if (!isTargeted) {
        return false;
    }

    // Check if the sender is an agent (not a user)
    const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
    if (projectCtx) {
        const senderAgent = projectCtx.getAgentByPubkey(triggeringEvent.pubkey);
        if (senderAgent) {
            return true; // Triggered by another agent targeting this agent = delegation
        }
    }

    return false;
}

/**
 * Find previous subthreads this agent participated in (for re-invocation context)
 */
export async function gatherPreviousSubthreads(
    agentPubkey: string,
    currentDelegationEventId: string,
    allEvents: NDKEvent[]
): Promise<PreviousSubthread[]> {
    const subthreads: PreviousSubthread[] = [];
    const projectCtx = isProjectContextInitialized() ? getProjectContext() : null;
    const nameRepo = getPubkeyService();

    // Find all delegation events TO this agent (excluding current one)
    for (const event of allEvents) {
        if (event.id === currentDelegationEventId) continue;
        if (event.pubkey === agentPubkey) continue; // Skip events FROM this agent

        // Check if this is a delegation to this agent
        const pTags = event.getMatchingTags("p");
        const targetsThisAgent = pTags.some((tag) => tag[1] === agentPubkey);

        if (!targetsThisAgent) continue;

        // Check if sender is an agent
        const senderAgent = projectCtx?.getAgentByPubkey(event.pubkey);
        if (!senderAgent) continue;

        // Find this agent's response to this delegation
        const response = allEvents.find(
            (e) =>
                e.pubkey === agentPubkey &&
                e.getMatchingTags("e").some((tag) => tag[1] === event.id)
        );

        const delegatorSlug = senderAgent?.slug || (await nameRepo.getName(event.pubkey));

        subthreads.push({
            delegationEventId: event.id,
            delegatorSlug,
            delegatorPubkey: event.pubkey,
            prompt: event.content,
            response: response?.content,
            timestamp: event.created_at || 0,
        });
    }

    // Sort by timestamp
    subthreads.sort((a, b) => a.timestamp - b.timestamp);

    return subthreads;
}

/**
 * Format previous subthreads as context message
 */
export function formatPreviousSubthreadsContext(subthreads: PreviousSubthread[]): string | null {
    if (subthreads.length === 0) return null;

    const parts = [
        "## Previous Tasks in This Conversation",
        "",
        "You were previously delegated other tasks in this conversation. Here's a summary for context:",
        "",
    ];

    for (const subthread of subthreads) {
        parts.push(`### Task from ${subthread.delegatorSlug}`);
        parts.push(`**Request:** ${subthread.prompt.substring(0, 500)}${subthread.prompt.length > 500 ? "..." : ""}`);
        if (subthread.response) {
            parts.push(`**Your response:** ${subthread.response.substring(0, 300)}${subthread.response.length > 300 ? "..." : ""}`);
        }
        parts.push("");
    }

    parts.push("---");
    parts.push("Focus on your current task. The above is just context.");

    return parts.join("\n");
}

/**
 * Gather events for a delegated execution - ISOLATED VIEW
 * Only includes the delegation request and events in this subthread
 */
export async function gatherDelegationSubthread(
    context: ExecutionContext,
    allEvents: NDKEvent[],
    eventFilter?: (event: NDKEvent) => boolean
): Promise<EventWithContext[]> {
    const triggeringEvent = context.triggeringEvent;
    const relevantEvents: EventWithContext[] = [];
    const activeSpan = trace.getActiveSpan();

    // The triggering event is the delegation request - it becomes our "root"
    const delegationEventId = triggeringEvent.id;

    // Build set of events in this subthread:
    // - The delegation request itself
    // - Any events that reply to it (directly or transitively)
    const subthreadEventIds = new Set<string>([delegationEventId]);

    // Find all transitive replies to the delegation event
    let foundNew = true;
    while (foundNew) {
        foundNew = false;
        for (const event of allEvents) {
            if (subthreadEventIds.has(event.id)) continue;

            const eTags = event.getMatchingTags("e");
            for (const eTag of eTags) {
                if (subthreadEventIds.has(eTag[1])) {
                    subthreadEventIds.add(event.id);
                    foundNew = true;
                    break;
                }
            }
        }
    }

    if (activeSpan) {
        activeSpan.addEvent("delegation_subthread_computed", {
            "subthread.event_count": subthreadEventIds.size,
            "subthread.root_id": delegationEventId?.substring(0, 8),
        });
    }

    // Filter events to only those in the subthread
    for (const event of allEvents) {
        // Apply external filter if provided
        if (eventFilter && !eventFilter(event)) {
            continue;
        }

        // Skip reasoning events
        if (hasReasoningTag(event)) {
            continue;
        }

        // Only include events in the subthread
        if (!subthreadEventIds.has(event.id)) {
            if (activeSpan) {
                activeSpan.addEvent("event.filtered_delegation_isolation", {
                    "event.id": event.id?.substring(0, 8),
                    "event.content": event.content?.substring(0, 50),
                    "filter.reason": "not_in_delegation_subthread",
                });
            }
            continue;
        }

        const eventWithContext: EventWithContext = {
            event,
            timestamp: event.created_at || Date.now() / 1000,
        };

        if (activeSpan) {
            activeSpan.addEvent("event.included_delegation", {
                "event.id": event.id?.substring(0, 8),
                "event.content": event.content?.substring(0, 50),
                "event.pubkey": event.pubkey.substring(0, 8),
                "inclusion.reason": "in_delegation_subthread",
            });
        }

        relevantEvents.push(eventWithContext);
    }

    logger.debug("[EventGatherer] Gathered delegation subthread", {
        delegationEventId: delegationEventId?.substring(0, 8),
        subthreadSize: subthreadEventIds.size,
        relevantEventCount: relevantEvents.length,
        totalEventCount: allEvents.length,
    });

    return relevantEvents;
}

/**
 * Gather all events relevant to this agent
 * @param isDelegated If true, only include events in the delegation subthread (isolated view)
 */
export async function gatherRelevantEvents(
    context: ExecutionContext,
    allEvents: NDKEvent[],
    eventFilter?: (event: NDKEvent) => boolean,
    isDelegated = false
): Promise<EventWithContext[]> {
    const agentPubkey = context.agent.pubkey;
    const relevantEvents: EventWithContext[] = [];
    const triggeringEvent = context.triggeringEvent;
    const activeSpan = trace.getActiveSpan();

    // DELEGATION ISOLATION: If this is a delegated execution, only show the delegation subthread
    if (isDelegated) {
        return gatherDelegationSubthread(context, allEvents, eventFilter);
    }

    // Build index of delegation requests from this agent for response matching
    // Delegation request = kind 1111 from agent with phase tag
    const delegationRequestsById = new Map<string, NDKEvent>();
    for (const event of allEvents) {
        if (
            event.pubkey === agentPubkey &&
            event.kind === 1111 &&
            event.tagValue("phase")
        ) {
            delegationRequestsById.set(event.id, event);
        }
    }

    // STEP 1: Build thread path set for inclusion
    // Build the parent chain from triggering event to root
    const eventMap = new Map(allEvents.map((e) => [e.id, e]));

    // Build parent chain
    const parentChain: NDKEvent[] = [];
    let current: NDKEvent | undefined = triggeringEvent;
    const visited = new Set<string>();

    while (current) {
        if (visited.has(current.id)) {
            break; // Circular reference protection
        }
        visited.add(current.id);
        parentChain.unshift(current); // Add to front to maintain order

        const parentId = current.tagValue("e");
        if (!parentId) break; // Reached root

        current = eventMap.get(parentId);
    }

    // Determine thread path based on depth
    let threadPath: NDKEvent[];
    const rootEvent = parentChain[0];
    const rootId = rootEvent?.id;

    // Special case: If triggering event is a direct reply to root,
    // include ALL sibling replies to root (for collaborative root-level discussions)
    if (parentChain.length === 2 && rootId) {
        // Add root
        threadPath = [rootEvent];

        // Add ALL direct replies to root (sorted chronologically)
        const rootReplies = allEvents
            .filter((e) => {
                if (e.id === rootId) return false; // Skip root itself
                const parentId = e.tagValue("e");
                return parentId === rootId;
            })
            .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

        threadPath.push(...rootReplies);
    } else {
        // For deeper threads, only include direct parent chain (no siblings)
        threadPath = parentChain;
    }

    const threadPathIds = new Set(threadPath.map((e) => e.id));

    if (activeSpan) {
        activeSpan.addEvent("thread_path_computed", {
            "thread_path.event_count": threadPath.length,
            "thread_path.parent_chain_depth": parentChain.length,
            "thread_path.is_root_level_reply": parentChain.length === 2,
            "thread_path.includes_root_siblings": parentChain.length === 2,
            "thread_path.root_id": threadPath[0]?.id?.substring(0, 8),
            "thread_path.triggering_id": triggeringEvent.id?.substring(0, 8),
        });
    }

    for (const event of allEvents) {
        // Apply event filter if provided
        if (eventFilter && !eventFilter(event)) {
            if (activeSpan) {
                activeSpan.addEvent("event.filtered_by_external", {
                    "event.id": event.id?.substring(0, 8),
                    "event.content": event.content?.substring(0, 50),
                    "filter.reason": "external_filter",
                });
            }
            continue;
        }

        // Skip reasoning events
        if (hasReasoningTag(event)) {
            if (activeSpan) {
                activeSpan.addEvent("event.filtered_by_reasoning", {
                    "event.id": event.id?.substring(0, 8),
                    "event.content": event.content?.substring(0, 50),
                    "filter.reason": "reasoning_event",
                });
            }
            continue;
        }

        const eventWithContext: EventWithContext = {
            event,
            timestamp: event.created_at || Date.now() / 1000,
        };

        // Check if this agent is involved
        const isFromAgent = event.pubkey === agentPubkey;
        const isTargetedToAgent = getTargetedAgentPubkeys(event).includes(agentPubkey);
        const isFromUser = isEventFromUser(event);
        // Only consider it a public broadcast if it's from a user with no specific agent targets
        // AND we have project context initialized (otherwise we can't reliably determine user vs agent)
        const isPublicBroadcast =
            isProjectContextInitialized() &&
            isFromUser &&
            getTargetedAgentPubkeys(event).length === 0;

        // Check if this is a delegation response (do this FIRST, before other filtering)
        // Delegation responses are special because they should be formatted differently
        // Delegation response = kind 1111 that e-tags a delegation request and p-tags the delegating agent
        if (!isFromAgent && event.kind === 1111) {
            const eTags = event.getMatchingTags("e");
            const pTags = event.getMatchingTags("p");
            const mentionsAgent = pTags.some((tag) => tag[1] === agentPubkey);

            // Check if any e-tag references one of our delegation requests
            for (const eTag of eTags) {
                const referencedId = eTag[1];
                if (delegationRequestsById.has(referencedId) && mentionsAgent) {
                    eventWithContext.isDelegationResponse = true;
                    eventWithContext.delegationId = referencedId.substring(0, 8);
                    break;
                }
            }
        }

        // HYBRID INCLUSION LOGIC:
        // Include event if EITHER:
        // A. It's in the thread path (root → triggering event) - ensures full conversation context
        // B. It's directly relevant to this agent (for awareness of parallel branches)

        const isInThreadPath = threadPathIds.has(event.id);
        const isDirectlyRelevant =
            isFromAgent ||
            isTargetedToAgent ||
            isPublicBroadcast ||
            eventWithContext.isDelegationResponse;

        if (!isInThreadPath && !isDirectlyRelevant) {
            if (activeSpan) {
                activeSpan.addEvent("event.filtered_out", {
                    "event.id": event.id?.substring(0, 8),
                    "event.content": event.content?.substring(0, 50),
                    "event.pubkey": event.pubkey.substring(0, 8),
                    "filter.is_in_thread_path": false,
                    "filter.is_from_agent": isFromAgent,
                    "filter.is_targeted_to_agent": isTargetedToAgent,
                    "filter.is_public_broadcast": isPublicBroadcast,
                    "filter.is_delegation_response":
                        eventWithContext.isDelegationResponse || false,
                    "filter.reason": "not_in_thread_and_not_relevant",
                });
            }
            continue;
        }

        // Check if this is a delegation request from this agent
        // A delegation is ONLY detected if it's tracked in RALRegistry
        // This avoids incorrectly marking user-directed responses as delegations
        if (isFromAgent && event.kind === 1111 && event.id) {
            const ralRegistry = RALRegistry.getInstance();
            const isTrackedDelegation = ralRegistry.getRalKeyForDelegation(event.id) !== undefined;

            if (isTrackedDelegation) {
                const pTags = event.getMatchingTags("p");
                if (pTags.length > 0) {
                    eventWithContext.isDelegationRequest = true;
                    eventWithContext.delegationId = event.id.substring(0, 8);
                    eventWithContext.delegationContent = event.content;
                    eventWithContext.delegatedToPubkey = pTags[0][1];
                }
            }
        }

        // Event passed all filters - include it
        if (activeSpan) {
            activeSpan.addEvent("event.included", {
                "event.id": event.id?.substring(0, 8),
                "event.content": event.content?.substring(0, 50),
                "event.pubkey": event.pubkey.substring(0, 8),
                "inclusion.is_in_thread_path": isInThreadPath,
                "inclusion.is_from_agent": isFromAgent,
                "inclusion.is_targeted_to_agent": isTargetedToAgent,
                "inclusion.is_public_broadcast": isPublicBroadcast,
                "inclusion.is_delegation_response":
                    eventWithContext.isDelegationResponse || false,
                "inclusion.is_delegation_request":
                    eventWithContext.isDelegationRequest || false,
                "inclusion.reason": isInThreadPath ? "in_thread_path" : "directly_relevant",
            });
        }

        relevantEvents.push(eventWithContext);
    }

    return relevantEvents;
}
