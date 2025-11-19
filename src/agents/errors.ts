/**
 * Agent-specific error types for better error handling
 */

export class AgentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgentError";
    }
}

export class AgentNotFoundError extends AgentError {
    constructor(
        public readonly eventId: string,
        message?: string
    ) {
        super(
            message ||
                `Agent event ${eventId} not found on Nostr relays. The event may not have been published yet or your relays may not have it.`
        );
        this.name = "AgentNotFoundError";
    }
}

export class AgentSlugConflictError extends AgentError {
    constructor(
        public readonly slug: string,
        public readonly existingEventId?: string,
        public readonly newEventId?: string
    ) {
        super(
            `Agent with slug "${slug}" already exists` +
                (existingEventId && newEventId && existingEventId !== newEventId
                    ? ` with different event ID (existing: ${existingEventId}, new: ${newEventId})`
                    : "")
        );
        this.name = "AgentSlugConflictError";
    }
}

export class AgentValidationError extends AgentError {
    constructor(message: string) {
        super(message);
        this.name = "AgentValidationError";
    }
}

export class AgentStorageError extends AgentError {
    constructor(
        message: string,
        public readonly cause?: Error
    ) {
        super(message);
        this.name = "AgentStorageError";
        if (cause) {
            this.cause = cause;
        }
    }
}
