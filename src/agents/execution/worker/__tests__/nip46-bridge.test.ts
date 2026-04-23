import { afterEach, describe, expect, it } from "bun:test";
import {
    AGENT_WORKER_PROTOCOL_VERSION,
    AgentWorkerProtocolMessageSchema,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";
import type {
    AgentWorkerOutboundProtocolMessage,
    AgentWorkerProtocolEmit,
} from "../protocol-emitter";
import {
    Nip46PublishCoordinator,
    Nip46PublishError,
    Nip46WorkerBridge,
} from "../nip46-bridge";

const AGENT_PUBKEY = "a".repeat(64);
const OWNER_PUBKEY = "b".repeat(64);
const EVENT_ID = "1".repeat(64);

type Nip46PublishRequestMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "nip46_publish_request" }
>;
type Nip46PublishResultMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "nip46_publish_result" }
>;

function buildBaseInput(): Parameters<Nip46WorkerBridge["requestPublish"]>[0] {
    return {
        correlationId: "exec_abc",
        projectId: "project-alpha",
        agentPubkey: AGENT_PUBKEY,
        conversationId: "conversation-alpha",
        ralNumber: 3,
        requestId: "publish-request-1",
        ownerPubkey: OWNER_PUBKEY,
        waitForRelayOk: true,
        timeoutMs: 5_000,
        unsignedEvent: {
            kind: 1,
            content: "hello",
            tags: [["t", "tenex"]],
        },
        tenexExplanation: "Please sign this comment",
    };
}

function recordingEmit(): {
    emit: AgentWorkerProtocolEmit;
    emitted: AgentWorkerOutboundProtocolMessage[];
} {
    const emitted: AgentWorkerOutboundProtocolMessage[] = [];
    let sequence = 0;
    const emit: AgentWorkerProtocolEmit = async (message) => {
        sequence += 1;
        const framed = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            sequence,
            timestamp: 1_710_000_000_000 + sequence,
            ...message,
        } as AgentWorkerOutboundProtocolMessage;
        emitted.push(framed);
        return framed;
    };
    return { emit, emitted };
}

describe("Nip46WorkerBridge", () => {
    afterEach(() => {
        Nip46WorkerBridge.uninstall();
    });

    it("emits a valid nip46_publish_request frame and resolves with the eventId on accepted result", async () => {
        const { emit, emitted } = recordingEmit();
        const coordinator = new Nip46PublishCoordinator();
        const bridge = new Nip46WorkerBridge(emit, coordinator);

        const promise = bridge.requestPublish(buildBaseInput());

        // Allow the emit microtask to run before resolving the result.
        await Promise.resolve();
        expect(emitted).toHaveLength(1);
        const frame = emitted[0] as Nip46PublishRequestMessage;
        expect(frame.type).toBe("nip46_publish_request");
        expect(frame.requestId).toBe("publish-request-1");
        expect(frame.ownerPubkey).toBe(OWNER_PUBKEY);
        expect(frame.tenexExplanation).toBe("Please sign this comment");
        expect(frame.unsignedEvent).toEqual({
            kind: 1,
            content: "hello",
            tags: [["t", "tenex"]],
        });
        expect(AgentWorkerProtocolMessageSchema.safeParse(frame).success).toBe(true);

        const accepted: Nip46PublishResultMessage = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "nip46_publish_result",
            correlationId: "exec_abc",
            sequence: 99,
            timestamp: 1_710_000_999_999,
            projectId: "project-alpha",
            agentPubkey: AGENT_PUBKEY,
            conversationId: "conversation-alpha",
            ralNumber: 3,
            requestId: "publish-request-1",
            status: "accepted",
            eventId: EVENT_ID,
        };
        coordinator.resolve(accepted);

        const eventId = await promise;
        expect(eventId).toBe(EVENT_ID);
    });

    it("throws Nip46PublishError with reason when the daemon reports rejected", async () => {
        const { emit } = recordingEmit();
        const coordinator = new Nip46PublishCoordinator();
        const bridge = new Nip46WorkerBridge(emit, coordinator);

        const promise = bridge.requestPublish(buildBaseInput());
        await Promise.resolve();

        coordinator.resolve({
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "nip46_publish_result",
            correlationId: "exec_abc",
            sequence: 100,
            timestamp: 1_710_000_999_999,
            projectId: "project-alpha",
            agentPubkey: AGENT_PUBKEY,
            conversationId: "conversation-alpha",
            ralNumber: 3,
            requestId: "publish-request-1",
            status: "rejected",
            reason: "user denied",
        });

        await expect(promise).rejects.toBeInstanceOf(Nip46PublishError);
        try {
            await promise;
        } catch (error) {
            expect((error as Nip46PublishError).status).toBe("rejected");
            expect((error as Nip46PublishError).reason).toBe("user denied");
        }
    });

    it("Nip46WorkerBridge.current() throws before install", () => {
        Nip46WorkerBridge.uninstall();
        expect(() => Nip46WorkerBridge.current()).toThrow(
            /Nip46WorkerBridge not installed/
        );
    });

    it("install/current makes the singleton bridge reachable", async () => {
        const { emit } = recordingEmit();
        const coordinator = new Nip46PublishCoordinator();
        Nip46WorkerBridge.install(emit, coordinator);

        const installed = Nip46WorkerBridge.current();
        const promise = installed.requestPublish(buildBaseInput());
        await Promise.resolve();
        coordinator.resolve({
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "nip46_publish_result",
            correlationId: "exec_abc",
            sequence: 101,
            timestamp: 1_710_000_999_999,
            projectId: "project-alpha",
            agentPubkey: AGENT_PUBKEY,
            conversationId: "conversation-alpha",
            ralNumber: 3,
            requestId: "publish-request-1",
            status: "accepted",
            eventId: EVENT_ID,
        });
        const eventId = await promise;
        expect(eventId).toBe(EVENT_ID);
    });

    it("buffers an early result and delivers it to a later waiter", async () => {
        const coordinator = new Nip46PublishCoordinator();
        coordinator.resolve({
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "nip46_publish_result",
            correlationId: "exec_abc",
            sequence: 102,
            timestamp: 1_710_000_999_999,
            projectId: "project-alpha",
            agentPubkey: AGENT_PUBKEY,
            conversationId: "conversation-alpha",
            ralNumber: 3,
            requestId: "publish-request-1",
            status: "accepted",
            eventId: EVENT_ID,
        });

        const result = await coordinator.waitForNip46Result("publish-request-1", 1_000);
        expect(result.eventId).toBe(EVENT_ID);
    });

    it("rejects pending waiters when shutdown calls rejectAll", async () => {
        const coordinator = new Nip46PublishCoordinator();
        const promise = coordinator.waitForNip46Result("publish-request-1", 5_000);
        coordinator.rejectAll(new Error("worker shutdown"));
        await expect(promise).rejects.toThrow("worker shutdown");
    });
});
