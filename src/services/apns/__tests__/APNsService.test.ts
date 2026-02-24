import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * Tests for APNsService.
 *
 * Verifies:
 * - Service initialization (enabled/disabled)
 * - Config validation (missing required fields)
 * - Token registration from kind 25000 events
 * - Token deregistration
 * - Push notification dispatch
 * - Invalid token cleanup (410 Gone)
 * - Graceful no-op when disabled
 * - Error paths (decrypt failure, JSON parse failure, invalid config)
 * - Token store persistence (load/save to disk)
 */

// Shared mock for nip44Decrypt
const mockNip44Decrypt = mock((_senderPubkey: string, _content: string, _signer: unknown) =>
    Promise.resolve("{}")
);

// Track event handler registered via onEvent callback in subscribe options
let capturedEventHandler: ((event: unknown) => void) | null = null;

const mockGetConfig = mock(() => ({
    apns: {
        enabled: true,
        keyPath: "/tmp/test-key.p8",
        keyId: "TESTKEY123",
        teamId: "TESTTEAM",
        bundleId: "com.test.tenex",
        production: false,
    },
}));

const mockBackendSigner = {
    user: () => Promise.resolve({ pubkey: "backend-pubkey-hex" }),
};

mock.module("@/services/ConfigService", () => ({
    config: {
        getConfig: mockGetConfig,
        getBackendSigner: mock(() => Promise.resolve(mockBackendSigner)),
        getConfigPath: mock(() => "/tmp/test-apns"),
        getGlobalPath: mock(() => "/tmp/test-apns"),
        getProjectsBase: mock(() => "/tmp/test-apns/projects"),
        loadConfig: mock(() => Promise.resolve({ config: mockGetConfig() })),
    },
}));

// Mock AgentStorage to avoid transitive dependency on ConfigService.getConfigPath
mock.module("@/agents/AgentStorage", () => ({
    agentStorage: {
        getIndex: mock(() => ({})),
        getAgent: mock(() => null),
    },
}));

// Mock ConversationStore to avoid circular dependency issues
mock.module("@/conversations/ConversationStore", () => ({
    ConversationStore: {
        get: mock(() => null),
        create: mock(() => Promise.resolve()),
        reset: mock(() => {}),
    },
}));

mock.module("@/nostr/ndkClient", () => ({
    getNDK: () => ({
        subscribe: mock((_filter: unknown, opts: { onEvent?: (event: unknown) => void }) => {
            if (opts?.onEvent) {
                capturedEventHandler = opts.onEvent;
            }
            return {
                stop: mock(() => {}),
            };
        }),
    }),
}));

// Mock the nostr encryption wrapper
mock.module("@/nostr/encryption", () => ({
    nip44Decrypt: mockNip44Decrypt,
}));

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
    },
}));

// Mock filesystem for token persistence
const mockReadJsonFile = mock((_path: string) => Promise.resolve(null));
const mockWriteJsonFile = mock((_path: string, _data: unknown) => Promise.resolve());

mock.module("@/lib/fs/filesystem", () => ({
    readJsonFile: mockReadJsonFile,
    writeJsonFile: mockWriteJsonFile,
}));

// Mock APNsClient via factory injection (avoids mock.module cross-file leaks)
const mockSend = mock((_token: string, _payload: unknown) =>
    Promise.resolve({ success: true, statusCode: 200 })
);

import { APNsService } from "../APNsService";

