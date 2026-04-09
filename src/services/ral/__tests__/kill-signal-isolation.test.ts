/**
 * Regression tests for the delegation kill signal fix.
 *
 * Invariants verified:
 * 1. consumeImplicitKillWakeTarget is one-shot — second call returns null
 * 2. Kill-signal branch in handleDelegationCompletion runs before replyTargets/sender checks
 * 3. ConversationStore.addEnvelope is never called with a kill-signal envelope
 * 4. Kill-signal branch returns recorded:false for unknown/already-consumed delegation
 * 5. Kill-signal branch returns recorded:true when parent found and sets agentSlug/conversationId
 * 6. abortWithCascade on a paused child (no abort controllers) still wakes up the parent
 * 7. Kill tool passes the executor explicitly to dispatchKillWakeup (no singleton caching)
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { RALRegistry } from "../RALRegistry";
import { handleDelegationCompletion } from "@/services/dispatch/DelegationCompletionHandler";
import { AgentDispatchService } from "@/services/dispatch/AgentDispatchService";
import { createKillTool } from "@/tools/implementations/kill";
import * as projectsModule from "@/services/projects";
import { ConversationStore } from "@/conversations/ConversationStore";
import { createMockInboundEnvelope } from "@/test-utils/mock-factories";
import type { PendingDelegation } from "../types";

const PROJECT_ID = "31933:pubkey:test-project" as const;

// Agent B waits on a delegation to C
const agentB = {
    slug: "agent-b",
    pubkey: "bbbbbbbbbbbbbbbbbbbb",
    name: "Agent B",
};
const agentC = {
    slug: "agent-c",
    pubkey: "cccccccccccccccccccc",
    name: "Agent C",
};

const CONV_B = "conv-b-111111111111111111111111111111111111111111111111111111111111111";
const DELEGATION_C_CONV = "deleg-c-2222222222222222222222222222222222222222222222222222222222";

function buildKillSignalEnvelope(delegationConversationId: string) {
    return createMockInboundEnvelope({
        transport: "local",
        principal: {
            id: "kill-signal",
            transport: "local",
            kind: "system",
        },
        metadata: {
            isKillSignal: true,
            killSignalDelegationConversationId: delegationConversationId,
            replyTargets: [],
        },
    });
}

describe("kill signal control-plane isolation", () => {
    let registry: RALRegistry;
    let getProjectContextSpy: ReturnType<typeof spyOn>;
    let conversationStoreGetSpy: ReturnType<typeof spyOn>;
    let conversationStoreAddEnvelopeSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
        // @ts-expect-error — accessing private static for test isolation
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();

        getProjectContextSpy = spyOn(projectsModule, "getProjectContext").mockReturnValue({
            getAgentByPubkey: (pubkey: string) => {
                if (pubkey === agentB.pubkey) return agentB;
                if (pubkey === agentC.pubkey) return agentC;
                return undefined;
            },
            getAgent: (slug: string) => {
                if (slug === agentB.slug) return agentB;
                if (slug === agentC.slug) return agentC;
                return undefined;
            },
        } as never);

        conversationStoreGetSpy = spyOn(ConversationStore, "get").mockReturnValue(undefined);
        conversationStoreAddEnvelopeSpy = spyOn(ConversationStore, "addEnvelope").mockResolvedValue(undefined);
    });

    afterEach(() => {
        getProjectContextSpy?.mockRestore();
        conversationStoreGetSpy?.mockRestore();
        conversationStoreAddEnvelopeSpy?.mockRestore();
        registry.clearAll();
    });

    /**
     * Set up B's RAL with a pending delegation to C, then mark it killed.
     * Returns the ralNumber for B's RAL.
     */
    function setupAbortedDelegation(): number {
        const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);

        const pendingDelegation: PendingDelegation = {
            delegationConversationId: DELEGATION_C_CONV,
            recipientPubkey: agentC.pubkey,
            senderPubkey: agentB.pubkey,
            prompt: "Do something",
            ralNumber,
        };
        registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, pendingDelegation ? [pendingDelegation] : []);

        // Mark the delegation as killed → moves to completed with status "aborted"
        registry.markParentDelegationKilled(DELEGATION_C_CONV);

        return ralNumber;
    }

    describe("consumeImplicitKillWakeTarget", () => {
        it("returns the parent agent location when delegation is aborted", () => {
            setupAbortedDelegation();

            const result = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);

            expect(result).not.toBeNull();
            expect(result?.agentPubkey).toBe(agentB.pubkey);
            expect(result?.conversationId).toBe(CONV_B);
        });

        it("is one-shot — second call returns null", () => {
            setupAbortedDelegation();

            const first = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            const second = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);

            expect(first).not.toBeNull();
            expect(second).toBeNull();
        });

        it("returns null for unknown delegation ID", () => {
            const result = registry.consumeImplicitKillWakeTarget("totally-unknown-conv-id");
            expect(result).toBeNull();
        });

        it("returns null when delegation completed normally (not aborted)", () => {
            const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
            const pendingDelegation: PendingDelegation = {
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                senderPubkey: agentB.pubkey,
                prompt: "Do something",
                ralNumber,
            };
            registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, [pendingDelegation]);

            // Normal completion — status should be "completed", not "aborted"
            registry.recordCompletion({
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                response: "Done",
                completedAt: Date.now(),
            });

            const result = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            expect(result).toBeNull();
        });

        it("returns null for a still-pending delegation (not yet killed)", () => {
            const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
            const pendingDelegation: PendingDelegation = {
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                senderPubkey: agentB.pubkey,
                prompt: "Still running",
                ralNumber,
            };
            registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, [pendingDelegation]);

            // Do NOT call markParentDelegationKilled — delegation is still pending
            const result = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            expect(result).toBeNull();
        });
    });

    describe("handleDelegationCompletion kill-signal branch", () => {
        it("runs before replyTargets/sender checks — processes kill envelope with no replyTargets", async () => {
            setupAbortedDelegation();

            // Kill-signal envelope has no replyTargets and no sender pubkey
            const killEnvelope = buildKillSignalEnvelope(DELEGATION_C_CONV);

            const result = await handleDelegationCompletion(killEnvelope);

            expect(result.recorded).toBe(true);
            expect(result.agentSlug).toBe(agentB.slug);
            expect(result.conversationId).toBe(CONV_B);
        });

        it("returns recorded:false when delegationConversationId is missing from kill envelope", async () => {
            const envelope = createMockInboundEnvelope({
                transport: "local",
                metadata: {
                    isKillSignal: true,
                    // killSignalDelegationConversationId intentionally omitted
                    replyTargets: [],
                },
            });

            const result = await handleDelegationCompletion(envelope);
            expect(result.recorded).toBe(false);
        });

        it("returns recorded:false when consumeImplicitKillWakeTarget returns null (race condition / already consumed)", async () => {
            setupAbortedDelegation();

            const killEnvelope = buildKillSignalEnvelope(DELEGATION_C_CONV);

            // First call consumes the target
            await handleDelegationCompletion(killEnvelope);

            // Second call: target is already consumed — must return recorded:false
            const secondResult = await handleDelegationCompletion(killEnvelope);
            expect(secondResult.recorded).toBe(false);
        });

        it("does NOT call ConversationStore.addEnvelope with the kill-signal envelope", async () => {
            setupAbortedDelegation();

            const killEnvelope = buildKillSignalEnvelope(DELEGATION_C_CONV);
            await handleDelegationCompletion(killEnvelope);

            // addEnvelope should never have been called with a kill-signal envelope
            const killSignalCalls = conversationStoreAddEnvelopeSpy.mock.calls.filter(
                (call) => (call[1] as typeof killEnvelope)?.metadata?.isKillSignal === true
            );
            expect(killSignalCalls.length).toBe(0);
        });

        it("returns recorded:false for a normal (non-kill-signal) envelope without replyTargets", async () => {
            const normalEnvelope = createMockInboundEnvelope({
                metadata: {
                    replyTargets: [], // empty — no delegation completion
                },
            });

            const result = await handleDelegationCompletion(normalEnvelope);
            expect(result.recorded).toBe(false);
        });
    });

    describe("abortWithCascade with paused child (Issue #2 regression)", () => {
        /**
         * When a child agent is paused/resumable (no active abort controllers and no
         * active LLM request), abortWithCascade must still call markParentDelegationKilled
         * so consumeImplicitKillWakeTarget can wake up the waiting parent.
         */
        it("still marks parent delegation killed when child has no active abort controllers", async () => {
            // Set up: B is waiting on delegation to C
            const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
            const pendingDelegation: PendingDelegation = {
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                senderPubkey: agentB.pubkey,
                prompt: "Do something",
                ralNumber,
            };
            registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, [pendingDelegation]);

            // Create C's RAL but register NO abort controllers (paused state)
            registry.create(agentC.pubkey, DELEGATION_C_CONV, PROJECT_ID);

            // Kill C — it has no active abort controllers or LLM request (paused)
            await registry.abortWithCascade(
                agentC.pubkey,
                DELEGATION_C_CONV,
                PROJECT_ID,
                "test kill of paused child"
            );

            // consumeImplicitKillWakeTarget must find an aborted entry — proving
            // markParentDelegationKilled was called unconditionally despite directAbortCount === 0
            const wakeTarget = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            expect(wakeTarget).not.toBeNull();
            expect(wakeTarget?.agentPubkey).toBe(agentB.pubkey);
            expect(wakeTarget?.conversationId).toBe(CONV_B);
        });

        it("is one-shot — second consumeImplicitKillWakeTarget returns null after paused kill", async () => {
            const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
            registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, [{
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                senderPubkey: agentB.pubkey,
                prompt: "Do something",
                ralNumber,
            }]);
            registry.create(agentC.pubkey, DELEGATION_C_CONV, PROJECT_ID);

            await registry.abortWithCascade(agentC.pubkey, DELEGATION_C_CONV, PROJECT_ID, "test");

            const first = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            const second = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);

            expect(first).not.toBeNull();
            expect(second).toBeNull();
        });
    });

    describe("kill tool executor passing (Issue #1 regression)", () => {
        /**
         * dispatchKillWakeup must receive the executor from the kill tool's execution
         * context rather than reading a stale singleton field. These tests verify the
         * executor flows from createKillTool → executeKill → killAgent → dispatchKillWakeup.
         */
        let dispatchKillWakeupSpy: ReturnType<typeof spyOn>;
        let conversationStoreHasSpy: ReturnType<typeof spyOn>;

        beforeEach(() => {
            dispatchKillWakeupSpy = spyOn(
                AgentDispatchService.getInstance(),
                "dispatchKillWakeup"
            ).mockResolvedValue(undefined);
            conversationStoreHasSpy = spyOn(ConversationStore, "has").mockReturnValue(true);
        });

        afterEach(() => {
            dispatchKillWakeupSpy?.mockRestore();
            conversationStoreHasSpy?.mockRestore();
        });

        it("passes executor from context to dispatchKillWakeup in pre-emptive kill path", async () => {
            // Set up B waiting on delegation to C so getDelegationRecipientPubkey works
            const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
            registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, [{
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                senderPubkey: agentB.pubkey,
                prompt: "Do something",
                ralNumber,
            }]);

            // C's conversation has no active RALs (pre-emptive kill path)
            const mockTargetConversation = {
                id: DELEGATION_C_CONV,
                getProjectId: () => PROJECT_ID,
                getAllActiveRals: () => new Map<string, unknown>(),
                blockAgent: () => {},
                addMessage: () => {},
                save: async () => {},
            };

            conversationStoreGetSpy.mockReturnValue(mockTargetConversation as never);

            // Caller conversation has the same project ID (authorization passes)
            const mockCallerConversation = {
                id: CONV_B,
                getProjectId: () => PROJECT_ID,
            };

            // Distinct mock executor — must be the same object that reaches dispatchKillWakeup
            const mockExecutor = { execute: async () => undefined } as never;

            const killContext = {
                agent: { slug: agentB.slug, pubkey: agentB.pubkey, name: agentB.name },
                conversationId: CONV_B,
                getConversation: () => mockCallerConversation,
                projectContext: { project: { dTag: PROJECT_ID } },
                agentExecutor: mockExecutor,
                // Required by ToolRegistryContext but not exercised in pre-emptive kill path
                agentPublisher: {} as never,
                ralNumber: ralNumber,
                conversationStore: {} as never,
            } as never;

            const killTool = createKillTool(killContext);
            await killTool.execute({ target: DELEGATION_C_CONV, reason: "test executor passing" });

            expect(dispatchKillWakeupSpy).toHaveBeenCalledTimes(1);
            const [calledConvId, calledExecutor] = dispatchKillWakeupSpy.mock.calls[0] as [string, unknown];
            expect(calledConvId).toBe(DELEGATION_C_CONV);
            expect(calledExecutor).toBe(mockExecutor);
        });
    });
});
