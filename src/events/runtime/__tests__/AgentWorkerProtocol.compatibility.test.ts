import { describe, expect, it } from "bun:test";
import workerProtocolFixture from "@/test-utils/fixtures/worker-protocol/agent-execution.compat.json";
import {
    AGENT_WORKER_MAX_FRAME_BYTES,
    AGENT_WORKER_PROTOCOL_ENCODING,
    AGENT_WORKER_PROTOCOL_VERSION,
    AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
    AGENT_WORKER_STREAM_BATCH_MS,
    AgentWorkerProtocolFixtureSchema,
    AgentWorkerProtocolMessageSchema,
    getAgentWorkerProtocolDirection,
} from "../AgentWorkerProtocol";

describe("AgentWorkerProtocol compatibility fixture", () => {
    it("matches protocol constants and validates every fixture message", () => {
        const fixture = AgentWorkerProtocolFixtureSchema.parse(workerProtocolFixture);

        expect(fixture.protocol.version).toBe(AGENT_WORKER_PROTOCOL_VERSION);
        expect(fixture.protocol.encoding).toBe(AGENT_WORKER_PROTOCOL_ENCODING);
        expect(fixture.protocol.maxFrameBytes).toBe(AGENT_WORKER_MAX_FRAME_BYTES);
        expect(fixture.protocol.streamBatchMs).toBe(AGENT_WORKER_STREAM_BATCH_MS);
        expect(fixture.protocol.streamBatchMaxBytes).toBe(AGENT_WORKER_STREAM_BATCH_MAX_BYTES);

        for (const fixtureMessage of fixture.validMessages) {
            const result = AgentWorkerProtocolMessageSchema.safeParse(fixtureMessage.message);
            expect({ name: fixtureMessage.name, success: result.success }).toEqual({
                name: fixtureMessage.name,
                success: true,
            });
            expect(getAgentWorkerProtocolDirection(fixtureMessage.message)).toBe(
                fixtureMessage.direction
            );
        }

        for (const fixtureMessage of fixture.invalidMessages) {
            const result = AgentWorkerProtocolMessageSchema.safeParse(fixtureMessage.message);
            expect({ name: fixtureMessage.name, success: result.success }).toEqual({
                name: fixtureMessage.name,
                success: false,
            });
        }
    });

    it("enforces publish_result status and error semantics", () => {
        const baseMessage = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "publish_result",
            correlationId: "exec_publish_result_semantics",
            sequence: 9,
            timestamp: 1710000410400,
            requestId: "pub_semantics",
            requestSequence: 8,
            eventIds: [],
        };
        const error = {
            code: "publish_failed",
            message: "relay publish failed",
            retryable: true,
        };

        for (const status of ["failed", "timeout"] as const) {
            expect(
                AgentWorkerProtocolMessageSchema.safeParse({
                    ...baseMessage,
                    status,
                }).success
            ).toBe(false);
            expect(
                AgentWorkerProtocolMessageSchema.safeParse({
                    ...baseMessage,
                    status,
                    error,
                }).success
            ).toBe(true);
        }

        for (const status of ["accepted", "published"] as const) {
            expect(
                AgentWorkerProtocolMessageSchema.safeParse({
                    ...baseMessage,
                    status,
                    eventIds: ["published-event-id"],
                }).success
            ).toBe(true);
            expect(
                AgentWorkerProtocolMessageSchema.safeParse({
                    ...baseMessage,
                    status,
                    eventIds: ["published-event-id"],
                    error,
                }).success
            ).toBe(false);
        }
    });

    it("enforces publish_request runtimeEventClass and conversationVariant semantics", () => {
        const baseMessage = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "publish_request",
            correlationId: "exec_publish_request_class",
            sequence: 11,
            timestamp: 1710000410600,
            projectId: "project-alpha",
            agentPubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            conversationId: "conversation-alpha",
            ralNumber: 3,
            requestId: "pub_class_semantics",
            waitForRelayOk: true,
            timeoutMs: 10000,
            event: {
                id: "5195cbc7477f80ea8717d058f80b14ec6c0d53f149375d245965f22e8a8f86fc",
                pubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                kind: 1,
                content: "Done.",
                tags: [] as string[][],
                created_at: 1710000410,
                sig: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            },
        };

        expect(AgentWorkerProtocolMessageSchema.safeParse(baseMessage).success).toBe(false);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                runtimeEventClass: "complete",
            }).success
        ).toBe(true);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                runtimeEventClass: "conversation",
            }).success
        ).toBe(false);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                runtimeEventClass: "conversation",
                conversationVariant: "primary",
            }).success
        ).toBe(true);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                runtimeEventClass: "conversation",
                conversationVariant: "reasoning",
            }).success
        ).toBe(true);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                runtimeEventClass: "complete",
                conversationVariant: "primary",
            }).success
        ).toBe(false);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                runtimeEventClass: "something-else",
            }).success
        ).toBe(false);
    });

    it("enforces stream_delta inline payload and contentRef semantics", () => {
        const baseMessage = {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            type: "stream_delta",
            correlationId: "exec_stream_delta_semantics",
            sequence: 10,
            timestamp: 1710000410500,
            projectId: "project-alpha",
            agentPubkey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            conversationId: "conversation-alpha",
            ralNumber: 3,
            batchSequence: 1,
        };
        const contentRef = {
            path: "/tmp/tenex/worker/exec_stream_delta_semantics/delta-2.txt",
            byteLength: AGENT_WORKER_MAX_FRAME_BYTES + 1,
            sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        };

        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                delta: "x".repeat(AGENT_WORKER_STREAM_BATCH_MAX_BYTES),
            }).success
        ).toBe(true);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                delta: "x".repeat(AGENT_WORKER_STREAM_BATCH_MAX_BYTES + 1),
            }).success
        ).toBe(false);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                contentRef,
            }).success
        ).toBe(true);
        expect(
            AgentWorkerProtocolMessageSchema.safeParse({
                ...baseMessage,
                delta: "inline and referenced",
                contentRef,
            }).success
        ).toBe(false);

        for (const invalidContentRef of [
            { ...contentRef, path: "" },
            { ...contentRef, byteLength: 0 },
            { ...contentRef, sha256: contentRef.sha256.toUpperCase() },
        ]) {
            expect(
                AgentWorkerProtocolMessageSchema.safeParse({
                    ...baseMessage,
                    contentRef: invalidContentRef,
                }).success
            ).toBe(false);
        }
    });
});
