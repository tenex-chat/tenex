import { beforeEach, describe, expect, it, mock } from "bun:test";
import { handleKillSignal } from "@/event-handler/kill-signal";
import { createMockInboundEnvelope, createMockNDKEvent } from "@/test-utils/mock-factories";
import { NDKKind } from "@/nostr/kinds";

describe("handleKillSignal", () => {
    let inboundAdapter: { toEnvelope: ReturnType<typeof mock> };
    let runtimeIngressService: { handleChatMessage: ReturnType<typeof mock> };
    let agentExecutor: { execute: ReturnType<typeof mock> };

    beforeEach(() => {
        inboundAdapter = {
            toEnvelope: mock(() =>
                createMockInboundEnvelope({
                    metadata: {
                        eventKind: NDKKind.DelegationMarker,
                        replyTargets: ["child-conversation-id", "parent-conversation-id"],
                        delegationConversationId: "child-conversation-id",
                        delegationParentConversationId: "parent-conversation-id",
                        delegationMarkerStatus: "aborted",
                        delegationAbortReason: "killed by operator",
                    },
                })
            ),
        };
        runtimeIngressService = {
            handleChatMessage: mock(async () => undefined),
        };
        agentExecutor = {
            execute: mock(async () => undefined),
        };
    });

    it("routes aborted delegation markers through runtime ingress", async () => {
        const event = createMockNDKEvent({
            id: "kill-signal-event-id",
            kind: NDKKind.DelegationMarker,
            tags: [
                ["delegation-marker", "aborted"],
                ["e", "child-conversation-id"],
                ["e", "parent-conversation-id"],
                ["p", "recipient-pubkey"],
                ["abort-reason", "killed by operator"],
            ],
        });

        await handleKillSignal(event, {
            agentExecutor: agentExecutor as any,
            inboundAdapter,
            runtimeIngressService,
        });

        expect(inboundAdapter.toEnvelope).toHaveBeenCalledWith(event);
        expect(runtimeIngressService.handleChatMessage).toHaveBeenCalledWith({
            envelope: expect.objectContaining({
                metadata: expect.objectContaining({
                    delegationConversationId: "child-conversation-id",
                    delegationParentConversationId: "parent-conversation-id",
                    delegationMarkerStatus: "aborted",
                }),
            }),
            agentExecutor,
            adapter: "NostrInboundAdapter:kill-signal",
        });
    });

    it("ignores non-aborted delegation markers", async () => {
        const event = createMockNDKEvent({
            id: "pending-marker-event-id",
            kind: NDKKind.DelegationMarker,
            tags: [
                ["delegation-marker", "pending"],
                ["e", "child-conversation-id"],
                ["e", "parent-conversation-id"],
                ["p", "recipient-pubkey"],
            ],
        });

        await handleKillSignal(event, {
            agentExecutor: agentExecutor as any,
            inboundAdapter,
            runtimeIngressService,
        });

        expect(inboundAdapter.toEnvelope).not.toHaveBeenCalled();
        expect(runtimeIngressService.handleChatMessage).not.toHaveBeenCalled();
    });
});
