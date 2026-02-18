/**
 * Tests for ConversationRegistry prefix resolution
 *
 * Verifies that ConversationRegistry.has() and .get() correctly resolve
 * 12-character hex prefixes to full 64-character conversation IDs via PrefixKVStore.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdir, rm } from "fs/promises";
import { conversationRegistry } from "../ConversationRegistry";
import { prefixKVStore, PrefixKVStore } from "@/services/storage";

// Helper to generate unique test IDs (uses timestamp + random to avoid collisions)
function generateUniqueTestId(): string {
    const timestamp = Date.now().toString(16).padStart(12, "0").slice(-12);
    const random = Math.random().toString(16).slice(2).padStart(52, "0").slice(0, 52);
    return timestamp + random;
}

describe("ConversationRegistry Prefix Resolution", () => {
    const TEST_DIR = "/tmp/tenex-test-prefix-resolution";
    const PROJECT_ID = "test-project";
    let originalTenexBaseDir: string | undefined;

    beforeEach(async () => {
        // Save original TENEX_BASE_DIR
        originalTenexBaseDir = process.env.TENEX_BASE_DIR;
        // Use temp directory to avoid polluting ~/.tenex/data/prefix-kv
        process.env.TENEX_BASE_DIR = TEST_DIR;

        // Clean start
        conversationRegistry.reset();
        await mkdir(TEST_DIR, { recursive: true });
        conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_ID}`, []);

        // Force close any existing LMDB handles before reinitializing
        await prefixKVStore.forceClose();

        // Initialize PrefixKVStore for tests (will use temp TENEX_BASE_DIR)
        await prefixKVStore.initialize();
    });

    afterEach(async () => {
        conversationRegistry.reset();
        // Force close LMDB handles to prevent handle leaks
        await prefixKVStore.forceClose();
        await rm(TEST_DIR, { recursive: true, force: true });
        // Restore original TENEX_BASE_DIR
        if (originalTenexBaseDir !== undefined) {
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;
        } else {
            delete process.env.TENEX_BASE_DIR;
        }
        // Restore mocks
        mock.restore();
    });

    describe("resolveConversationId (via get/has)", () => {
        it("should pass through 64-char IDs unchanged", () => {
            const testId = generateUniqueTestId();
            // Full IDs should work as-is (even if conversation doesn't exist)
            const result = conversationRegistry.get(testId);
            // Will be undefined since conversation doesn't exist, but no error
            expect(result).toBeUndefined();
        });

        it("should resolve 12-char prefix when PrefixKVStore has the mapping", async () => {
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);

            // Create a conversation so it exists in the registry
            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message for prefix resolution",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Verify PrefixKVStore has the mapping (prerequisite)
            const lookup = prefixKVStore.lookup(testPrefix);
            expect(lookup).toBe(testId);

            // Now actually exercise ConversationRegistry with the prefix
            // This is the key assertion - verifying prefix resolution via ConversationRegistry
            expect(conversationRegistry.has(testPrefix)).toBe(true);

            const store = conversationRegistry.get(testPrefix);
            expect(store).toBeDefined();
            expect(store?.id).toBe(testId);
        });

        it("should return undefined for unknown 12-char prefix", () => {
            // Use a prefix that's unlikely to exist
            const unknownPrefix = generateUniqueTestId().substring(0, 12);
            const result = conversationRegistry.get(unknownPrefix);
            expect(result).toBeUndefined();
        });

        it("has() should return false for unknown prefix", () => {
            const unknownPrefix = generateUniqueTestId().substring(0, 12);
            expect(conversationRegistry.has(unknownPrefix)).toBe(false);
        });

        it("should handle case-insensitive prefixes via ConversationRegistry", async () => {
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);

            // Create a conversation so it exists in the registry
            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test for case insensitive lookup",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // The uppercase prefix should be normalized and work with ConversationRegistry
            const upperCasePrefix = testPrefix.toUpperCase();

            // ConversationRegistry.has() should normalize the case and find the conversation
            expect(conversationRegistry.has(upperCasePrefix)).toBe(true);

            // ConversationRegistry.get() should also work with uppercase prefix
            const store = conversationRegistry.get(upperCasePrefix);
            expect(store).toBeDefined();
            expect(store?.id).toBe(testId);
        });
    });

    describe("create() indexes conversation ID", () => {
        it("should add conversation ID to PrefixKVStore on create", async () => {
            const testId = generateUniqueTestId();

            // Create a mock NDKEvent
            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // Spy on prefixKVStore.add
            const addSpy = spyOn(prefixKVStore, "add");

            // Create the conversation
            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Verify prefixKVStore.add was called with the conversation ID
            expect(addSpy).toHaveBeenCalledWith(testId);
        });

        it("should allow lookup by prefix after create", async () => {
            // Create a mock NDKEvent with a unique ID for this test
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message for prefix lookup",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // Create the conversation
            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // The conversation should now be retrievable by prefix
            // First verify it's in PrefixKVStore
            const resolvedId = prefixKVStore.lookup(testPrefix);
            expect(resolvedId).toBe(testId);

            // Then verify get() works with prefix
            const store = conversationRegistry.get(testPrefix);
            expect(store).toBeDefined();
            expect(store?.id).toBe(testId);
        });
    });

    describe("integration with has()", () => {
        it("has() with full ID returns true when conversation exists", async () => {
            const testId = generateUniqueTestId();

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            expect(conversationRegistry.has(testId)).toBe(true);
        });

        it("has() with 12-char prefix returns true when conversation exists", async () => {
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Should find conversation by prefix
            expect(conversationRegistry.has(testPrefix)).toBe(true);
        });
    });

    describe("getOrLoad() prefix resolution", () => {
        it("getOrLoad() should resolve 12-char prefix to full ID", async () => {
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message for getOrLoad prefix",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Clear in-memory cache
            conversationRegistry.reset();
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_ID}`, []);

            // getOrLoad should work with prefix
            const store = conversationRegistry.getOrLoad(testPrefix);
            expect(store).toBeDefined();
            expect(store.id).toBe(testId);
        });

        it("getOrLoad() should handle uppercase prefix", async () => {
            const testId = generateUniqueTestId();
            const upperCasePrefix = testId.substring(0, 12).toUpperCase();

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message for getOrLoad uppercase",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Clear in-memory cache
            conversationRegistry.reset();
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_ID}`, []);

            // getOrLoad should normalize case and work
            const store = conversationRegistry.getOrLoad(upperCasePrefix);
            expect(store).toBeDefined();
            expect(store.id).toBe(testId);
        });
    });

    describe("on-disk resolution after cache clear", () => {
        it("should resolve prefix after clearing in-memory cache (simulating reload)", async () => {
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message for disk persistence",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // Create the conversation (indexes to disk)
            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Verify it's in memory first
            expect(conversationRegistry.get(testPrefix)).toBeDefined();

            // Clear the in-memory cache by resetting the registry
            // BUT keep PrefixKVStore intact (simulating daemon restart with persisted data)
            conversationRegistry.reset();

            // Re-initialize the registry with the same project path
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_ID}`, []);

            // Now the in-memory cache is empty, but the conversation file and
            // prefix mapping should still exist on disk.
            // The prefix should still resolve via PrefixKVStore
            const resolved = prefixKVStore.lookup(testPrefix);
            expect(resolved).toBe(testId);

            // ConversationRegistry.get() should be able to load from disk using prefix
            const store = conversationRegistry.get(testPrefix);
            expect(store).toBeDefined();
            expect(store?.id).toBe(testId);
        });

        it("should resolve uppercase prefix after cache clear", async () => {
            const testId = generateUniqueTestId();
            const testPrefix = testId.substring(0, 12);
            const upperCasePrefix = testPrefix.toUpperCase();

            const mockEvent = {
                id: testId,
                pubkey: "user-pubkey",
                content: "Test message for case normalization",
                kind: 1,
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
                getMatchingTags: () => [],
                tagValue: () => undefined,
            };

            // @ts-expect-error - Using minimal mock event
            await conversationRegistry.create(mockEvent);

            // Clear in-memory cache
            conversationRegistry.reset();
            conversationRegistry.initialize(`${TEST_DIR}/${PROJECT_ID}`, []);

            // Uppercase prefix should be normalized and work
            expect(conversationRegistry.has(upperCasePrefix)).toBe(true);
            const store = conversationRegistry.get(upperCasePrefix);
            expect(store).toBeDefined();
            expect(store?.id).toBe(testId);
        });
    });
});
