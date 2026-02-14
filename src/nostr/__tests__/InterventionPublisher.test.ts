import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";

/**
 * Tests for InterventionPublisher and AgentEventEncoder.encodeInterventionReview().
 *
 * Verifies:
 * - Event has correct kind (1)
 * - Event has correct tags (p, e, context, a)
 * - Event content is properly formatted with human-readable names via PubkeyService.getNameSync()
 * - Project a-tag is included (via AgentEventEncoder.aTagProject)
 * - Trace context is injected
 * - Fallback to truncated pubkey when name resolution fails (cache miss)
 */

// Mock dependencies before importing - must be comprehensive to avoid test-setup issues
mock.module("@/services/ConfigService", () => ({
    config: {
        getBackendSigner: mock(() =>
            Promise.resolve({
                pubkey: "backend-signer-pubkey-123456789012345678901234567890123456",
            })
        ),
        getConfigPath: mock(() => "/tmp/test"),
        getConfig: mock(() => ({})),
    },
}));

mock.module("@/services/projects", () => ({
    getProjectContext: mock(() => ({
        project: {
            tagReference: mock(() => ["a", "31933:projectpubkey:test-project"]),
            pubkey: "projectpubkey",
        },
        projectTag: "31933:projectpubkey:test-project",
    })),
    isProjectContextInitialized: mock(() => true),
}));

mock.module("@/utils/logger", () => ({
    logger: {
        debug: mock(),
        info: mock(),
        warn: mock(),
        error: mock(),
    },
}));

// Mock PubkeyService to return human-readable names
const mockPubkeyService = {
    getNameSync: mock((pubkey: string) => {
        // Return readable names based on pubkey prefix for testing
        if (pubkey.startsWith("user-pubkey")) {
            return "Pablo";
        }
        if (pubkey.startsWith("agent-pubkey")) {
            return "Architect-Orchestrator";
        }
        return pubkey.substring(0, 12);
    }),
    getName: mock(async (pubkey: string) => {
        if (pubkey.startsWith("user-pubkey")) {
            return "Pablo";
        }
        if (pubkey.startsWith("agent-pubkey")) {
            return "Architect-Orchestrator";
        }
        return pubkey.substring(0, 12);
    }),
};

mock.module("@/services/PubkeyService", () => ({
    PubkeyService: {
        getInstance: mock(() => mockPubkeyService),
    },
    getPubkeyService: mock(() => mockPubkeyService),
}));

mock.module("../ndkClient", () => ({
    getNDK: mock(() => ({})),
}));

mock.module("@/telemetry/LLMSpanRegistry", () => ({
    getLLMSpanId: mock(() => null),
}));

// Mock OpenTelemetry
const mockContext = {
    getValue: () => undefined,
    setValue: () => mockContext,
    deleteValue: () => mockContext,
};

const mockSpan = {
    addEvent: mock(),
    setAttributes: mock(),
    setAttribute: mock(),
    setStatus: mock(),
    recordException: mock(),
    end: mock(),
    isRecording: () => true,
    updateName: mock(),
    spanContext: () => ({ traceId: "test-trace-id", spanId: "test-span-id", traceFlags: 0 }),
};

mock.module("@opentelemetry/api", () => ({
    createContextKey: mock((name: string) => Symbol.for(name)),
    DiagLogLevel: {
        NONE: 0,
        ERROR: 1,
        WARN: 2,
        INFO: 3,
        DEBUG: 4,
        VERBOSE: 5,
        ALL: 6,
    },
    diag: {
        setLogger: mock(() => {}),
        debug: mock(() => {}),
        error: mock(() => {}),
        warn: mock(() => {}),
        info: mock(() => {}),
    },
    SpanKind: {
        INTERNAL: 0,
        SERVER: 1,
        CLIENT: 2,
        PRODUCER: 3,
        CONSUMER: 4,
    },
    ROOT_CONTEXT: mockContext,
    context: {
        active: mock(() => mockContext),
        with: mock((_ctx: unknown, fn: () => unknown) => fn()),
    },
    propagation: {
        inject: mock((ctx: unknown, carrier: Record<string, string>) => {
            carrier.traceparent = "00-test-trace-id-test-span-id-01";
        }),
    },
    trace: {
        getTracer: mock(() => ({
            startActiveSpan: mock((_name: string, fn: (span: unknown) => unknown) =>
                fn(mockSpan)
            ),
        })),
        getActiveSpan: mock(() => mockSpan),
        setSpan: mock(() => mockContext),
    },
    SpanStatusCode: {
        OK: 1,
        ERROR: 2,
    },
    TraceFlags: {
        NONE: 0,
        SAMPLED: 1,
    },
}));

