import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import type { TrustResult } from "@/services/trust-pubkeys";

/**
 * Type-safe access to the private static `instance` field for singleton reset in tests.
 * Avoids `any` casts while keeping the test ergonomic.
 */
type PubkeyGateServiceTestable = typeof PubkeyGateService & {
    instance: PubkeyGateService | undefined;
};

// Variables to control mock behavior
let mockTrustResult: TrustResult = { trusted: false };
let mockTrustSyncThrows = false;
let mockTrustSyncError: Error | null = null;

// Mock TrustPubkeyService
mock.module("@/services/trust-pubkeys", () => ({
    getTrustPubkeyService: () => ({
        isTrustedEventSync: (_event: NDKEvent) => {
            if (mockTrustSyncThrows) {
                throw mockTrustSyncError ?? new Error("Trust check failed");
            }
            return mockTrustResult;
        },
    }),
}));

// Spied logger so tests can assert on denial-path logging
const mockLoggerWarn = mock(() => {});
const mockLoggerDebug = mock(() => {});

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mockLoggerDebug,
        info: () => {},
        warn: mockLoggerWarn,
        error: () => {},
    },
}));

// Spied addEvent so tests can assert on telemetry side-effects
const mockSpanAddEvent = mock(() => {});

mock.module("@opentelemetry/api", () => ({
    trace: {
        getActiveSpan: () => ({
            addEvent: mockSpanAddEvent,
        }),
    },
}));

// Import after mocking
import { PubkeyGateService } from "../PubkeyGateService";

function createMockEvent(overrides: Partial<NDKEvent> = {}): NDKEvent {
    return {
        pubkey: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        kind: 1,
        id: "event-id-123",
        ...overrides,
    } as NDKEvent;
}

describe("PubkeyGateService", () => {
    let gate: PubkeyGateService;

    beforeEach(() => {
        // Reset singleton via testable type (avoids `any` cast)
        (PubkeyGateService as PubkeyGateServiceTestable).instance = undefined;
        gate = PubkeyGateService.getInstance();

        // Reset mock state
        mockTrustResult = { trusted: false };
        mockTrustSyncThrows = false;
        mockTrustSyncError = null;

        // Reset spy call counts
        mockLoggerWarn.mockClear();
        mockLoggerDebug.mockClear();
        mockSpanAddEvent.mockClear();
    });

    describe("getInstance", () => {
        it("should return the same instance", () => {
            const instance1 = PubkeyGateService.getInstance();
            const instance2 = PubkeyGateService.getInstance();
            expect(instance1).toBe(instance2);
        });
    });

    describe("shouldAllowEvent", () => {
        it("should allow events from whitelisted pubkeys", () => {
            mockTrustResult = { trusted: true, reason: "whitelisted" };
            const event = createMockEvent();

            expect(gate.shouldAllowEvent(event)).toBe(true);
        });

        it("should allow events from backend pubkey", () => {
            mockTrustResult = { trusted: true, reason: "backend" };
            const event = createMockEvent();

            expect(gate.shouldAllowEvent(event)).toBe(true);
        });

        it("should allow events from agent pubkeys", () => {
            mockTrustResult = { trusted: true, reason: "agent" };
            const event = createMockEvent();

            expect(gate.shouldAllowEvent(event)).toBe(true);
        });

        it("should deny events from untrusted pubkeys", () => {
            mockTrustResult = { trusted: false };
            const event = createMockEvent({ pubkey: "untrusted-pubkey" } as Partial<NDKEvent>);

            expect(gate.shouldAllowEvent(event)).toBe(false);
        });

        it("should deny events with no pubkey", () => {
            const event = createMockEvent({ pubkey: "" } as Partial<NDKEvent>);

            expect(gate.shouldAllowEvent(event)).toBe(false);
        });

        it("should deny events with undefined pubkey", () => {
            const event = { kind: 1, id: "no-pubkey-event" } as NDKEvent;

            expect(gate.shouldAllowEvent(event)).toBe(false);
        });

        describe("fail-closed behavior", () => {
            it("should deny when trust check throws an error", () => {
                mockTrustSyncThrows = true;
                mockTrustSyncError = new Error("Service unavailable");
                const event = createMockEvent();

                expect(gate.shouldAllowEvent(event)).toBe(false);
            });

            it("should deny when trust check throws unexpected error type", () => {
                mockTrustSyncThrows = true;
                mockTrustSyncError = new TypeError("Unexpected type");
                const event = createMockEvent();

                expect(gate.shouldAllowEvent(event)).toBe(false);
            });
        });

        describe("different event kinds", () => {
            it("should gate kind 1 (text) events", () => {
                mockTrustResult = { trusted: false };
                const event = createMockEvent({ kind: 1 } as Partial<NDKEvent>);

                expect(gate.shouldAllowEvent(event)).toBe(false);
            });

            it("should gate kind 30023 (article) events", () => {
                mockTrustResult = { trusted: false };
                const event = createMockEvent({ kind: 30023 } as Partial<NDKEvent>);

                expect(gate.shouldAllowEvent(event)).toBe(false);
            });

            it("should allow trusted events of any kind", () => {
                mockTrustResult = { trusted: true, reason: "whitelisted" };
                const event = createMockEvent({ kind: 30023 } as Partial<NDKEvent>);

                expect(gate.shouldAllowEvent(event)).toBe(true);
            });
        });

        describe("observability side-effects", () => {
            it("should emit telemetry on denial for untrusted pubkey", () => {
                mockTrustResult = { trusted: false };
                const event = createMockEvent();

                gate.shouldAllowEvent(event);

                expect(mockSpanAddEvent).toHaveBeenCalledWith("pubkey_gate.denied", expect.objectContaining({
                    "gate.reason": "untrusted",
                }));
            });

            it("should log debug on denial for untrusted pubkey", () => {
                mockTrustResult = { trusted: false };
                const event = createMockEvent();

                gate.shouldAllowEvent(event);

                expect(mockLoggerDebug).toHaveBeenCalledWith(
                    "[PUBKEY_GATE] Event denied: untrusted pubkey",
                    expect.objectContaining({
                        pubkey: "abcdef12",
                        kind: 1,
                    }),
                );
            });

            it("should emit telemetry on denial for missing pubkey", () => {
                const event = createMockEvent({ pubkey: "" } as Partial<NDKEvent>);

                gate.shouldAllowEvent(event);

                expect(mockSpanAddEvent).toHaveBeenCalledWith("pubkey_gate.denied", expect.objectContaining({
                    "gate.reason": "no_pubkey",
                }));
            });

            it("should log warn and emit telemetry on trust check error (fail-closed)", () => {
                mockTrustSyncThrows = true;
                mockTrustSyncError = new Error("Service unavailable");
                const event = createMockEvent();

                gate.shouldAllowEvent(event);

                // Assert logger.warn is called with fail-closed message
                expect(mockLoggerWarn).toHaveBeenCalledWith(
                    "[PUBKEY_GATE] Trust check failed, denying event (fail-closed)",
                    expect.objectContaining({
                        pubkey: "abcdef12",
                        kind: 1,
                        error: "Service unavailable",
                    }),
                );

                // Assert telemetry records "error" reason
                expect(mockSpanAddEvent).toHaveBeenCalledWith("pubkey_gate.denied", expect.objectContaining({
                    "gate.reason": "error",
                }));
            });

            it("should NOT emit denial telemetry when event is allowed", () => {
                mockTrustResult = { trusted: true, reason: "whitelisted" };
                const event = createMockEvent();

                gate.shouldAllowEvent(event);

                expect(mockSpanAddEvent).not.toHaveBeenCalled();
            });
        });
    });
});
