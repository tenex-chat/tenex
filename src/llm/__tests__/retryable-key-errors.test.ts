import { describe, expect, test } from "bun:test";
import { isRetryableKeyError } from "../retryable-key-errors";

describe("isRetryableKeyError", () => {
    test("detects AI SDK wrapper errors via toString details", () => {
        const error = new Error("AI_APICallError");
        error.toString = () =>
            'AI_APICallError: {"provider_name":"openrouter","raw":"Rate limit exceeded"}';

        expect(isRetryableKeyError(error)).toBe(true);
    });

    test("returns false for abort errors", () => {
        const error = new Error("request aborted");
        error.name = "AbortError";

        expect(isRetryableKeyError(error)).toBe(false);
    });
});
