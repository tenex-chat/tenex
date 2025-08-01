import { describe, it, expect, beforeEach, mock } from "bun:test";
import { analyze } from "../analyze";
import type { ExecutionContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { generateRepomixOutput } from "@/utils/repomix";
import { loadLLMRouter } from "@/llm";
import { Message } from "multi-llm-ts";

// Mock dependencies
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(),
        error: mock(),
        debug: mock(),
        warn: mock()
    }
}));

mock.module("@/utils/repomix", () => ({
    generateRepomixOutput: mock()
}));

mock.module("@/llm", () => ({
    loadLLMRouter: mock()
}));

mock.module("@/nostr/NostrPublisher", () => ({
    NostrPublisher: mock()
}));

mock.module("@/llm/types", () => ({
    EVENT_KINDS: {
        TYPING_INDICATOR: 24111,
        TYPING_INDICATOR_STOP: 24112,
    }
}));

describe("analyze tool", () => {
    let mockContext: ExecutionContext;
    let mockPublish: any;
    let mockSign: any;

    beforeEach(() => {
        mockPublish = mock(() => Promise.resolve(undefined));
        mockSign = mock(() => Promise.resolve(undefined));

        mockContext = {
            projectPath: "/test/path",
            conversationId: "test-conversation",
            phase: "execution",
            agent: {
                name: "test-agent",
                pubkey: "test-pubkey",
                signer: {
                    sign: mockSign,
                } as any,
                role: "test-role",
                llmConfig: "test-config",
                tools: [],
                slug: "test-agent",
            },
            triggeringEvent: {
                id: "test-event",
                pubkey: "test-pubkey",
            } as any,
            publisher: {
                publishTypingIndicator: mockPublish,
            } as any,
            conversationManager: {} as any,
        };
    });

    it("should publish typing indicator when analyzing", async () => {
        // Mock repomix output
        const repomix = require("@/utils/repomix");
        repomix.generateRepomixOutput.mockImplementation(() => Promise.resolve({
            content: "<repository>test content</repository>",
            size: 1000,
            cleanup: mock(),
        }));

        // Mock LLM router
        const mockComplete = mock(() => Promise.resolve({
            content: "Analysis result",
        }));
        
        const llm = require("@/llm");
        llm.loadLLMRouter.mockImplementation(() => Promise.resolve({
            complete: mockComplete,
        }));

        // Mock NostrPublisher
        const mockCreateBaseReply = mock(() => ({
            kind: null,
            content: "",
            sign: mockSign,
            publish: mockPublish,
        }));

        const nostr = require("@/nostr/NostrPublisher");
        nostr.NostrPublisher.mockImplementation(() => ({
            createBaseReply: mockCreateBaseReply,
        }));

        // Execute the tool
        const result = await analyze.execute({ prompt: "find bugs" }, mockContext);

        // Verify typing indicator was published
        expect(nostr.NostrPublisher).toHaveBeenCalledWith({
            conversation: mockContext.conversation,
            agent: mockContext.agent,
            triggeringEvent: mockContext.triggeringEvent,
        });

        expect(mockCreateBaseReply).toHaveBeenCalled();
        expect(mockPublish).toHaveBeenCalled();
        expect(mockPublish).toHaveBeenCalledTimes(1);

        // Verify the result
        expect(result).toContain("Analysis result");
    });

    it("should handle typing indicator publish failures gracefully", async () => {
        // Mock repomix output
        const repomix = require("@/utils/repomix");
        repomix.generateRepomixOutput.mockImplementation(() => Promise.resolve({
            content: "<repository>test content</repository>",
            size: 1000,
            cleanup: mock(),
        }));

        // Mock LLM router
        const llm = require("@/llm");
        llm.loadLLMRouter.mockImplementation(() => Promise.resolve({
            complete: mock(() => Promise.resolve({ content: "Analysis result" })),
        }));

        // Mock NostrPublisher to throw error
        const nostr = require("@/nostr/NostrPublisher");
        nostr.NostrPublisher.mockImplementation(() => {
            throw new Error("Publishing failed");
        });

        // Execute the tool - should not throw despite publisher error
        const result = await analyze.execute({ prompt: "find bugs" }, mockContext);

        // Verify result is still returned
        expect(result).toContain("Analysis result");
    });
});