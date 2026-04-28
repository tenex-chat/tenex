import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Type-safe access to the private static `instance` field for singleton reset
 * in tests. Avoids `any` casts while keeping the test ergonomic.
 */
type PubkeyGateServiceTestable = typeof PubkeyGateService & {
    instance: PubkeyGateService | undefined;
};

// Mock state controlling how the whitelist daemon client behaves per test.
let mockCheckResolves: boolean | null = null;
let mockCheckRejection: Error | null = null;

class MockWhitelistDaemonError extends Error {}

mock.module("../whitelistDaemonClient", () => ({
    checkPubkey: async (_pubkey: string, _dtag: string): Promise<boolean> => {
        if (mockCheckRejection) {
            throw mockCheckRejection;
        }
        if (mockCheckResolves === null) {
            throw new Error("test setup forgot to set mockCheckResolves");
        }
        return mockCheckResolves;
    },
    WhitelistDaemonError: MockWhitelistDaemonError,
}));

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

const mockSpanAddEvent = mock(() => {});
const mockSpan = () => ({
    addEvent: mockSpanAddEvent,
    setAttribute: () => {},
    setStatus: () => {},
    end: () => {},
    isRecording: () => false,
    recordException: () => {},
    updateName: () => {},
    setAttributes: () => {},
    spanContext: () => ({ traceId: "test", spanId: "test", traceFlags: 0 }),
});

const mockContext = {
    getValue: () => undefined,
    setValue: () => mockContext,
    deleteValue: () => mockContext,
};

mock.module("@opentelemetry/api", () => ({
    createContextKey: mock((name: string) => Symbol.for(name)),
    DiagLogLevel: {
        NONE: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, VERBOSE: 5, ALL: 6,
    },
    diag: {
        setLogger: mock(() => {}),
        debug: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        info: mock(() => {}),
    },
    ROOT_CONTEXT: mockContext,
    SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 },
    context: {
        active: () => mockContext,
        with: <T>(
            _context: unknown,
            fn: (...args: unknown[]) => T,
            thisArg?: unknown,
            ...args: unknown[]
        ) => fn.apply(thisArg, args),
        bind: <T>(target: T) => target,
    },
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    TraceFlags: { NONE: 0, SAMPLED: 1 },
    trace: {
        getActiveSpan: () => mockSpan(),
        setSpan: () => mockContext,
        getTracer: () => ({
            startSpan: () => mockSpan(),
            startActiveSpan: (_name: string, fn: (span: unknown) => unknown) => fn(mockSpan()),
        }),
    },
}));

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
        (PubkeyGateService as PubkeyGateServiceTestable).instance = undefined;
        gate = PubkeyGateService.getInstance();
        mockCheckResolves = null;
        mockCheckRejection = null;
        mockLoggerWarn.mockClear();
        mockLoggerDebug.mockClear();
        mockSpanAddEvent.mockClear();
    });

    afterEach(() => {
        mock.restore();
    });

    describe("getInstance", () => {
        it("returns the same singleton", () => {
            expect(PubkeyGateService.getInstance()).toBe(PubkeyGateService.getInstance());
        });
    });

    describe("shouldAllowEvent", () => {
        it("allows when daemon answers YES", async () => {
            mockCheckResolves = true;
            await expect(gate.shouldAllowEvent(createMockEvent())).resolves.toBe(true);
        });

        it("denies when daemon answers NO", async () => {
            mockCheckResolves = false;
            await expect(gate.shouldAllowEvent(createMockEvent())).resolves.toBe(false);
        });

        it("denies when event has no pubkey (without querying daemon)", async () => {
            mockCheckResolves = true; // would allow if asked
            await expect(
                gate.shouldAllowEvent(createMockEvent({ pubkey: "" } as Partial<NDKEvent>))
            ).resolves.toBe(false);
        });

        it("denies when event has undefined pubkey", async () => {
            await expect(
                gate.shouldAllowEvent({ kind: 1, id: "no-pubkey" } as NDKEvent)
            ).resolves.toBe(false);
        });

        describe("fail-closed", () => {
            it("denies on transport error", async () => {
                mockCheckRejection = new MockWhitelistDaemonError("connect refused");
                await expect(gate.shouldAllowEvent(createMockEvent())).resolves.toBe(false);
            });

            it("denies on unexpected error type", async () => {
                mockCheckRejection = new TypeError("boom");
                await expect(gate.shouldAllowEvent(createMockEvent())).resolves.toBe(false);
            });
        });

        describe("observability", () => {
            it("emits telemetry on untrusted denial", async () => {
                mockCheckResolves = false;
                await gate.shouldAllowEvent(createMockEvent());
                expect(mockSpanAddEvent).toHaveBeenCalledWith(
                    "pubkey_gate.denied",
                    expect.objectContaining({ "gate.reason": "untrusted" }),
                );
            });

            it("emits telemetry on missing pubkey", async () => {
                await gate.shouldAllowEvent(createMockEvent({ pubkey: "" } as Partial<NDKEvent>));
                expect(mockSpanAddEvent).toHaveBeenCalledWith(
                    "pubkey_gate.denied",
                    expect.objectContaining({ "gate.reason": "no_pubkey" }),
                );
            });

            it("logs warn + emits 'error' telemetry on transport failure", async () => {
                mockCheckRejection = new MockWhitelistDaemonError("connect refused");
                await gate.shouldAllowEvent(createMockEvent());
                expect(mockLoggerWarn).toHaveBeenCalledWith(
                    "[PUBKEY_GATE] Whitelist daemon query failed, denying event (fail-closed)",
                    expect.objectContaining({
                        pubkey: "abcdef12",
                        kind: 1,
                        error: "connect refused",
                        transport: true,
                    }),
                );
                expect(mockSpanAddEvent).toHaveBeenCalledWith(
                    "pubkey_gate.denied",
                    expect.objectContaining({ "gate.reason": "error" }),
                );
            });

            it("does NOT emit denial telemetry when allowed", async () => {
                mockCheckResolves = true;
                await gate.shouldAllowEvent(createMockEvent());
                expect(mockSpanAddEvent).not.toHaveBeenCalled();
            });
        });
    });
});