// Import after mocks
import { AgentEventEncoder } from "../AgentEventEncoder";
import { InterventionPublisher } from "../InterventionPublisher";
import type { InterventionReviewIntent } from "../types";

describe("AgentEventEncoder.encodeInterventionReview()", () => {
    let encoder: AgentEventEncoder;

    beforeEach(() => {
        encoder = new AgentEventEncoder();
    });

    it("should create event with kind 1", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        expect(event.kind).toBe(1);
    });

    it("should include p-tag with target pubkey", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const pTag = event.tags.find((tag) => tag[0] === "p");
        expect(pTag).toBeDefined();
        expect(pTag?.[1]).toBe("target-pubkey-123456789012345678901234567890123456");
    });

    it("should include e-tag with conversation ID", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const eTag = event.tags.find((tag) => tag[0] === "e");
        expect(eTag).toBeDefined();
        expect(eTag?.[1]).toBe("conv-id-123456789012345678901234567890123456789012");
    });

    it("should include context tag with intervention-review value", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const contextTag = event.tags.find((tag) => tag[0] === "context");
        expect(contextTag).toBeDefined();
        expect(contextTag?.[1]).toBe("intervention-review");
    });

    it("should NOT include user-pubkey tag (removed - redundant)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const userTag = event.tags.find((tag) => tag[0] === "user-pubkey");
        expect(userTag).toBeUndefined();
    });

    it("should NOT include agent-pubkey tag (removed - redundant)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const agentTag = event.tags.find((tag) => tag[0] === "agent-pubkey");
        expect(agentTag).toBeUndefined();
    });

    it("should NOT include original-conversation tag (removed - redundant)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const convTag = event.tags.find((tag) => tag[0] === "original-conversation");
        expect(convTag).toBeUndefined();
    });

    it("should include project a-tag (critical fix)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        const aTag = event.tags.find((tag) => tag[0] === "a");
        expect(aTag).toBeDefined();
        expect(aTag?.[1]).toBe("31933:projectpubkey:test-project");
    });

    it("should format content with human-readable names from PubkeyService", () => {
        // Clear any previous calls
        mockPubkeyService.getNameSync.mockClear();

        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "user-pubkey-123456789012345678901234567890123456",
            agentPubkey: "agent-pubkey-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        // Verify getNameSync was called for both user and agent pubkeys
        expect(mockPubkeyService.getNameSync).toHaveBeenCalledTimes(2);
        expect(mockPubkeyService.getNameSync).toHaveBeenCalledWith(
            "user-pubkey-123456789012345678901234567890123456"
        );
        expect(mockPubkeyService.getNameSync).toHaveBeenCalledWith(
            "agent-pubkey-123456789012345678901234567890123456"
        );

        // Verify content uses human-readable names from PubkeyService
        expect(event.content).toContain("conv-id-1234"); // First 12 chars of conversation ID
        expect(event.content).toContain("Pablo"); // Resolved user name
        expect(event.content).toContain("Architect-Orchestrator"); // Resolved agent name
        expect(event.content).toContain("Please review and decide if action is needed");
        // Should NOT contain raw pubkey prefixes
        expect(event.content).not.toContain("user-pub");
        expect(event.content).not.toContain("agent-pu");
    });

    it("should use truncated pubkey when getNameSync returns shortened pubkey (cache miss)", () => {
        // Simulate PubkeyService.getNameSync behavior on cache miss:
        // it returns pubkey.substring(0, 12) when no cached profile exists
        const originalGetNameSync = mockPubkeyService.getNameSync;
        mockPubkeyService.getNameSync = mock((pubkey: string) => {
            // Simulate cache miss - return truncated pubkey (matching real PubkeyService behavior)
            if (pubkey.startsWith("uncached-usr")) {
                return pubkey.substring(0, 12); // "uncached-usr"
            }
            if (pubkey.startsWith("uncached-agt")) {
                return pubkey.substring(0, 12); // "uncached-agt"
            }
            return originalGetNameSync(pubkey);
        });

        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userPubkey: "uncached-usr-123456789012345678901234567890123456",
            agentPubkey: "uncached-agt-123456789012345678901234567890123456",
        };

        const event = encoder.encodeInterventionReview(intent);

        // Verify getNameSync was called
        expect(mockPubkeyService.getNameSync).toHaveBeenCalledWith(
            "uncached-usr-123456789012345678901234567890123456"
        );
        expect(mockPubkeyService.getNameSync).toHaveBeenCalledWith(
            "uncached-agt-123456789012345678901234567890123456"
        );

        // When cache miss, PubkeyService returns truncated pubkey (first 12 chars)
        expect(event.content).toContain("uncached-usr"); // Truncated user pubkey
        expect(event.content).toContain("uncached-agt"); // Truncated agent pubkey
        expect(event.content).toContain("Please review and decide if action is needed");

        // Restore original mock
        mockPubkeyService.getNameSync = originalGetNameSync;
    });
});

