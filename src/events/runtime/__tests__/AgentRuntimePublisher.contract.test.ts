/**
 * Kill-signal carrier contract tests.
 *
 * These tests verify that the control-plane fields required for kill-signal
 * wake-up are correctly propagated through the dispatch stack.  The contract
 * is:
 *
 * 1. A kill-signal InboundEnvelope must carry `isKillSignal: true` and
 *    `killSignalDelegationConversationId`.
 * 2. DelegationCompletionHandler's implicit-kill branch must recognise those
 *    fields and resolve the parent wake target.
 * 3. The signal must NOT be added to the child conversation store.
 *
 * If any part of this contract breaks, kill.ts + kill-signal.ts will silently
 * stop waking parents.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { RALRegistry } from "@/services/ral/RALRegistry";
import { handleDelegationCompletion } from "@/services/dispatch/DelegationCompletionHandler";
import { ConversationStore } from "@/conversations/ConversationStore";
import * as projectsModule from "@/services/projects";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";

const PARENT_PUBKEY = "parent-pubkey-contract-test-abc123";
const CHILD_PUBKEY = "child-pubkey-contract-test-def456";
const PARENT_CONV = "parent-conv-contract-test-00000001";
const CHILD_CONV = "child-conv-contract-test-000000002";
const PROJECT_ID = "31933:pubkey:contract-project";

const mockParentAgent = { slug: "parent-agent", pubkey: PARENT_PUBKEY, name: "Parent" };
const mockChildAgent = { slug: "child-agent", pubkey: CHILD_PUBKEY, name: "Child" };

function buildKillSignalEnvelope(delegationConversationId: string) {
    return createMockInboundEnvelope({
        principal: { id: "local:kill-signal", transport: "local", kind: "system" },
        recipients: [],
        content: "Kill signal",
        metadata: {
            eventKind: 24136,
            eventTagCount: 0,
            isKillSignal: true,
            killSignalDelegationConversationId: delegationConversationId,
        },
    });
}

describe("Kill-signal carrier contract", () => {
    let registry: RALRegistry;
    let addEnvelopeSpy: ReturnType<typeof spyOn>;
    let getProjectContextSpy: ReturnType<typeof spyOn>;
    let getConvSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // @ts-expect-error — reset singleton for test isolation
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();

        getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockReturnValue({
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === PARENT_PUBKEY) return mockParentAgent;
                if (pubkey === CHILD_PUBKEY) return mockChildAgent;
                return undefined;
            },
            getAgent: (slug: string) => {
                if (slug === mockParentAgent.slug) return mockParentAgent;
                return undefined;
            },
        } as never);

        getConvSpy = spyOn(ConversationStore, "get").mockReturnValue({} as never);
        addEnvelopeSpy = spyOn(ConversationStore, "addEnvelope").mockResolvedValue(undefined);
    });

    it("isKillSignal envelope carries delegationConversationId to implicit-kill branch", () => {
        const envelope = buildKillSignalEnvelope(CHILD_CONV);
        expect(envelope.metadata.isKillSignal).toBe(true);
        expect(envelope.metadata.killSignalDelegationConversationId).toBe(CHILD_CONV);
    });

    it("implicit-kill branch resolves parent wake target when delegation is completed/aborted", async () => {
        const ralNumber = registry.create(PARENT_PUBKEY, PARENT_CONV, PROJECT_ID);
        registry.mergePendingDelegations(PARENT_PUBKEY, PARENT_CONV, ralNumber, [
            {
                delegationConversationId: CHILD_CONV,
                recipientPubkey: CHILD_PUBKEY,
                senderPubkey: PARENT_PUBKEY,
                prompt: "execute task",
                ralNumber,
            },
        ]);

        // Commit local abort state — this is what kill.ts does before dispatching the signal
        registry.markParentDelegationKilled(CHILD_CONV);

        const result = await handleDelegationCompletion(buildKillSignalEnvelope(CHILD_CONV));

        expect(result.recorded).toBe(true);
        expect(result.agentSlug).toBe(mockParentAgent.slug);
        expect(result.conversationId).toBe(PARENT_CONV);
    });

    it("kill-signal envelope is never added to the child conversation store", async () => {
        const ralNumber = registry.create(PARENT_PUBKEY, PARENT_CONV, PROJECT_ID);
        registry.mergePendingDelegations(PARENT_PUBKEY, PARENT_CONV, ralNumber, [
            {
                delegationConversationId: CHILD_CONV,
                recipientPubkey: CHILD_PUBKEY,
                senderPubkey: PARENT_PUBKEY,
                prompt: "execute task",
                ralNumber,
            },
        ]);
        registry.markParentDelegationKilled(CHILD_CONV);

        const envelope = buildKillSignalEnvelope(CHILD_CONV);
        await handleDelegationCompletion(envelope);

        // Control-plane guarantee: the signal must never touch the child store
        expect(addEnvelopeSpy).not.toHaveBeenCalledWith(CHILD_CONV, expect.anything());
    });

    it("kill-signal without a committed abort state returns { recorded: false }", async () => {
        // No delegation registered — signal arrives before state commit or for unknown ID
        const result = await handleDelegationCompletion(buildKillSignalEnvelope("nonexistent-conv-99"));
        expect(result.recorded).toBe(false);
    });
});
