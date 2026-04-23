/**
 * Regression tests for delegation kill state after TypeScript daemon removal.
 *
 * The Bun worker still owns in-process RAL state for the active execution. The
 * Rust daemon owns scheduling, so the kill tool must update RAL/cooldown state
 * without depending on the removed TypeScript dispatch wake-up path.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import { CooldownRegistry } from "@/services/CooldownRegistry";
import { createKillTool } from "@/tools/implementations/kill";
import { RALRegistry } from "../RALRegistry";
import type { PendingDelegation } from "../types";

const PROJECT_ID = "31933:pubkey:test-project" as const;

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

describe("delegation kill state", () => {
    let registry: RALRegistry;
    let cooldownRegistry: CooldownRegistry;

    beforeEach(() => {
        // @ts-expect-error - test isolation for singleton-backed registry.
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
        cooldownRegistry = CooldownRegistry.getInstance();
        cooldownRegistry.clearAll();
    });

    afterEach(() => {
        registry.clearAll();
        cooldownRegistry.clearAll();
    });

    function setupDelegation(): number {
        const ralNumber = registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
        const pendingDelegation: PendingDelegation = {
            delegationConversationId: DELEGATION_C_CONV,
            recipientPubkey: agentC.pubkey,
            senderPubkey: agentB.pubkey,
            prompt: "Do something",
            ralNumber,
        };
        registry.setPendingDelegations(agentB.pubkey, CONV_B, ralNumber, [pendingDelegation]);
        return ralNumber;
    }

    function setupAbortedDelegation(): number {
        const ralNumber = setupDelegation();
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

        it("is one-shot", () => {
            setupAbortedDelegation();

            const first = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            const second = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);

            expect(first).not.toBeNull();
            expect(second).toBeNull();
        });

        it("returns null for unknown, completed, or still-pending delegations", () => {
            expect(registry.consumeImplicitKillWakeTarget("totally-unknown-conv-id")).toBeNull();

            const completedRal = setupDelegation();
            registry.recordCompletion({
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                response: "Done",
                completedAt: Date.now(),
            });
            expect(registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV)).toBeNull();

            registry.clearAll();
            registry.create(agentB.pubkey, CONV_B, PROJECT_ID);
            registry.setPendingDelegations(agentB.pubkey, CONV_B, completedRal, [{
                delegationConversationId: DELEGATION_C_CONV,
                recipientPubkey: agentC.pubkey,
                senderPubkey: agentB.pubkey,
                prompt: "Still running",
                ralNumber: completedRal,
            }]);
            expect(registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV)).toBeNull();
        });
    });

    describe("abortWithCascade with paused child", () => {
        it("marks parent delegation killed even when child has no active abort controllers", async () => {
            setupDelegation();
            registry.create(agentC.pubkey, DELEGATION_C_CONV, PROJECT_ID);

            await registry.abortWithCascade(
                agentC.pubkey,
                DELEGATION_C_CONV,
                PROJECT_ID,
                "test kill of paused child"
            );

            const wakeTarget = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            expect(wakeTarget).not.toBeNull();
            expect(wakeTarget?.agentPubkey).toBe(agentB.pubkey);
            expect(wakeTarget?.conversationId).toBe(CONV_B);
        });

        it("is one-shot after paused kill", async () => {
            setupDelegation();
            registry.create(agentC.pubkey, DELEGATION_C_CONV, PROJECT_ID);

            await registry.abortWithCascade(agentC.pubkey, DELEGATION_C_CONV, PROJECT_ID, "test");

            const first = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
            const second = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);

            expect(first).not.toBeNull();
            expect(second).toBeNull();
        });
    });

    describe("kill tool pre-emptive delegation abort", () => {
        it("marks the parent delegation killed and adds recipient cooldown without TypeScript dispatch", async () => {
            const ralNumber = setupDelegation();
            const conversationStoreHasSpy = spyOn(ConversationStore, "has").mockReturnValue(true);
            const conversationStoreGetSpy = spyOn(ConversationStore, "get").mockReturnValue({
                id: DELEGATION_C_CONV,
                getProjectId: () => PROJECT_ID,
                getAllActiveRals: () => new Map<string, unknown>(),
            } as never);

            try {
                const killContext = {
                    agent: { slug: agentB.slug, pubkey: agentB.pubkey, name: agentB.name },
                    conversationId: CONV_B,
                    getConversation: () => ({
                        id: CONV_B,
                        getProjectId: () => PROJECT_ID,
                    }),
                    projectContext: { project: { dTag: PROJECT_ID } },
                    ralNumber,
                    conversationStore: {} as never,
                } as never;

                const killTool = createKillTool(killContext);
                const result = await killTool.execute({
                    target: DELEGATION_C_CONV,
                    reason: "test pre-emptive kill",
                });

                expect(result.success).toBe(true);
                expect(result.cascadeAbortCount).toBe(1);
                expect(result.abortedTuples).toEqual([{
                    conversationId: DELEGATION_C_CONV,
                    agentPubkey: agentC.pubkey,
                }]);
                expect(cooldownRegistry.isInCooldown(PROJECT_ID, DELEGATION_C_CONV, agentC.pubkey)).toBe(true);

                const wakeTarget = registry.consumeImplicitKillWakeTarget(DELEGATION_C_CONV);
                expect(wakeTarget?.agentPubkey).toBe(agentB.pubkey);
                expect(wakeTarget?.conversationId).toBe(CONV_B);
            } finally {
                conversationStoreHasSpy.mockRestore();
                conversationStoreGetSpy.mockRestore();
            }
        });
    });
});
