import type { NDKEvent } from "@nostr-dev-kit/ndk";

interface AgentPublishErrorOptions {
    cause?: unknown;
    event: NDKEvent;
    eventType: string;
}

export class AgentPublishError extends Error {
    readonly cause?: unknown;
    readonly event: NDKEvent;
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
        event?: { content?: unknown; tags?: unknown; rawEvent?: unknown };
        eventType?: unknown;
    };

    return Boolean(
        candidate.event &&
        typeof candidate.eventType === "string" &&
        typeof candidate.event.content === "string" &&
        Array.isArray(candidate.event.tags)
    );
}
