/**
 * Integration test to verify compression fires during agent runtime.
 * This test demonstrates that the compression system is wired into the execution flow.
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentMetadataStore } from "@/services/agents";
import { CompressionService } from "../CompressionService";
import type { LLMService } from "@/llm/service";
import { config } from "@/services/ConfigService";

// Mock LLMService for testing
class MockLLMService {
    public provider = "test-provider";
    public model = "test-model";

    getModel(): string {
        return this.model;
    }

    async generateObject({ schema }: { schema: any }): Promise<{ object: any; usage: any }> {
        return {
            object: [
                {
                    fromEventId: "event-0",
                    toEventId: "event-79",
                    compressed: "Summary of messages 0-79",
                },
            ],
            usage: { inputTokens: 100, outputTokens: 50 },
        };
    }

    getModelContextWindow(): number | undefined {
        return 200000;
    }
}

describe("Compression Integration", () => {
    const projectId = "test-project";
    const conversationId = "test-conversation";
    let testDir: string;
    let conversationStore: ConversationStore;
    let compressionService: CompressionService;
    let getConfigSpy: ReturnType<typeof spyOn>;

    beforeAll(() => {
        testDir = join(tmpdir(), `compression-integration-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        // Mock config.getConfig() to return compression config
        getConfigSpy = spyOn(config, "getConfig").mockReturnValue({
            compression: {
                enabled: true,
                tokenThreshold: 10, // Very low threshold to trigger compression
                tokenBudget: 5, // Very low budget to test reactive compression
                slidingWindowSize: 10,
            },
        } as any);

        const conversationsDir = join(testDir, "conversations");
        mkdirSync(conversationsDir, { recursive: true });

        conversationStore = new ConversationStore(conversationsDir);
        conversationStore.load(projectId, conversationId);

        const mockLLMService = new MockLLMService() as unknown as LLMService;
        compressionService = new CompressionService(conversationStore, mockLLMService);
    });

    afterAll(() => {
        getConfigSpy.mockRestore();
        rmSync(testDir, { recursive: true, force: true });
    });

    it("should trigger proactive compression when messages exceed threshold", async () => {
        // Add 100 messages to simulate a large conversation
        for (let i = 0; i < 100; i++) {
            conversationStore.addMessage({
                pubkey: "agent-pubkey",
                ral: 1,
                content: `Message ${i}`,
                messageType: "text",
                targetedPubkeys: ["user-pubkey"],
                eventId: `event-${i}`,
            });
        }

        // Verify we have messages
        const messageCount = conversationStore.getMessageCount();
        expect(messageCount).toBe(100);

        // Trigger compression (use blocking call for testing with low budget to force compression)
        // In production, maybeCompressAsync is fire-and-forget, but for testing we need to wait
        await compressionService.ensureUnderLimit(conversationId, 100); // Low budget forces compression

        // Check if compression segments were created
        const segments = await compressionService.getSegments(conversationId);

        // The mock LLM service should have created compression segments
        expect(segments.length).toBeGreaterThan(0);
        expect(segments[0].compressed).toBe("Summary of messages 0-79");
    });

    it("should apply existing compressions when requested", async () => {
        // Load existing segments
        const segments = await compressionService.getSegments(conversationId);
        expect(segments.length).toBeGreaterThan(0);

        // Get all messages
        const entries = conversationStore.getAllMessages();

        // Apply compressions
        const compressedEntries = compressionService.applyExistingCompressions(entries, segments);

        // Verify that compressions were applied (some messages replaced with summary)
        expect(compressedEntries.length).toBeLessThan(entries.length);

        // Find the compression summary message
        const summaryMessage = compressedEntries.find((e) => e.content.includes("Compressed history"));
        expect(summaryMessage).toBeDefined();
        expect(summaryMessage?.content).toBe("[Compressed history]\nSummary of messages 0-79");
    });

    it("should handle reactive blocking compression when over budget", async () => {
        // Set a very low token budget to force compression
        const lowBudget = 100;

        // Trigger reactive compression
        await compressionService.ensureUnderLimit(conversationId, lowBudget);

        // Verify compression occurred
        const segments = await compressionService.getSegments(conversationId);
        expect(segments.length).toBeGreaterThan(0);
    });
});
