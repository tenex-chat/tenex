/**
 * Regression test: cross-project conversation lookup for scheduled tasks.
 *
 * Bug: One-off scheduled tasks that target a conversation in a different project
 * silently failed. ConversationStore.findByEventId() only checks in-memory stores,
 * so the conversation was never found and the task was dropped.
 *
 * Fix: ConversationResolver now calls ConversationStore.get() after the in-memory
 * miss. ConversationStore.get() performs a disk-based scan across all known project
 * directories, finding the conversation even when it lives in a different project.
 *
 * The e-tag on a scheduled task must point to the root conversation event ID (the
 * conversation anchor), not an arbitrary child event. ConversationStore.get()
 * resolves by that root ID directly to its on-disk file.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../ConversationStore";
import { conversationRegistry } from "../../ConversationRegistry";
import { ConversationResolver } from "../ConversationResolver";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import { logger } from "@/utils/logger";

describe("ConversationResolver: cross-project scheduled task lookup", () => {
    // Use a 64-char hex ID as the root conversation anchor.
    // This is the ID the scheduled task's e-tag points at and the filename
    // ConversationStore.get() looks up on disk.
    const CONVERSATION_ID = "a".repeat(64);

    // PROJECT_A is running the scheduled task handler.
    // PROJECT_B is where the conversation was originally created and persisted.
    const PROJECT_A = "project-a";
    const PROJECT_B = "project-b";

    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), "tenex-cross-project-"));

        // Write a conversation in project-b with one message so
        // ConversationStore.get() considers it non-empty and returns it.
        const convDir = join(testDir, PROJECT_B, "conversations");
        mkdirSync(convDir, { recursive: true });
        writeFileSync(
            join(convDir, `${CONVERSATION_ID}.json`),
            JSON.stringify({
                messages: [
                    {
                        pubkey: "user-pubkey",
                        content: "Hello from project-b",
                        messageType: "text",
                        eventId: CONVERSATION_ID,
                        timestamp: 1700000000000,
                    },
                ],
                metadata: {},
            })
        );

        // Initialize the registry with project-a as the current project.
        // _basePath becomes testDir; currentProjectId resolves to "project-a"
        // via the single-project shortcut.
        conversationRegistry.reset();
        conversationRegistry.initialize(join(testDir, PROJECT_A), []);
    });

    afterEach(async () => {
        conversationRegistry.reset();
        await rm(testDir, { recursive: true, force: true });
    });

    it("in-memory lookup misses but disk fallback finds the conversation in another project", () => {
        // Verify the in-memory path misses — registry was just reset, no stores loaded.
        expect(ConversationStore.findByEventId(CONVERSATION_ID)).toBeUndefined();

        // The disk-based fallback (ConversationStore.get) scans project-b and finds it.
        const found = ConversationStore.get(CONVERSATION_ID);

        expect(found).toBeDefined();
        expect(found!.id).toBe(CONVERSATION_ID);
        expect(found!.getProjectId()).toBe(PROJECT_B);
    });

    it("resolveConversationForEvent returns the cross-project conversation via disk fallback", async () => {
        const resolver = new ConversationResolver();

        // Envelope simulates a scheduled task reply. replyToId is the root conversation
        // anchor (plain 64-char hex, no transport prefix) so toNativeId() passes it
        // through unchanged to ConversationStore.get().
        const envelope = createMockInboundEnvelope({
            message: {
                id: "scheduled-task-trigger-event",
                transport: "nostr",
                nativeId: "scheduled-task-trigger-event",
                replyToId: CONVERSATION_ID,
            },
        });

        const result = await resolver.resolveConversationForEvent(envelope);

        // The fix: conversation is found via disk fallback, not treated as an orphan.
        expect(result.conversation).toBeDefined();
        expect(result.conversation!.id).toBe(CONVERSATION_ID);
        // The conversation belongs to project-b, not project-a where the task ran.
        expect(result.conversation!.getProjectId()).toBe(PROJECT_B);
        // isNew must be falsy — this is a pre-existing conversation, not a new one.
        expect(result.isNew).toBeUndefined();
    });

    it("returns undefined and logs a warning when replyToId is not found in any project", async () => {
        // An ID that has no corresponding file in any project directory.
        const NONEXISTENT_ID = "f".repeat(64);

        const warnSpy = spyOn(logger, "warn");
        try {
            const resolver = new ConversationResolver();

            // No recipients → getMentionedPubkeys returns [] → handleOrphanedReply
            // returns undefined immediately without making network calls.
            const envelope = createMockInboundEnvelope({
                message: {
                    id: "orphaned-trigger-event",
                    transport: "nostr",
                    nativeId: "orphaned-trigger-event",
                    replyToId: NONEXISTENT_ID,
                },
            });

            const result = await resolver.resolveConversationForEvent(envelope);

            expect(result.conversation).toBeUndefined();
            expect(warnSpy).toHaveBeenCalledWith(
                "[ConversationResolver] Could not resolve conversation for reply target",
                expect.objectContaining({ replyTargetId: expect.any(String) })
            );
        } finally {
            warnSpy.mockRestore();
        }
    });
});
