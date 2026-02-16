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
        public readonly existingPubkey?: string,
        public readonly attemptedPubkey?: string
    ) {
        const message = `Agent slug conflict: slug "${slug}" already claimed by different agent`;
        const details = existingPubkey && attemptedPubkey
            ? `\nExisting agent: ${existingPubkey.substring(0, 12)}...` +
              `\nAttempted agent: ${attemptedPubkey.substring(0, 12)}...` +
              `\n\nSuggestion: Remove the existing agent from overlapping projects or use a different slug.`
            : "";

        super(message + details);
        this.name = "AgentSlugConflictError";
    }
}

export class AgentValidationError extends AgentError {
    constructor(message: string) {
        super(message);
        this.name = "AgentValidationError";
    }
}
