import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentPublisher } from "@/nostr/AgentPublisher";
import { NDKKind } from "@/nostr/kinds";
import { RecordingRuntimePublisher, RuntimePublishCollector } from "@/events/runtime/RecordingRuntimePublisher";
import { TelegramRuntimePublisherService } from "@/services/telegram/TelegramRuntimePublisherService";
import * as ndkClientModule from "@/nostr/ndkClient";
import * as projectsModule from "@/services/projects";
import * as traceContextModule from "@/nostr/trace-context";

const killSignalIntent = {
    delegationConversationId: "child-conversation-id",
    recipientPubkey: "recipient-pubkey",
    parentConversationId: "parent-conversation-id",
    status: "aborted" as const,
    completedAt: 1_725_000_000,
    abortReason: "killed by operator",
};

describe("AgentRuntimePublisher delegation marker contract", () => {
    beforeEach(() => {
        spyOn(ndkClientModule, "getNDK").mockReturnValue({
            subManager: { seenEvents: new Map() },
        } as any);
        spyOn(traceContextModule, "injectTraceContext").mockImplementation(() => {});
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                tagReference: () => ["a", "31933:testpubkey:test-project"],
                pubkey: "testpubkey",
            },
            projectTag: "31933:testpubkey:test-project",
        } as any);
        spyOn(projectsModule, "isProjectContextInitialized").mockReturnValue(true as never);
    });

    afterEach(() => {
        mock.restore();
    });

    it("AgentPublisher preserves the aborted delegation marker carrier fields", async () => {
        const capturedEvents: NDKEvent[] = [];
        const relay = {
            url: "wss://relay.test",
            once: mock(() => undefined),
            off: mock(() => undefined),
        };
        spyOn(NDKEvent.prototype, "publish").mockImplementation(function (this: NDKEvent) {
            capturedEvents.push(this);
            return Promise.resolve(new Set([relay] as any[]));
        });

        const publisher = new AgentPublisher({
            slug: "publisher-agent",
            pubkey: "publisher-agent-pubkey",
            sign: mock(async () => undefined),
        } as any);

        const published = await publisher.delegationMarker(killSignalIntent);

        expect(capturedEvents).toHaveLength(1);
        expect(capturedEvents[0]?.kind).toBe(NDKKind.DelegationMarker);
        expect(capturedEvents[0]?.tags).toEqual(
            expect.arrayContaining([
                ["delegation-marker", "aborted"],
                ["e", killSignalIntent.delegationConversationId],
                ["e", killSignalIntent.parentConversationId],
                ["p", killSignalIntent.recipientPubkey],
                ["completed-at", String(killSignalIntent.completedAt)],
                ["abort-reason", killSignalIntent.abortReason],
            ])
        );
        expect(published.envelope.metadata).toEqual(
            expect.objectContaining({
                eventKind: NDKKind.DelegationMarker,
                replyTargets: [
                    killSignalIntent.delegationConversationId,
                    killSignalIntent.parentConversationId,
                ],
                delegationConversationId: killSignalIntent.delegationConversationId,
                delegationParentConversationId: killSignalIntent.parentConversationId,
                delegationMarkerStatus: "aborted",
                delegationCompletedAt: killSignalIntent.completedAt,
                delegationAbortReason: killSignalIntent.abortReason,
            })
        );
    });

    it("RecordingRuntimePublisher preserves the aborted delegation marker carrier fields", async () => {
        const publisher = new RecordingRuntimePublisher(
            {
                slug: "recording-agent",
                pubkey: "recording-agent-pubkey",
                sign: mock(async () => undefined),
            } as any,
            new RuntimePublishCollector()
        );

        const published = await publisher.delegationMarker(killSignalIntent);

        expect(published.envelope.metadata).toEqual(
            expect.objectContaining({
                eventKind: NDKKind.DelegationMarker,
                replyTargets: [
                    killSignalIntent.delegationConversationId,
                    killSignalIntent.parentConversationId,
                ],
                delegationConversationId: killSignalIntent.delegationConversationId,
                delegationParentConversationId: killSignalIntent.parentConversationId,
                delegationMarkerStatus: "aborted",
                delegationCompletedAt: killSignalIntent.completedAt,
                delegationAbortReason: killSignalIntent.abortReason,
            })
        );
    });

    it("TelegramRuntimePublisherService forwards the aborted delegation marker carrier fields unchanged", async () => {
        const publishedRef = {
            id: "delegation-marker-id",
            transport: "nostr",
            envelope: {
                metadata: {
                    delegationConversationId: killSignalIntent.delegationConversationId,
                    delegationParentConversationId: killSignalIntent.parentConversationId,
                    delegationMarkerStatus: "aborted",
                    delegationCompletedAt: killSignalIntent.completedAt,
                    delegationAbortReason: killSignalIntent.abortReason,
                },
            },
        } as any;
        const delegationMarkerSpy = spyOn(AgentPublisher.prototype, "delegationMarker").mockResolvedValue(
            publishedRef
        );

        const publisher = new TelegramRuntimePublisherService(
            {
                slug: "telegram-agent",
                pubkey: "telegram-agent-pubkey",
                telegram: { botToken: "token" },
            } as any,
            {
                canHandle: () => false,
                sendReply: mock(async () => undefined),
            } as any
        );

        const published = await publisher.delegationMarker(killSignalIntent);

        expect(delegationMarkerSpy).toHaveBeenCalledWith(killSignalIntent);
        expect(published).toBe(publishedRef);
    });
});
