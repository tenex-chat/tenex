import type { PublishedMessageRef } from "@/events/runtime/AgentRuntimePublisher";

interface AgentPublishErrorOptions {
    cause?: unknown;
    event: PublishedMessageRef;
    eventType: string;
}

export class AgentPublishError extends Error {
    readonly cause?: unknown;
    readonly event: PublishedMessageRef;
    readonly eventType: string;

    constructor(message: string, options: AgentPublishErrorOptions) {
        super(message);
        this.name = "AgentPublishError";
        this.cause = options.cause;
        this.event = options.event;
        this.eventType = options.eventType;
    }
}

export function isAgentPublishError(error: unknown): error is AgentPublishError {
    if (error instanceof AgentPublishError) {
        return true;
    }

    if (!error || typeof error !== "object") {
        return false;
    }

    const candidate = error as {
        event?: { id?: unknown; transport?: unknown };
        eventType?: unknown;
    };

    return Boolean(
        candidate.event &&
        typeof candidate.eventType === "string" &&
        typeof candidate.event.id === "string" &&
        typeof candidate.event.transport === "string"
    );
}
