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
});
