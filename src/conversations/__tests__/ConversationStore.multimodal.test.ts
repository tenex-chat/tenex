/**
 * Tests for multimodal message support in ConversationStore
 *
 * These tests verify that messages containing image URLs are properly
 * converted to AI SDK multimodal format (TextPart + ImagePart arrays).
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
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
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "What's in this image? https://example.com/photo.jpg",
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
            expect(((parts[1] as ImagePart).image as URL).href).toBe("https://example.com/photo.jpg");
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
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Compare these: https://example.com/a.png and https://example.com/b.jpg",
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

        it("should preserve attribution prefix in multimodal text", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Check this: https://example.com/image.png",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            const content = messages[0].content as Array<TextPart | ImagePart>;
            const textPart = content[0] as TextPart;

            // Attribution prefix should be present
            expect(textPart.text).toContain("[@User]");
        });

        it("should handle agent messages with image URLs", async () => {
            // Agent 1 sends message with image
            store.createRal(AGENT_PUBKEY);
            store.addMessage({
                pubkey: AGENT_PUBKEY,
                ral: 1,
                content: "Here's the result: https://cdn.example.com/output.png",
                messageType: "text",
            });
            store.completeRal(AGENT_PUBKEY, 1);

            // New RAL sees the previous message
            const ral2 = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral2);

            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe("assistant");

            const content = messages[0].content as Array<TextPart | ImagePart>;
            expect(Array.isArray(content)).toBe(true);
            expect(content[1].type).toBe("image");
        });

        it("should not convert tool messages to multimodal", async () => {
            // Tool call/results should stay as-is (they have different content types)
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
                        input: { input: "https://example.com/image.jpg" },
                    },
                ],
            });

            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, 1);
            expect(messages).toHaveLength(1);
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

                freshStore.addMessage({
                    pubkey: USER_PUBKEY,
                    content: `Image: https://example.com/test${ext}`,
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
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Image: https://cdn.example.com/photo.jpg?size=large&quality=high",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            const content = messages[0].content as Array<TextPart | ImagePart>;
            const imagePart = content[1] as ImagePart;
            expect((imagePart.image as URL).href).toBe(
                "https://cdn.example.com/photo.jpg?size=large&quality=high"
            );
        });

        it("should ignore non-image URLs", async () => {
            store.addMessage({
                pubkey: USER_PUBKEY,
                content: "Visit https://example.com and check https://example.com/doc.pdf",
                messageType: "text",
            });

            const ral = store.createRal(AGENT_PUBKEY);
            const messages = await store.buildMessagesForRal(AGENT_PUBKEY, ral);

            // No image URLs, so content should be string
            expect(typeof messages[0].content).toBe("string");
        });
    });
});
