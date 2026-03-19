import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { config } from "@/services/ConfigService";
import { projectContextStore } from "@/services/projects";
import { logger } from "@/utils/logger";
import { AgentEventEncoder } from "../AgentEventEncoder";
import { InterventionPublisher } from "../InterventionPublisher";
import type { InterventionReviewIntent } from "../types";
import * as ndkClientModule from "../ndkClient";
import * as traceContextModule from "../trace-context";

/**
 * Tests for InterventionPublisher and AgentEventEncoder.encodeInterventionReview().
 *
 * Verifies:
 * - Event has correct kind (1)
 * - Event has correct tags (p, e, context, a)
 * - Event content is properly formatted with human-readable names
 * - Project a-tag is included (via AgentEventEncoder.aTagProject)
 * - Trace context is injected
 * - Names are passed pre-resolved from InterventionService (to avoid circular dependencies)
 *
 * Note: Name resolution happens in InterventionService (services layer), not InterventionPublisher
 * (nostr layer), to avoid circular dependencies with PubkeyService.
 */

const mockProjectContext = {
    project: {
        id: "test-project-id",
        pubkey: "projectpubkey",
        tagReference: () => ["a", "31933:projectpubkey:test-project"],
        tagValue: (tag: string) => (tag === "title" ? "Test Project" : tag === "d" ? "test-project" : undefined),
    },
    agents: new Map(),
    agentLessons: new Map(),
    mcpManager: undefined,
    projectManager: undefined,
} as const;

function withProjectContext<T>(fn: () => T): T {
    return projectContextStore.runSync(mockProjectContext as never, fn);
}

async function withProjectContextAsync<T>(fn: () => Promise<T>): Promise<T> {
    return projectContextStore.run(mockProjectContext as never, fn);
}

function installSharedSpies(): void {
    spyOn(ndkClientModule, "getNDK").mockReturnValue({} as never);
    spyOn(traceContextModule, "injectTraceContext").mockImplementation(
        (event: { tags: string[][] }) => {
            event.tags.push(["trace_context", "00-test-trace-id-test-span-id-01"]);
            event.tags.push(["trace_context_llm", ""]);
        }
    );
    spyOn(config, "getBackendSigner").mockResolvedValue({
        pubkey: "backend-signer-pubkey-123456789012345678901234567890123456",
    } as any);
    spyOn(config, "getConfigPath").mockReturnValue("/tmp/test");
    spyOn(config, "getGlobalPath").mockReturnValue("/tmp/test");
    spyOn(config, "getProjectsBase").mockReturnValue("/tmp/test/projects");
    spyOn(config, "getConfig").mockReturnValue({} as any);
    spyOn(config, "getContextManagementConfig").mockReturnValue(undefined);
    spyOn(logger, "debug").mockImplementation(() => {});
    spyOn(logger, "info").mockImplementation(() => {});
    spyOn(logger, "warn").mockImplementation(() => {});
    spyOn(logger, "error").mockImplementation(() => {});
}

