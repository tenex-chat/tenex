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
 */

// Shared mock for nip44Decrypt
const mockNip44Decrypt = mock((_senderPubkey: string, _content: string, _signer: unknown) =>
    Promise.resolve("{}")
);

// Track event handler registered on subscription
let capturedEventHandler: ((event: unknown) => Promise<void>) | null = null;

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
        subscribe: mock(() => ({
            on: mock((event: string, handler: (...args: unknown[]) => void) => {
                if (event === "event") {
                    capturedEventHandler = handler as (event: unknown) => Promise<void>;
                }
            }),
            stop: mock(() => {}),
        })),
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

// Mock APNsClient via factory injection (avoids mock.module cross-file leaks)
const mockSend = mock((_token: string, _payload: unknown) =>
    Promise.resolve({ success: true, statusCode: 200 })
);

import { APNsService } from "../APNsService";

describe("APNsService", () => {
    beforeEach(() => {
        APNsService.resetInstance();
        mockSend.mockClear();
        mockGetConfig.mockClear();
        mockNip44Decrypt.mockClear();
        capturedEventHandler = null;

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

            expect(capturedEventHandler).toBeDefined();
        });
    });

    describe("token registration via event handler", () => {
        it("registers token from encrypted kind 25000 event", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Configure mock decrypt to return token registration
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(
                    JSON.stringify({
                        notifications: { enable: true, apn_token: "device-token-abc123" },
                    })
                )
            );

            // Simulate event
            expect(capturedEventHandler).not.toBeNull();
            await capturedEventHandler!({
                pubkey: "user-pubkey-hex",
                content: "encrypted-content",
                id: "event-id-123",
            });

            expect(service.hasTokens("user-pubkey-hex")).toBe(true);
        });

        it("removes all tokens when enable is false", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Register a token first
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(
                    JSON.stringify({
                        notifications: { enable: true, apn_token: "token-1" },
                    })
                )
            );

            await capturedEventHandler!({
                pubkey: "user-1",
                content: "encrypted",
                id: "ev-1",
            });

            expect(service.hasTokens("user-1")).toBe(true);

            // Now disable
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(
                    JSON.stringify({
                        notifications: { enable: false, apn_token: "" },
                    })
                )
            );

            await capturedEventHandler!({
                pubkey: "user-1",
                content: "encrypted",
                id: "ev-2",
            });

            expect(service.hasTokens("user-1")).toBe(false);
        });

        it("ignores events without notifications section", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(JSON.stringify({ someOtherConfig: true }))
            );

            await capturedEventHandler!({
                pubkey: "user-1",
                content: "encrypted",
                id: "ev-1",
            });

            expect(service.hasTokens("user-1")).toBe(false);
        });

        it("handles decrypt failure gracefully", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Simulate decrypt throwing an error
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.reject(new Error("Decryption failed: invalid ciphertext"))
            );

            // Should not throw — error is caught internally
            await capturedEventHandler!({
                pubkey: "user-1",
                content: "bad-encrypted-content",
                id: "ev-1",
            });

            expect(service.hasTokens("user-1")).toBe(false);
        });

        it("handles JSON parse failure gracefully", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            // Return invalid JSON from decrypt
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve("this is not valid JSON {{{")
            );

            // Should not throw — error is caught internally
            await capturedEventHandler!({
                pubkey: "user-1",
                content: "encrypted",
                id: "ev-1",
            });

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
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(
                    JSON.stringify({
                        notifications: { enable: true, apn_token: "device-token-abc123" },
                    })
                )
            );

            await capturedEventHandler!({
                pubkey: "user-pubkey-hex",
                content: "encrypted",
                id: "ev-1",
            });

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
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(
                    JSON.stringify({
                        notifications: { enable: true, apn_token: "invalid-token" },
                    })
                )
            );

            await capturedEventHandler!({
                pubkey: "user-pubkey-hex",
                content: "encrypted",
                id: "ev-1",
            });

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
            mockNip44Decrypt.mockReturnValueOnce(
                Promise.resolve(
                    JSON.stringify({
                        notifications: { enable: true, apn_token: "bad-token" },
                    })
                )
            );

            await capturedEventHandler!({
                pubkey: "user-1",
                content: "encrypted",
                id: "ev-1",
            });

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

    describe("shutdown", () => {
        it("cleans up resources on shutdown", async () => {
            const service = APNsService.getInstance();
            await service.initialize();

            service.shutdown();

            expect(service.isEnabled()).toBe(false);
        });
    });
});
