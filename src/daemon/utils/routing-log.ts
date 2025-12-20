import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { EventRoutingLogger } from "@/logging/EventRoutingLogger";
import type { RoutingDecision } from "@/daemon/types";
import { logger } from "@/utils/logger";

/**
 * Consolidated routing logging utilities to reduce verbosity
 */

export function logRoutingDecision(
    routingLogger: EventRoutingLogger,
    event: NDKEvent,
    routingDecision: RoutingDecision,
    targetProjectId: string | null,
    routingMethod: "a_tag" | "p_tag_agent" | "none" = "none",
    matchedTags: string[] = [],
    reason?: string
): Promise<void> {
    // Convert complex RoutingDecision to simple string type for logger
    const loggerDecision = routingDecision.type === "route_to_project" ? "routed" : routingDecision.type;

    return routingLogger.logRoutingDecision({
        event,
        routingDecision: loggerDecision as "routed" | "dropped" | "project_event",
        targetProjectId,
        routingMethod,
        matchedTags,
        reason,
    });
}

export function logDropped(
    routingLogger: EventRoutingLogger,
    event: NDKEvent,
    reason: string
): Promise<void> {
    logger.debug(`Event dropped: ${reason}`, {
        eventId: event.id?.slice(0, 8),
        eventKind: event.kind,
        reason,
    });
    const routingDecision: RoutingDecision = {
        type: "dropped",
        reason,
    };
    return logRoutingDecision(routingLogger, event, routingDecision, null, "none", [], reason);
}

export function logRouted(
    routingLogger: EventRoutingLogger,
    event: NDKEvent,
    projectId: string,
    method: "a_tag" | "p_tag_agent",
    matchedTags: string[]
): Promise<void> {
    logger.debug("Routing event to project", {
        eventId: event.id?.slice(0, 8),
        projectId: projectId.slice(0, 16),
        method,
    });
    const routingDecision: RoutingDecision = {
        type: "route_to_project",
        projectId: projectId as import("@/daemon/types").ProjectId,
        method,
        matchedTags,
    };
    return logRoutingDecision(
        routingLogger,
        event,
        routingDecision,
        projectId,
        method,
        matchedTags,
        `Routed via ${method}`
    );
}
