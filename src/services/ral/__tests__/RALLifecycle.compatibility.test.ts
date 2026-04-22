import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import {
    AgentWorkerProtocolMessageSchema,
    getAgentWorkerProtocolDirection,
} from "@/events/runtime/AgentWorkerProtocol";
import ralLifecycleFixture from "@/test-utils/fixtures/daemon/ral-lifecycle.compat.json";
import { createProjectDTag } from "@/types/project-ids";
import { RALRegistry } from "../RALRegistry";
import type { PendingDelegation } from "../types";

describe("RAL lifecycle compatibility fixture", () => {
    let registry: RALRegistry;

    beforeEach(() => {
        // @ts-expect-error Reset singleton for test isolation.
        RALRegistry.instance = undefined;
        registry = RALRegistry.getInstance();
        setSystemTime(new Date(ralLifecycleFixture.clock.createdAt));
    });

    afterEach(() => {
        registry.clearAll();
        setSystemTime();
    });

    it("matches fresh, waiting, duplicate pending, and completed delegation semantics", () => {
        const { identity } = ralLifecycleFixture;
        const projectId = createProjectDTag(identity.projectId);

        const ralNumber = registry.create(
            identity.agentPubkey,
            identity.conversationId,
            projectId,
            identity.triggeringEventId
        );

        expect(ralNumber).toBe(ralLifecycleFixture.freshTurn.expected.ralNumber);
        const freshRal = registry.getRAL(identity.agentPubkey, identity.conversationId, ralNumber);
        expect(freshRal).toMatchObject({
            ralNumber,
            agentPubkey: identity.agentPubkey,
            projectId: identity.projectId,
            conversationId: identity.conversationId,
            isStreaming: ralLifecycleFixture.freshTurn.expected.isStreaming,
            queuedInjections: ralLifecycleFixture.freshTurn.expected.queuedInjections,
            originalTriggeringEventId: identity.triggeringEventId,
        });
        expect(freshRal?.activeTools.size).toBe(
            ralLifecycleFixture.freshTurn.expected.activeToolCount
        );
        expect(registry.getConversationPendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toEqual(ralLifecycleFixture.freshTurn.expected.pendingDelegations);
        expect(registry.getConversationCompletedDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toEqual(ralLifecycleFixture.freshTurn.expected.completedDelegations);
        expect(registry.hasOutstandingWork(identity.agentPubkey, identity.conversationId, ralNumber))
            .toEqual(ralLifecycleFixture.freshTurn.expected.outstandingWork);

        setSystemTime(new Date(ralLifecycleFixture.clock.delegationMergedAt));
        const initialDelegation =
            ralLifecycleFixture.waitingForDelegation.pendingDelegation as PendingDelegation;
        expect(registry.mergePendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber,
            [initialDelegation]
        )).toEqual(ralLifecycleFixture.waitingForDelegation.mergeResult);

        expect(registry.getConversationPendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toEqual([initialDelegation]);
        expect(registry.getConversationCompletedDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toHaveLength(ralLifecycleFixture.waitingForDelegation.expected.completedDelegationCount);
        expect(registry.findStateWaitingForDelegation(identity.delegationConversationId)?.ralNumber)
            .toBe(ralNumber);
        expect(Boolean(registry.findResumableRAL(identity.agentPubkey, identity.conversationId)))
            .toBe(ralLifecycleFixture.waitingForDelegation.expected.findResumableRAL);
        expect(registry.hasOutstandingWork(identity.agentPubkey, identity.conversationId, ralNumber))
            .toEqual(ralLifecycleFixture.waitingForDelegation.expected.outstandingWork);

        const duplicateDelegation =
            ralLifecycleFixture.duplicatePendingDelegation.pendingDelegation as PendingDelegation;
        expect(registry.mergePendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber,
            [duplicateDelegation]
        )).toEqual(ralLifecycleFixture.duplicatePendingDelegation.mergeResult);
        expect(registry.getConversationPendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toEqual([duplicateDelegation]);
        expect(registry.getConversationPendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toHaveLength(ralLifecycleFixture.duplicatePendingDelegation.expected.pendingDelegationCount);

        setSystemTime(new Date(ralLifecycleFixture.clock.delegationCompletedAt));
        expect(registry.recordCompletion(ralLifecycleFixture.completedDelegation.completion))
            .toEqual(ralLifecycleFixture.completedDelegation.recordCompletionLocation);
        expect(registry.getConversationPendingDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toHaveLength(ralLifecycleFixture.completedDelegation.expected.pendingDelegationCount);
        expect(registry.getConversationCompletedDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toEqual([ralLifecycleFixture.completedDelegation.completedDelegation]);
        expect(Boolean(registry.findStateWaitingForDelegation(identity.delegationConversationId)))
            .toBe(ralLifecycleFixture.completedDelegation.expected.findStateWaitingForDelegation);
        expect(Boolean(registry.findResumableRAL(identity.agentPubkey, identity.conversationId)))
            .toBe(ralLifecycleFixture.completedDelegation.expected.findResumableRAL);
        expect(registry.hasOutstandingWork(identity.agentPubkey, identity.conversationId, ralNumber))
            .toEqual(ralLifecycleFixture.completedDelegation.expected.outstandingWork);

        registry.clearCompletedDelegations(identity.agentPubkey, identity.conversationId, ralNumber);
        expect(registry.getConversationCompletedDelegations(
            identity.agentPubkey,
            identity.conversationId,
            ralNumber
        )).toHaveLength(
            ralLifecycleFixture.completedDelegation.expected.afterClearCompletedDelegations
                .completedDelegationCount
        );
        expect(registry.hasOutstandingWork(identity.agentPubkey, identity.conversationId, ralNumber))
            .toEqual(
                ralLifecycleFixture.completedDelegation.expected.afterClearCompletedDelegations
                    .outstandingWork
            );
    });

    it("matches no_response registry cleanup and worker terminal frame shapes", () => {
        const { identity } = ralLifecycleFixture;
        const projectId = createProjectDTag(identity.projectId);
        const ralNumber = registry.create(
            identity.agentPubkey,
            identity.conversationId,
            projectId,
            identity.triggeringEventId
        );

        setSystemTime(new Date(ralLifecycleFixture.clock.silentCompletionRequestedAt));
        expect(registry.requestSilentCompletion(identity.agentPubkey, identity.conversationId, ralNumber))
            .toBe(ralLifecycleFixture.noResponse.expected.requestSilentCompletionResult);
        expect(registry.isSilentCompletionRequested(identity.agentPubkey, identity.conversationId, ralNumber))
            .toBe(ralLifecycleFixture.noResponse.expected.silentCompletionRequested);
        expect(registry.hasOutstandingWork(identity.agentPubkey, identity.conversationId, ralNumber))
            .toEqual(ralLifecycleFixture.noResponse.expected.outstandingWork);
        expect(registry.clearSilentCompletionRequest(identity.agentPubkey, identity.conversationId, ralNumber))
            .toBe(ralLifecycleFixture.noResponse.expected.clearSilentCompletionRequestResult);

        registry.clearRAL(identity.agentPubkey, identity.conversationId, ralNumber);
        expect(Boolean(registry.getRAL(identity.agentPubkey, identity.conversationId, ralNumber)))
            .toBe(ralLifecycleFixture.noResponse.expected.ralExistsAfterClear);

        for (const [name, message] of Object.entries(ralLifecycleFixture.workerTerminalMessages)) {
            const result = AgentWorkerProtocolMessageSchema.safeParse(message);
            expect({ name, success: result.success }).toEqual({ name, success: true });
            expect(getAgentWorkerProtocolDirection(message)).toBe("worker_to_daemon");
        }
    });

    it("documents that duplicate triggering event IDs are not deduplicated by RALRegistry", () => {
        const { identity } = ralLifecycleFixture;
        const projectId = createProjectDTag(identity.projectId);

        const firstRalNumber = registry.create(
            identity.agentPubkey,
            identity.conversationId,
            projectId,
            identity.triggeringEventId
        );
        const secondRalNumber = registry.create(
            identity.agentPubkey,
            identity.conversationId,
            projectId,
            identity.triggeringEventId
        );
        const activeRals = registry.getActiveRALs(identity.agentPubkey, identity.conversationId);

        expect(firstRalNumber).toBe(ralLifecycleFixture.duplicateTrigger.expected.firstRalNumber);
        expect(secondRalNumber).toBe(ralLifecycleFixture.duplicateTrigger.expected.secondRalNumber);
        expect(activeRals).toHaveLength(ralLifecycleFixture.duplicateTrigger.expected.activeRalCount);
        expect(activeRals.map((ral) => ral.originalTriggeringEventId)).toEqual(
            ralLifecycleFixture.duplicateTrigger.expected.originalTriggeringEventIds
        );
    });
});
