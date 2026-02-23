/**
 * Tests for multimodal message support in ConversationStore
 *
 * These tests verify that messages containing image URLs are properly
 * converted to AI SDK multimodal format (TextPart + ImagePart arrays).
 *
 * Note: Tests use real-looking domains (e.g., images.unsplash.com, cdn.realsite.io)
 * because the module now skips reserved/example domains (example.com, localhost, etc.)
 * that would fail to fetch and crash the agent. See shouldSkipImageUrl for details.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdir, rm } from "fs/promises";
import type { ImagePart, TextPart } from "ai";
import { ConversationStore } from "../ConversationStore";
import * as PubkeyService from "@/services/PubkeyService";

describe("ConversationStore - Multimodal Support", () => {
    const TEST_DIR = "/tmp/tenex-test-conversations-multimodal";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-multimodal";
    const USER_PUBKEY = "user-pk";
    const AGENT_PUBKEY = "agent-pk";

    let store: ConversationStore;
    let pubkeyServiceSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
        // Mock PubkeyService for attribution tests
        pubkeyServiceSpy = spyOn(PubkeyService, "getPubkeyService").mockReturnValue({
            getName: async (pubkey: string) => {
                const names: Record<string, string> = {
                    "user-pk": "User",
                    "agent-pk": "Agent",
                };
                return names[pubkey] ?? "Unknown";
            },
        } as any);

        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
    });

    afterEach(async () => {
        pubkeyServiceSpy.mockRestore();
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe("buildMessagesForRal with image URLs", () => {
        it("should convert user message with image URL to multimodal content", async () => {
            // User sends a message with an image URL
            // Note: Using real-looking domain because example.com is now skipped
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "What's in this image? https://images.unsplash.com/photo.jpg",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("user");

            // Content should be multimodal array
            const content = messages[0].content;
            expect(Array.isArray(content)).toBe(true);

            const parts = content as Array<TextPart | ImagePart>;
            expect(parts.length).toBe(2);

            // First part: text
            expect(parts[0].type).toBe("text");
            expect((parts[0] as TextPart).text).toContain("What's in this image?");

            // Second part: image
            expect(parts[1].type).toBe("image");
            expect((parts[1] as ImagePart).image).toBeInstanceOf(URL);
            expect(((parts[1] as ImagePart).image as URL).href).toBe("https://images.unsplash.com/photo.jpg");
        });

        it("should keep message as string when no image URLs present", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Hello, how are you?",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            expect(messages).toHaveLength(1);
            expect(typeof messages[0].content).toBe("string");
        });

        it("should handle multiple image URLs in one message", async () => {
            // Note: Using real-looking domains because example.com is now skipped
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Compare these: https://images.unsplash.com/a.png and https://cdn.jsdelivr.net/b.jpg",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            const content = messages[0].content as Array<TextPart | ImagePart>;
            expect(content.length).toBe(3); // 1 text + 2 images
            expect(content[0].type).toBe("text");
            expect(content[1].type).toBe("image");
            expect(content[2].type).toBe("image");
        });

        it("should convert multimodal content even without attribution prefix", async () => {
            // Note: Using real-looking domain because example.com is now skipped
            // Attribution prefixes are only added under specific conditions
            // (e.g., when sender is a known agent via computeAttributionPrefix)
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Check this: https://images.unsplash.com/image.png",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            const content = messages[0].content as Array<TextPart | ImagePart>;
            const textPart = content[0] as TextPart;

            // Content should be converted to multimodal format
            expect(textPart.type).toBe("text");
            expect(textPart.text).toContain("Check this:");
        });

        it("should NOT convert assistant messages with image URLs to multimodal", async () => {
            // Agent messages (role=assistant) must NOT get ImagePart injected.
            // The AI SDK ModelMessage[] schema only allows ImagePart in user role messages.
            // Applying multimodal conversion to assistant messages causes:
            //   AI_InvalidPromptError: The messages do not match the ModelMessage[] schema.
            // Regression test for: https://github.com/pablof7z/tenex/issues/xxx
            store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                content: "Here's the result: https://cdn.realsite.io/output.png",
                messageType: "text",
            });
            store.completeRal(AGENT_PUBKEY, 1);

            // New RAL sees the previous message
            const ral2 = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");

            // CRITICAL: content must be a plain string, NOT a multimodal array.
            // The image URL is preserved as text in the string — the agent can still
            // read it, but the AI SDK won't try to fetch it as an image part.
            expect(typeof messages[0].content).toBe("string");
            expect(messages[0].content as string).toContain("https://cdn.realsite.io/output.png");
        });

        it("should not convert tool messages to multimodal", async () => {
            // Tool call/results should stay as-is (they have different content types)
            // Note: URL in tool input is not processed for multimodal conversion
            // Note: Orphaned tool-calls get synthetic results appended (AI SDK validation)
            store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-call",
                toolData: [
                    {
                        type: "tool-call",
                        toolCallId: "call_1",
                        toolName: "upload_blob",
                        input: { input: "https://images.unsplash.com/image.jpg" },
                    },
                ],
            });
            // Add corresponding tool result to avoid orphan reconciliation
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                content: "",
                messageType: "tool-result",
                toolData: [
                    {
                        type: "tool-result",
                        toolCallId: "call_1",
                        toolName: "upload_blob",
                        output: { type: "text", value: "Upload complete" },
                    },
                ],
            });

            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, 1);
            expect(messages).toHaveLength(2); // tool-call + tool-result
            expect(messages[0].role).toBe("assistant");
            // Tool call content should be tool data, not multimodal
            expect(Array.isArray(messages[0].content)).toBe(true);
            const content = messages[0].content as any[];
            expect(content[0].type).toBe("tool-call");
        });

        it("should handle supported image extensions", async () => {
            const extensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

            for (const ext of extensions) {
                // Reset store for each test
                const freshStore = new ConversationStore(TEST_DIR);
                freshStore.load(PROJECT_ID, `conv-${ext}`);

                // Note: Using real-looking domain because example.com is now skipped
                freshStore.addMessage({
                    pubkey: USER_PUBKEY,
                    content: `Image: https://cdn.realsite.io/test${ext}`,
                    messageType: "text",
                });

                const ral = freshStore.createRal(AGENT_PUBKEY);
                const messages = await freshStore.buildMessagesForRal(AGENT_PUBKEY, ral);

                const content = messages[0].content as Array<TextPart | ImagePart>;
                expect(content.length).toBe(2);
                expect(content[1].type).toBe("image");
            }
        });

        it("should handle URLs with query parameters", async () => {
            // Note: Using real-looking domain because cdn.example.com is now skipped
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Image: https://cdn.realsite.io/photo.jpg?size=large&quality=high",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            const content = messages[0].content as Array<TextPart | ImagePart>;
            const imagePart = content[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe(
                "https://cdn.realsite.io/photo.jpg?size=large&quality=high"
            );
        });

        it("should only convert the most recent user message with images to multimodal", async () => {
            // First user message with image
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Look at this: https://images.unsplash.com/first.png",
                messageType: "text",
            });

            // Agent response
            store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                content: "I see the image, it looks great!",
                messageType: "text",
            });
            store.completeRal(AGENT_PUBKEY, 1);

            // Second user message with image (most recent)
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Now look at this one: https://images.unsplash.com/second.png",
                messageType: "text",
            });

            const ral2 = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            // Message 0: first user message — should be plain string (URL as text, NOT multimodal)
            expect(messages[0].role).toBe("user");
            expect(typeof messages[0].content).toBe("string");
            expect(messages[0].content as string).toContain("https://images.unsplash.com/first.png");

            // Message 1: agent response
            expect(messages[1].role).toBe("assistant");

            // Message 2: second user message — should be multimodal (has ImagePart)
            expect(messages[2].role).toBe("user");
            expect(Array.isArray(messages[2].content)).toBe(true);
            const parts = messages[2].content as Array<TextPart | ImagePart>;
            expect(parts.some(p => p.type === "image")).toBe(true);
        });

        it("should convert single user message with image to multimodal", async () => {
            // Only one user message with an image — it IS the most recent, so it should be multimodal
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "What's in this? https://images.unsplash.com/photo.png",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            expect(messages[0].role).toBe("user");
            expect(Array.isArray(messages[0].content)).toBe(true);
            const parts = messages[0].content as Array<TextPart | ImagePart>;
            expect(parts.some(p => p.type === "image")).toBe(true);
        });

        it("should ignore non-image URLs", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Visit https://cdn.realsite.io and check https://cdn.realsite.io/document.pdf",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            // No image URLs, so content should be string
            expect(typeof messages[0].content).toBe("string");
        });
    });
});
