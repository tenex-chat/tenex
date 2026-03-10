/**
 * Retry classification for LLM provider key errors.
 *
 * Determines whether a failed LLM request should be retried with a
 * different API key. This is LLM runtime policy — not display formatting.
 */

/**
 * HTTP status codes that indicate a key-specific problem worth retrying
 * with a different key.
 */
const RETRYABLE_STATUS_CODES = new Set([401, 403, 429]);

/**
 * Patterns in error messages that indicate key-specific failures
 * when no structured status code is available.
 */
const RETRYABLE_MESSAGE_PATTERNS = [
    /\b401\b/,
    /\b403\b/,
    /\b429\b/,
    /unauthorized/i,
    /forbidden/i,
    /rate.?limit/i,
    /quota.?exhaust/i,
    /quota.?exceed/i,
    /invalid.?api.?key/i,
    /invalid.?auth/i,
];

/**
 * Check whether an LLM request error is retryable by rotating to a different API key.
 *
 * Retryable:
 *   - 401 Unauthorized
 *   - 403 Forbidden
 *   - 429 Rate Limited / quota exhausted
 *
 * Not retryable:
 *   - Aborted requests (AbortError / user cancellation)
 *   - 422 Bad request / validation
 *   - 5xx Server errors (switching keys won't help)
 *   - Generic network errors (switching keys won't help)
 */
export function isRetryableKeyError(error: unknown): boolean {
    if (error == null) return false;

    // Never retry aborted requests
    if (isAbortError(error)) return false;

    // Check structured status code first
    const statusCode = extractStatusCode(error);
    if (statusCode !== undefined) {
        return RETRYABLE_STATUS_CODES.has(statusCode);
    }

    return extractCandidateTexts(error).some(text =>
        RETRYABLE_MESSAGE_PATTERNS.some(pattern => pattern.test(text))
    );
}

function isAbortError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === "AbortError") return true;
    if (error instanceof Error && error.name === "AbortError") return true;
    if (error instanceof Error && error.message.includes("aborted")) return true;
    return false;
}

function extractStatusCode(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined;

    // Direct status property (common in HTTP error objects)
    const record = error as Record<string, unknown>;
    if (typeof record.status === "number") return record.status;
    if (typeof record.statusCode === "number") return record.statusCode;

    // Nested in response object
    if (typeof record.response === "object" && record.response !== null) {
        const response = record.response as Record<string, unknown>;
        if (typeof response.status === "number") return response.status;
        if (typeof response.statusCode === "number") return response.statusCode;
    }

    // AI SDK wraps provider errors with a data property
    if (typeof record.data === "object" && record.data !== null) {
        const data = record.data as Record<string, unknown>;
        if (typeof data.status === "number") return data.status;
        if (typeof data.statusCode === "number") return data.statusCode;
    }

    return undefined;
}

function extractCandidateTexts(error: unknown): string[] {
    const candidates = new Set<string>();

    if (error instanceof Error) {
        if (error.message) {
            candidates.add(error.message);
        }

        const errorString = error.toString();
        if (errorString && errorString !== error.message) {
            candidates.add(errorString);
        }
    } else if (typeof error === "string") {
        candidates.add(error);
    }

    return Array.from(candidates);
}
