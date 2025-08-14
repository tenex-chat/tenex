import { describe, it, expect, beforeEach, mock } from "@jest/globals";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { ConversationEventProcessor } from "../ConversationEventProcessor";

// Mock the getAgentSlugFromEvent function
mock.module("@/nostr/utils", () => ({
    getAgentSlugFromEvent: (event: NDKEvent) => {
        // Map specific pubkeys to agent slugs for testing
        if (event.pubkey === "executor-pubkey") return "executor";
        if (event.pubkey === "planner-pubkey") return "planner";
        return undefined;
    },
    isEventFromUser: (event: NDKEvent) => event.pubkey === "user-pubkey"
}));

describe("ConversationEventProcessor", () => {
    let processor: ConversationEventProcessor;

    beforeEach(() => {
        processor = new ConversationEventProcessor();
    });

    describe("extractCompletionFromEvent", () => {
        it("should extract completion from event with tool complete tag and valid pubkey", () => {
            const event = {
                content: "Task completed successfully",
                pubkey: "executor-pubkey",
                tags: [
                    ["tool", "complete"]
                ],
                created_at: 1234567890
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toEqual({
                agent: "executor",
                message: "Task completed successfully",
                timestamp: 1234567890
            });
        });

        it("should return null if no tool complete tag", () => {
            const event = {
                content: "Regular message",
                pubkey: "executor-pubkey",
                tags: [],
                created_at: 1234567890
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should return null if pubkey doesn't map to an agent", () => {
            const event = {
                content: "Task completed",
                pubkey: "unknown-pubkey",
                tags: [
                    ["tool", "complete"]
                ],
                created_at: 1234567890
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should return null if no content", () => {
            const event = {
                content: "",
                pubkey: "executor-pubkey",
                tags: [
                    ["tool", "complete"]
                ],
                created_at: 1234567890
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should return null if tool tag is not 'complete'", () => {
            const event = {
                content: "Using a tool",
                pubkey: "executor-pubkey",
                tags: [
                    ["tool", "other-tool"]
                ],
                created_at: 1234567890
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toBeNull();
        });

        it("should work with different agent pubkeys", () => {
            const event = {
                content: "Planning complete",
                pubkey: "planner-pubkey",
                tags: [
                    ["tool", "complete"]
                ],
                created_at: 1234567890
            } as NDKEvent;

            const completion = processor.extractCompletionFromEvent(event);

            expect(completion).toEqual({
                agent: "planner",
                message: "Planning complete",
                timestamp: 1234567890
            });
        });
    });
});