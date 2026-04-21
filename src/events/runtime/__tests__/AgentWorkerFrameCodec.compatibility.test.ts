import { describe, expect, it } from "bun:test";
import frameCodecFixture from "@/test-utils/fixtures/worker-protocol/frame-codec.compat.json";
import {
    AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES,
    AGENT_WORKER_MAX_FRAME_BYTES,
    canonicalAgentWorkerProtocolJson,
    decodeAgentWorkerProtocolFrame,
    encodeAgentWorkerProtocolFrame,
} from "../AgentWorkerProtocol";

function bytesToHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("hex");
}

function bytesFromHex(hex: string): Uint8Array {
    return Uint8Array.from(Buffer.from(hex, "hex"));
}

describe("AgentWorkerProtocol frame codec compatibility fixture", () => {
    it("encodes and decodes canonical length-prefixed JSON frames", () => {
        expect(frameCodecFixture.format.lengthPrefixBytes).toBe(
            AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES
        );
        expect(frameCodecFixture.format.lengthEndian).toBe("big");
        expect(frameCodecFixture.format.maxFrameBytes).toBe(AGENT_WORKER_MAX_FRAME_BYTES);

        for (const frameFixture of frameCodecFixture.frames) {
            const encoded = encodeAgentWorkerProtocolFrame(frameFixture.message);

            expect({
                name: frameFixture.name,
                canonicalJson: canonicalAgentWorkerProtocolJson(frameFixture.message),
                frameHex: bytesToHex(encoded),
            }).toEqual({
                name: frameFixture.name,
                canonicalJson: frameFixture.canonicalJson,
                frameHex: frameFixture.frameHex,
            });

            const decoded = decodeAgentWorkerProtocolFrame(bytesFromHex(frameFixture.frameHex));
            expect({ name: frameFixture.name, decoded }).toEqual({
                name: frameFixture.name,
                decoded: frameFixture.message,
            });
        }
    });

    it("rejects invalid frames from the shared fixture", () => {
        for (const invalidFrame of frameCodecFixture.invalidFrames) {
            expect(() => decodeAgentWorkerProtocolFrame(bytesFromHex(invalidFrame.frameHex))).toThrow();
        }
    });
});