describe("AgentEventEncoder.encodeInterventionReview()", () => {
    let encoder: AgentEventEncoder;

    beforeEach(() => {
        installSharedSpies();
        encoder = new AgentEventEncoder();
    });

    afterEach(() => {
        mock.restore();
    });

    it("should create event with kind 1", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        expect(event.kind).toBe(1);
    });

    it("should include p-tag with target pubkey", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const pTag = event.tags.find((tag) => tag[0] === "p");
        expect(pTag).toBeDefined();
        expect(pTag?.[1]).toBe("target-pubkey-123456789012345678901234567890123456");
    });

    it("should include e-tag with conversation ID", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const eTag = event.tags.find((tag) => tag[0] === "e");
        expect(eTag).toBeDefined();
        expect(eTag?.[1]).toBe("conv-id-123456789012345678901234567890123456789012");
    });

    it("should include context tag with intervention-review value", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const contextTag = event.tags.find((tag) => tag[0] === "context");
        expect(contextTag).toBeDefined();
        expect(contextTag?.[1]).toBe("intervention-review");
    });

    it("should NOT include user-pubkey tag (removed - redundant)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const userTag = event.tags.find((tag) => tag[0] === "user-pubkey");
        expect(userTag).toBeUndefined();
    });

    it("should NOT include agent-pubkey tag (removed - redundant)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const agentTag = event.tags.find((tag) => tag[0] === "agent-pubkey");
        expect(agentTag).toBeUndefined();
    });

    it("should NOT include original-conversation tag (removed - redundant)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const convTag = event.tags.find((tag) => tag[0] === "original-conversation");
        expect(convTag).toBeUndefined();
    });

    it("should include project a-tag (critical fix)", () => {
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        const aTag = event.tags.find((tag) => tag[0] === "a");
        expect(aTag).toBeDefined();
        expect(aTag?.[1]).toBe("31933:projectpubkey:test-project");
    });

    it("should format content with pre-resolved human-readable names", () => {
        // Names are pre-resolved by InterventionPublisher (layer 3), not by the encoder (layer 2)
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "Pablo",
            agentName: "Architect-Orchestrator",
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        // Verify content uses the pre-resolved names from the intent
        expect(event.content).toContain("conv-id-1234"); // First 12 chars of conversation ID
        expect(event.content).toContain("Pablo"); // Pre-resolved user name
        expect(event.content).toContain("Architect-Orchestrator"); // Pre-resolved agent name
        expect(event.content).toContain("Please review and decide if action is needed");
    });

    it("should use truncated pubkey when name is pre-resolved as shortened pubkey (cache miss scenario)", () => {
        // When PubkeyService has a cache miss, the caller (InterventionPublisher) passes
        // the truncated pubkey as the name. The encoder just uses whatever names are passed.
        const intent: InterventionReviewIntent = {
            targetPubkey: "target-pubkey-123456789012345678901234567890123456",
            conversationId: "conv-id-123456789012345678901234567890123456789012",
            userName: "uncached-usr", // Pre-resolved as truncated pubkey (cache miss)
            agentName: "uncached-agt", // Pre-resolved as truncated pubkey (cache miss)
        };

        const event = withProjectContext(() => encoder.encodeInterventionReview(intent));

        // When cache miss, the pre-resolved name is the truncated pubkey (first 12 chars)
        expect(event.content).toContain("uncached-usr"); // Truncated user pubkey
        expect(event.content).toContain("uncached-agt"); // Truncated agent pubkey
        expect(event.content).toContain("Please review and decide if action is needed");
    });
});

describe("InterventionPublisher", () => {
    let publisher: InterventionPublisher;
    let mockPublish: ReturnType<typeof mock>;
    let mockSign: ReturnType<typeof mock>;
    let capturedEvents: NDKEvent[] = [];

    beforeEach(async () => {
        capturedEvents = [];
        installSharedSpies();

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
        await withProjectContextAsync(() =>
            publisher.publishReviewRequest(
                "target-pubkey-123456789012345678901234567890123456",
                "conv-id-123456789012345678901234567890123456789012",
                "Pablo", // Pre-resolved user name
                "Architect-Orchestrator" // Pre-resolved agent name
            )
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
        await withProjectContextAsync(() =>
            publisher.publishReviewRequest(
                "target-pubkey-123456789012345678901234567890123456",
                "conv-id-123456789012345678901234567890123456789012",
                "Pablo", // Pre-resolved user name
                "Architect-Orchestrator" // Pre-resolved agent name
            )
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
        const eventId = await withProjectContextAsync(() =>
            publisher.publishReviewRequest(
                "target-pubkey-123456789012345678901234567890123456",
                "conv-id-123456789012345678901234567890123456789012",
                "Pablo", // Pre-resolved user name
                "Architect-Orchestrator" // Pre-resolved agent name
            )
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

    it("should use pre-resolved names in event content (names resolved by caller)", async () => {
        // Names are now pre-resolved by the CALLER (InterventionService), not by InterventionPublisher.
        // This avoids circular dependencies: InterventionPublisher (nostr layer) cannot import
        // PubkeyService (services layer).

        await withProjectContextAsync(() =>
            publisher.publishReviewRequest(
                "target-pubkey-123456789012345678901234567890123456",
                "conv-id-123456789012345678901234567890123456789012",
                "Pablo", // Pre-resolved user name (passed directly)
                "Architect-Orchestrator" // Pre-resolved agent name (passed directly)
            )
        );

        // Verify the event content uses the pre-resolved names passed as parameters
        expect(capturedEvents.length).toBe(1);
        const event = capturedEvents[0];
        expect(event.content).toContain("Pablo"); // Pre-resolved user name
        expect(event.content).toContain("Architect-Orchestrator"); // Pre-resolved agent name
        expect(event.content).toContain("conv-id-1234"); // Shortened conversation ID
        expect(event.content).toContain("Please review and decide if action is needed");
    });
});
