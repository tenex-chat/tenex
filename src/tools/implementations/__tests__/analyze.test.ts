import { analyze } from "../analyze";
import type { ExecutionContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { generateRepomixOutput } from "@/utils/repomix";
import { loadLLMRouter } from "@/llm";
import { Message } from "multi-llm-ts";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock dependencies
vi.mock("@/utils/logger");
vi.mock("@/utils/repomix");
vi.mock("@/llm");
vi.mock("@/nostr/NostrPublisher");
vi.mock("@/llm/types");

describe("analyze tool", () => {
    let mockContext: ExecutionContext;
    let mockPublish: any;
    let mockSign: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockPublish = vi.fn().mockResolvedValue(undefined);
        mockSign = vi.fn().mockResolvedValue(undefined);

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
        vi.mocked(generateRepomixOutput).mockResolvedValue({
            content: "<repository>test content</repository>",
            size: 1000,
            cleanup: vi.fn(),
        });

        // Mock LLM router
        const mockComplete = vi.fn().mockResolvedValue({
            content: "Analysis result",
        });
        vi.mocked(loadLLMRouter).mockResolvedValue({
            complete: mockComplete,
        } as any);

        // Mock NostrPublisher
        const mockCreateBaseReply = vi.fn().mockReturnValue({
            kind: null,
            content: "",
            sign: mockSign,
            publish: mockPublish,
        });

        const MockNostrPublisher = vi.fn().mockImplementation(() => ({
            createBaseReply: mockCreateBaseReply,
        }));

        vi.doMock("@/nostr/NostrPublisher", () => ({
            NostrPublisher: MockNostrPublisher,
        }));

        // Mock EVENT_KINDS
        vi.doMock("@/llm/types", () => ({
            EVENT_KINDS: {
                TYPING_INDICATOR: 24111,
                TYPING_INDICATOR_STOP: 24112,
            },
        }));

        // Execute the tool
        const result = await analyze.execute({ prompt: "find bugs" }, mockContext);

        // Verify typing indicator was published
        expect(MockNostrPublisher).toHaveBeenCalledWith({
            conversation: mockContext.conversation,
            agent: mockContext.agent,
            triggeringEvent: mockContext.triggeringEvent,
        });

        // Verify typing indicator start event
        const startEvent = mockCreateBaseReply.mock.results[0].value;
        expect(startEvent.kind).toBe(24111); // TYPING_INDICATOR
        expect(startEvent.content).toBe("Analyzing repository to find bugs");
        expect(mockSign).toHaveBeenCalled();
        expect(mockPublish).toHaveBeenCalled();

        // Verify typing indicator stop event
        const stopEvent = mockCreateBaseReply.mock.results[1].value;
        expect(stopEvent.kind).toBe(24112); // TYPING_INDICATOR_STOP
        expect(stopEvent.content).toBe("");

        // Verify result
        expect(result.success).toBe(true);
        expect(result.output).toBe("Analysis result");
    });

    it("should handle typing indicator publish failures gracefully", async () => {
        // Mock repomix output
        vi.mocked(generateRepomixOutput).mockResolvedValue({
            content: "<repository>test content</repository>",
            size: 1000,
            cleanup: vi.fn(),
        });

        // Mock LLM router
        vi.mocked(loadLLMRouter).mockResolvedValue({
            complete: vi.fn().mockResolvedValue({ content: "Analysis result" }),
        } as any);

        // Mock NostrPublisher to throw error
        vi.doMock("@/nostr/NostrPublisher", () => ({
            NostrPublisher: vi.fn().mockImplementation(() => {
                throw new Error("Publishing failed");
            }),
        }));

        // Execute should not throw even if typing indicator fails
        const result = await analyze.execute({ prompt: "find bugs" }, mockContext);

        expect(result.success).toBe(true);
        expect(result.output).toBe("Analysis result");
    });
});
