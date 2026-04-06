import { describe, expect, it } from "bun:test";
import { afterEach, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { ConversationEmbeddingService } from "../ConversationEmbeddingService";
import type { ConversationRecordInput, MessageRecord, MessageType } from "@/conversations/types";

// --- Helpers ---

/**
 * Create a minimal ConversationRecordInput for testing buildEmbeddingContent.
 *
 * renderConversationXml expects ConversationRecordInput[] which requires:
 * - pubkey: string (canonical Nostr pubkey)
 * - messageType: MessageType ("text" | "tool-call" | "tool-result" | "delegation-marker")
 * - content: string
 * - eventId?: string (used to resolve conversation root event ID)
 *
 * The first entry's eventId becomes the conversation root event ID.
 */
function makeMessage(
    overrides: Partial<ConversationRecordInput> & {
        id?: string;
        role: "user" | "assistant" | "system";
        content: string;
        timestamp?: number;
    }
): ConversationRecordInput {
    const eventId = overrides.eventId ?? "root-event-1";
    return {
        pubkey: overrides.pubkey ?? (overrides.role === "user" ? "user-pubkey-1" : "agent-pubkey-1"),
        messageType: (overrides.messageType ?? "text") as MessageType,
        content: overrides.content,
        eventId,
        timestamp: overrides.timestamp ?? 1000,
        role: overrides.role,
        ...overrides,
    };
}

// --- Tests for buildEmbeddingContent ---

describe("ConversationEmbeddingService", () => {
    describe("buildEmbeddingContent (private, tested via casting)", () => {
        // Access the private method for testing
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const buildEmbeddingContent = (service: ConversationEmbeddingService, messages: readonly ConversationRecordInput[]) =>
            (service as any).buildEmbeddingContent(messages);

        it("returns transcript XML on successful render", () => {
            const service = ConversationEmbeddingService.getInstance();
            const messages = [
                makeMessage({ id: "msg-1", role: "user", content: "Hello", timestamp: 1000 }),
                makeMessage({ id: "msg-2", role: "assistant", content: "Hi there!", timestamp: 2000 }),
            ];

            const result = buildEmbeddingContent(service, messages);

            expect(result.kind).toBe("ok");
            if (result.kind === "ok") {
                expect(result.transcriptXml).toBeString();
                expect(result.transcriptXml.length).toBeGreaterThan(0);
                // Should contain the message content
                expect(result.transcriptXml).toContain("Hello");
                expect(result.transcriptXml).toContain("Hi there!");
            }
        });

        it("returns { kind: 'error' } when renderConversationXml throws", () => {
            // This can happen when there's no root event ID (but our makeMessage helper includes one)
            // To trigger an error, we'd need to construct a message without rootEventId
            const service = ConversationEmbeddingService.getInstance();
            const messages: MessageRecord[] = [
                {
                    id: "msg-no-root",
                    role: "user",
                    content: "Test",
                    timestamp: 1000,
                    // Intentionally missing rootEventId to trigger the error
                } as MessageRecord,
            ];

            const result = buildEmbeddingContent(service, messages);

            expect(result.kind).toBe("error");
        });

        it("includes tool call names when includeToolCalls is true", () => {
            const service = ConversationEmbeddingService.getInstance();
            const messages: ConversationRecordInput[] = [
                {
                    pubkey: "agent-pubkey-1",
                    messageType: "tool-call",
                    content: "I'll help you with that.",
                    eventId: "root-event-1",
                    timestamp: 1000,
                    role: "assistant",
                    toolData: [
                        {
                            toolCallId: "tool-call-1",
                            toolName: "search_files",
                            input: { pattern: "*.ts" },
                        },
                    ],
                },
            ];

            const result = buildEmbeddingContent(service, messages);

            expect(result.kind).toBe("ok");
            if (result.kind === "ok") {
                // The XML should include the tool call name
                expect(result.transcriptXml).toContain("search_files");
            }
        });

        it("computes SHA-256 fingerprint from the XML content", () => {
            const service = ConversationEmbeddingService.getInstance();
            const messages = [
                makeMessage({ id: "msg-1", role: "user", content: "Hello", timestamp: 1000 }),
            ];

            const result = buildEmbeddingContent(service, messages);

            expect(result.kind).toBe("ok");
            if (result.kind === "ok") {
                // Verify it's a valid SHA-256 hex string (64 chars)
                expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);

                // Verify the fingerprint is actually the SHA-256 of the XML
                const expectedFingerprint = createHash("sha256")
                    .update(result.transcriptXml)
                    .digest("hex");
                expect(result.fingerprint).toBe(expectedFingerprint);
            }
        });

        it("handles empty messages array", () => {
            const service = ConversationEmbeddingService.getInstance();
            const messages: ConversationRecordInput[] = [];

            const result = buildEmbeddingContent(service, messages);

            // Empty messages cause renderConversationXml to fail (no root event ID)
            expect(result.kind).toBe("error");
        });

        it("produces different fingerprints for different messages", () => {
            const service = ConversationEmbeddingService.getInstance();

            const messages1 = [
                makeMessage({ id: "msg-1", role: "user", content: "Hello", timestamp: 1000 }),
            ];

            const messages2 = [
                makeMessage({ id: "msg-1", role: "user", content: "Goodbye", timestamp: 1000 }),
            ];

            const result1 = buildEmbeddingContent(service, messages1);
            const result2 = buildEmbeddingContent(service, messages2);

            expect(result1.kind).toBe("ok");
            expect(result2.kind).toBe("ok");

            if (result1.kind === "ok" && result2.kind === "ok") {
                expect(result1.fingerprint).not.toBe(result2.fingerprint);
            }
        });

        it("produces identical fingerprints for identical messages", () => {
            const service = ConversationEmbeddingService.getInstance();

            const messages = [
                makeMessage({ id: "msg-1", role: "user", content: "Hello", timestamp: 1000 }),
            ];

            const result1 = buildEmbeddingContent(service, messages);
            const result2 = buildEmbeddingContent(service, messages);

            expect(result1.kind).toBe("ok");
            expect(result2.kind).toBe("ok");

            if (result1.kind === "ok" && result2.kind === "ok") {
                expect(result1.fingerprint).toBe(result2.fingerprint);
            }
        });
    });

});
