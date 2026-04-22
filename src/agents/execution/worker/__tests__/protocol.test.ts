import { describe, expect, it } from "bun:test";
import {
    AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES,
    AGENT_WORKER_MAX_FRAME_BYTES,
    AgentWorkerProtocolFrameError,
} from "@/events/runtime/AgentWorkerProtocol";
import { AgentWorkerProtocolStreamDecoder } from "../protocol";

describe("AgentWorkerProtocolStreamDecoder", () => {
    it("rejects declared oversized frames before buffering payload bytes", () => {
        const maxPayloadBytes = AGENT_WORKER_MAX_FRAME_BYTES - AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES;
        const frame = new Uint8Array(AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES);
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        view.setUint32(0, maxPayloadBytes + 1, false);

        expect(() => new AgentWorkerProtocolStreamDecoder().push(frame)).toThrow(
            AgentWorkerProtocolFrameError
        );
    });
});