/** Helper: simulate a kind 25000 event via the captured onEvent handler. */
async function simulateEvent(pubkey: string, decryptedContent: string): Promise<void> {
    mockNip44Decrypt.mockReturnValueOnce(Promise.resolve(decryptedContent));
    expect(capturedEventHandler).not.toBeNull();
    // onEvent fires synchronously but handleConfigUpdateEvent is async and caught via .catch()
    // We need to wait for the async handler to settle
    capturedEventHandler!({
        pubkey,
        content: "encrypted",
        id: "ev-" + Math.random().toString(36).slice(2, 6),
    });
    // Allow microtask queue to flush (the .catch() handler)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("APNsService", () => {
    beforeEach(() => {
        APNsService.resetInstance();
        mockSend.mockClear();
        mockGetConfig.mockClear();
        mockNip44Decrypt.mockClear();
        mockReadJsonFile.mockClear();
        mockWriteJsonFile.mockClear();
        capturedEventHandler = null;

        // Default: no persisted tokens
        mockReadJsonFile.mockReturnValue(Promise.resolve(null));
        mockWriteJsonFile.mockReturnValue(Promise.resolve());

        // Inject mock client via factory (no mock.module needed)
        const service = APNsService.getInstance();
        service.createClient = () => ({ send: mockSend });
    });

    afterEach(() => {
        APNsService.resetInstance();
    });

    describe("initialization", () => {
        it("initializes when APNs is enabled with valid config", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(true);
        });

        it("does not initialize when APNs is disabled", async () => {
            mockGetConfig.mockReturnValueOnce({ apns: { enabled: false } });

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(false);
        });

        it("does not initialize when APNs config is missing", async () => {
            mockGetConfig.mockReturnValueOnce({});

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(false);
        });

        it("does not enable when required fields are missing", async () => {
            mockGetConfig.mockReturnValueOnce({
                apns: {
                    enabled: true,
                    keyPath: "/tmp/test.p8",
                    // Missing keyId, teamId, bundleId
                },
            });

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(false);
        });

        it("allows re-initialization after disabled config", async () => {
            // First call: disabled
            mockGetConfig.mockReturnValueOnce({ apns: { enabled: false } });

            const service = APNsService.getInstance();
            await service.initialize();
            expect(service.isEnabled()).toBe(false);

            // Second call: now enabled (config changed at runtime)
            mockGetConfig.mockReturnValueOnce({
                apns: {
                    enabled: true,
                    keyPath: "/tmp/test-key.p8",
                    keyId: "TESTKEY123",
                    teamId: "TESTTEAM",
                    bundleId: "com.test.tenex",
                    production: false,
                },
            });

            await service.initialize();
            expect(service.isEnabled()).toBe(true);
        });

        it("allows re-initialization after missing config fields", async () => {
            // First call: missing fields
            mockGetConfig.mockReturnValueOnce({
                apns: { enabled: true, keyPath: "/tmp/test.p8" },
            });

            const service = APNsService.getInstance();
            await service.initialize();
            expect(service.isEnabled()).toBe(false);

            // Second call: all fields present
            await service.initialize();
            expect(service.isEnabled()).toBe(true);
        });

        it("registers subscription event handler on init", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            expect(capturedEventHandler).not.toBeNull();
        });
    });

    describe("token registration via event handler", () => {
        it("registers token from encrypted kind 25000 event", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            await simulateEvent(
                "user-pubkey-hex",
                JSON.stringify({
                    notifications: { enable: true, apn_token: "device-token-abc123" },
                })
            );

            expect(service.hasTokens("user-pubkey-hex")).toBe(true);
        });

        it("removes all tokens when enable is false", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Register a token first
            await simulateEvent(
                "user-1",
                JSON.stringify({
                    notifications: { enable: true, apn_token: "token-1" },
                })
            );

            expect(service.hasTokens("user-1")).toBe(true);

            // Now disable
            await simulateEvent(
                "user-1",
                JSON.stringify({
                    notifications: { enable: false, apn_token: "" },
                })
            );

            expect(service.hasTokens("user-1")).toBe(false);
        });

        it("ignores events without notifications section", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            await simulateEvent("user-1", JSON.stringify({ someOtherConfig: true }));

            expect(service.hasTokens("user-1")).toBe(false);
        });

        it("handles decrypt failure gracefully", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Simulate decrypt throwing an error
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.reject(new Error("Decryption failed: invalid ciphertext"))
            );

            expect(capturedEventHandler).not.toBeNull();
            capturedEventHandler!({
                pubkey: "user-1",
                content: "bad-encrypted-content",
                id: "ev-1",
            });
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(service.hasTokens("user-1")).toBe(false);
        });

        it("handles JSON parse failure gracefully", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Return invalid JSON from decrypt
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve("this is not valid JSON {{{")
            );

            expect(capturedEventHandler).not.toBeNull();
            capturedEventHandler!({
                pubkey: "user-1",
                content: "encrypted",
                id: "ev-1",
            });
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(service.hasTokens("user-1")).toBe(false);
        });
    });

    describe("notifyIfNeeded", () => {
        it("no-ops when service is disabled", async () => {
            mockGetConfig.mockReturnValueOnce({});

            const service = APNsService.getInstance();
            await service.initialize();

            await service.notifyIfNeeded("some-pubkey", {
                title: "Test",
                body: "Test body",
                conversationId: "conv-1",
                eventId: "event-1",
            });

            expect(mockSend).not.toHaveBeenCalled();
        });

        it("no-ops when user has no tokens", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            await service.notifyIfNeeded("unknown-user", {
                title: "Test",
                body: "Test body",
                conversationId: "conv-1",
                eventId: "event-1",
            });

            expect(mockSend).not.toHaveBeenCalled();
        });

        it("sends push to registered tokens", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Register token
            await simulateEvent(
                "user-pubkey-hex",
                JSON.stringify({
                    notifications: { enable: true, apn_token: "device-token-abc123" },
                })
            );

            // Send notification
            await service.notifyIfNeeded("user-pubkey-hex", {
                title: "Agent needs input",
                body: "What should I do?",
                conversationId: "conv-1",
                eventId: "event-1",
            });

            expect(mockSend).toHaveBeenCalledTimes(1);
            const [token, payload] = mockSend.mock.calls[0] as [string, { aps: { alert: { title: string; body: string } } }];
            expect(token).toBe("device-token-abc123");
            expect(payload.aps.alert.title).toBe("Agent needs input");
            expect(payload.aps.alert.body).toBe("What should I do?");
        });

        it("removes invalid tokens on 410 Gone", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Register token
            await simulateEvent(
                "user-pubkey-hex",
                JSON.stringify({
                    notifications: { enable: true, apn_token: "invalid-token" },
                })
            );

            expect(service.hasTokens("user-pubkey-hex")).toBe(true);

            // Mock 410 response
            mockSend.mockReturnValueOnce(
                Promise.resolve({
                    success: false,
                    statusCode: 410,
                    reason: "Unregistered",
                    timestampMs: Date.now(),
                })
            );

            await service.notifyIfNeeded("user-pubkey-hex", {
                title: "Test",
                body: "Test",
                conversationId: "conv-1",
                eventId: "event-1",
            });

            expect(service.hasTokens("user-pubkey-hex")).toBe(false);
        });

        it("removes tokens with BadDeviceToken reason", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Register token
            await simulateEvent(
                "user-1",
                JSON.stringify({
                    notifications: { enable: true, apn_token: "bad-token" },
                })
            );

            mockSend.mockReturnValueOnce(
                Promise.resolve({
                    success: false,
                    statusCode: 400,
                    reason: "BadDeviceToken",
                })
            );

            await service.notifyIfNeeded("user-1", {
                title: "T",
                body: "B",
                conversationId: "c",
                eventId: "e",
            });

            expect(service.hasTokens("user-1")).toBe(false);
        });
    });

    describe("token store persistence", () => {
        it("loads tokens from disk on initialize", async () => {
            mockReadJsonFile.mockReturnValueOnce(
                Promise.resolve({
                    "user-a": ["token-1", "token-2"],
                    "user-b": ["token-3"],
                })
            );

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.hasTokens("user-a")).toBe(true);
            expect(service.hasTokens("user-b")).toBe(true);
            expect(service.hasTokens("user-c")).toBe(false);
        });

        it("persists tokens to disk after registration", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            await simulateEvent(
                "user-1",
                JSON.stringify({
                    notifications: { enable: true, apn_token: "token-abc" },
                })
            );

            expect(mockWriteJsonFile).toHaveBeenCalled();
            const lastCall = mockWriteJsonFile.mock.calls[mockWriteJsonFile.mock.calls.length - 1] as [string, Record<string, string[]>];
            expect(lastCall[1]).toEqual({ "user-1": ["token-abc"] });
        });

        it("persists tokens to disk after deregistration", async () => {
            // Start with a persisted token
            mockReadJsonFile.mockReturnValueOnce(
                Promise.resolve({
                    "user-1": ["token-abc"],
                })
            );

            const service = APNsService.getInstance();
            await service.initialize();

            mockWriteJsonFile.mockClear();

            // Disable notifications
            await simulateEvent(
                "user-1",
                JSON.stringify({
                    notifications: { enable: false },
                })
            );

            expect(mockWriteJsonFile).toHaveBeenCalled();
            const lastCall = mockWriteJsonFile.mock.calls[mockWriteJsonFile.mock.calls.length - 1] as [string, Record<string, string[]>];
            expect(lastCall[1]).toEqual({});
        });

        it("starts empty when token file is missing", async () => {
            mockReadJsonFile.mockReturnValueOnce(Promise.resolve(null));

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(true);
            expect(service.hasTokens("any-user")).toBe(false);
        });

        it("starts empty when token file is corrupt", async () => {
            mockReadJsonFile.mockReturnValueOnce(Promise.reject(new Error("Unexpected token")));

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.isEnabled()).toBe(true);
            expect(service.hasTokens("any-user")).toBe(false);
        });

        it("skips empty arrays when loading", async () => {
            mockReadJsonFile.mockReturnValueOnce(
                Promise.resolve({
                    "user-a": [],
                    "user-b": ["token-1"],
                })
            );

            const service = APNsService.getInstance();
            await service.initialize();

            expect(service.hasTokens("user-a")).toBe(false);
            expect(service.hasTokens("user-b")).toBe(true);
        });
    });

    describe("shutdown", () => {
        it("cleans up resources on shutdown", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            service.shutdown();

            expect(service.isEnabled()).toBe(false);
        });
    });
});
