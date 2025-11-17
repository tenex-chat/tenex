import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import { logger } from "@/utils/logger";

/**
 * Consolidated routing logging utilities to reduce verbosity
 */

export function logRoutingDecision(
    routingLogger: EventRoutingLogger,
    event: NDKEvent,
    decision: "routed" | "dropped" | "project_event" | "lesson_hydration",
    projectId: string | null,
    reason: string,
    method: "a_tag" | "p_tag_agent" | "none" = "none",
    matchedTags: string[] = []
) {
    return routingLogger.logRoutingDecision({
        event,
        routingDecision: decision,
        targetProjectId: projectId,
        routingMethod: method,
        matchedTags,
        reason,
    });
}

export function logDropped(
    routingLogger: EventRoutingLogger,
    event: NDKEvent,
    reason: string
) {
    logger.debug(`Event dropped: ${reason}`, {
        eventId: event.id?.slice(0, 8),
        eventKind: event.kind,
        reason,
    });
    return logRoutingDecision(routingLogger, event, "dropped", null, reason);
}

export function logRouted(
    routingLogger: EventRoutingLogger,
    event: NDKEvent,
    projectId: string,
    method: "a_tag" | "p_tag_agent",
    matchedTags: string[]
) {
    logger.debug("Routing event to project", {
        eventId: event.id?.slice(0, 8),
        projectId: projectId.slice(0, 16),
        method,
    });
    return logRoutingDecision(
        routingLogger,
        event,
        "routed",
        projectId,
        `Routed via ${method}`,
        method,
        matchedTags
    );
}