describe("InterventionPublisher", () => {
    let publisher: InterventionPublisher;
    let mockPublish: ReturnType<typeof mock>;
    let mockSign: ReturnType<typeof mock>;
    let capturedEvents: NDKEvent[] = [];

    beforeEach(async () => {
        capturedEvents = [];

        // Mock NDKEvent.publish and sign
        mockPublish = mock(() => Promise.resolve(new Set()));
        mockSign = mock(() => Promise.resolve());

        spyOn(NDKEvent.prototype, "publish").mockImplementation(function (this: NDKEvent) {
            capturedEvents.push(this);
            return mockPublish();
        });

        spyOn(NDKEvent.prototype, "sign").mockImplementation(function (this: NDKEvent) {
            // Simulate setting the id after signing
            (this as unknown as { id: string }).id = "signed-event-id-12345";
            return mockSign();
        });

        publisher = new InterventionPublisher();
        await publisher.initialize();
    });

    afterEach(() => {
        capturedEvents = [];
        mock.restore();
    });

    it("should publish event with all required tags", async () => {
        await publisher.publishReviewRequest(
            "target-pubkey-123456789012345678901234567890123456",
            "conv-id-123456789012345678901234567890123456789012",
            "user-pubkey-123456789012345678901234567890123456",
            "agent-pubkey-123456789012345678901234567890123456"
        );

        expect(capturedEvents.length).toBe(1);
        const event = capturedEvents[0];

        // Verify all required tags are present
        const tags = event.tags;
        expect(tags.find((t) => t[0] === "p")).toBeDefined();
        expect(tags.find((t) => t[0] === "e")).toBeDefined(); // Conversation reference
        expect(tags.find((t) => t[0] === "context")).toBeDefined();
        expect(tags.find((t) => t[0] === "a")).toBeDefined(); // Project tag - the critical fix

        // Verify removed tags are NOT present
        expect(tags.find((t) => t[0] === "original-conversation")).toBeUndefined();
        expect(tags.find((t) => t[0] === "user-pubkey")).toBeUndefined();
        expect(tags.find((t) => t[0] === "agent-pubkey")).toBeUndefined();
    });

    it("should inject trace context", async () => {
        await publisher.publishReviewRequest(
            "target-pubkey-123456789012345678901234567890123456",
            "conv-id-123456789012345678901234567890123456789012",
            "user-pubkey-123456789012345678901234567890123456",
            "agent-pubkey-123456789012345678901234567890123456"
        );

        expect(capturedEvents.length).toBe(1);
        const event = capturedEvents[0];

        // Verify trace context tags are present
        const traceTag = event.tags.find((t) => t[0] === "trace_context");
        expect(traceTag).toBeDefined();
        expect(traceTag?.[1]).toBe("00-test-trace-id-test-span-id-01");

        const traceLlmTag = event.tags.find((t) => t[0] === "trace_context_llm");
        expect(traceLlmTag).toBeDefined();
    });

    it("should return event ID on success", async () => {
        const eventId = await publisher.publishReviewRequest(
            "target-pubkey-123456789012345678901234567890123456",
            "conv-id-123456789012345678901234567890123456789012",
            "user-pubkey-123456789012345678901234567890123456",
            "agent-pubkey-123456789012345678901234567890123456"
        );

        expect(eventId).toBe("signed-event-id-12345");
    });

    it("should throw error if not initialized", async () => {
        const uninitializedPublisher = new InterventionPublisher();

        await expect(
            uninitializedPublisher.publishReviewRequest(
                "target",
                "conv",
                "user",
                "agent"
            )
        ).rejects.toThrow("InterventionPublisher not initialized");
    });
});
