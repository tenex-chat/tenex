import {
    AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES,
    AGENT_WORKER_MAX_FRAME_BYTES,
    AgentWorkerProtocolFrameError,
    decodeAgentWorkerProtocolFrame,
    encodeAgentWorkerProtocolFrame,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";

export type AgentWorkerProtocolFrameSink = {
    write(chunk: Uint8Array): boolean | void;
    once?: (event: "drain" | "error", listener: (value?: unknown) => void) => unknown;
};

export class AgentWorkerProtocolStreamDecoder {
    private buffer: Uint8Array = new Uint8Array(0);

    push(chunk: Uint8Array | string): AgentWorkerProtocolMessage[] {
        const bytes = chunkToBytes(chunk);
        if (bytes.byteLength === 0) {
            return [];
        }

        this.buffer = appendBytes(this.buffer, bytes);
        const messages: AgentWorkerProtocolMessage[] = [];

        while (this.buffer.byteLength >= AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES) {
            const view = new DataView(
                this.buffer.buffer,
                this.buffer.byteOffset,
                this.buffer.byteLength
            );
            const payloadByteLength = view.getUint32(0, false);
            const frameByteLength =
                AGENT_WORKER_FRAME_LENGTH_PREFIX_BYTES + payloadByteLength;

            if (frameByteLength > AGENT_WORKER_MAX_FRAME_BYTES) {
                throw new AgentWorkerProtocolFrameError(
                    `Agent worker protocol frame exceeds ${AGENT_WORKER_MAX_FRAME_BYTES} bytes`
                );
            }

            if (this.buffer.byteLength < frameByteLength) {
                break;
            }

            messages.push(
                decodeAgentWorkerProtocolFrame(this.buffer.subarray(0, frameByteLength))
            );
            this.buffer = this.buffer.slice(frameByteLength);
        }

        return messages;
    }

    finish(): void {
        if (this.buffer.byteLength > 0) {
            throw new AgentWorkerProtocolFrameError(
                `Agent worker protocol stream ended with ${this.buffer.byteLength} buffered bytes`
            );
        }
    }
}

export async function* decodeAgentWorkerProtocolChunks(
    chunks: AsyncIterable<Uint8Array | string>
): AsyncGenerator<AgentWorkerProtocolMessage> {
    const decoder = new AgentWorkerProtocolStreamDecoder();

    for await (const chunk of chunks) {
        for (const message of decoder.push(chunk)) {
            yield message;
        }
    }

    decoder.finish();
}

export async function writeAgentWorkerProtocolFrame(
    sink: AgentWorkerProtocolFrameSink,
    value: unknown
): Promise<void> {
    const accepted = sink.write(encodeAgentWorkerProtocolFrame(value));
    if (accepted !== false) {
        return;
    }

    if (!sink.once) {
        throw new AgentWorkerProtocolFrameError(
            "Agent worker protocol sink reported backpressure without drain support"
        );
    }

    await new Promise<void>((resolve, reject) => {
        sink.once?.("drain", () => resolve());
        sink.once?.("error", (error) => reject(error));
    });
}

function chunkToBytes(chunk: Uint8Array | string): Uint8Array {
    if (typeof chunk === "string") {
        return new TextEncoder().encode(chunk);
    }
    return chunk;
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    if (left.byteLength === 0) {
        return right;
    }

    const combined = new Uint8Array(left.byteLength + right.byteLength);
    combined.set(left, 0);
    combined.set(right, left.byteLength);
    return combined;
}
