import {
    AGENT_WORKER_MAX_FRAME_BYTES,
    AGENT_WORKER_PROTOCOL_ENCODING,
    AGENT_WORKER_PROTOCOL_VERSION,
    AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
    AGENT_WORKER_STREAM_BATCH_MS,
} from "@/events/runtime/AgentWorkerProtocol";
import {
    decodeAgentWorkerProtocolChunks,
    writeAgentWorkerProtocolFrame,
} from "@/agents/execution/worker/protocol";

let sequence = 0;

function nextSequence(): number {
    sequence += 1;
    return sequence;
}

async function main(): Promise<void> {
    await writeAgentWorkerProtocolFrame(process.stdout, {
        version: AGENT_WORKER_PROTOCOL_VERSION,
        type: "ready",
        correlationId: "worker_boot",
        sequence: nextSequence(),
        timestamp: Date.now(),
        workerId: `protocol-probe-${process.pid}`,
        pid: process.pid,
        protocol: {
            version: AGENT_WORKER_PROTOCOL_VERSION,
            encoding: AGENT_WORKER_PROTOCOL_ENCODING,
            maxFrameBytes: AGENT_WORKER_MAX_FRAME_BYTES,
            streamBatchMs: AGENT_WORKER_STREAM_BATCH_MS,
            streamBatchMaxBytes: AGENT_WORKER_STREAM_BATCH_MAX_BYTES,
        },
    });

    for await (const message of decodeAgentWorkerProtocolChunks(
        process.stdin as AsyncIterable<Uint8Array | string>
    )) {
        if (message.type === "ping") {
            await writeAgentWorkerProtocolFrame(process.stdout, {
                version: AGENT_WORKER_PROTOCOL_VERSION,
                type: "pong",
                correlationId: message.correlationId,
                sequence: nextSequence(),
                timestamp: Date.now(),
                replyingToSequence: message.sequence,
            });
            continue;
        }

        if (message.type === "shutdown") {
            return;
        }

        throw new Error(`Unexpected probe message type: ${message.type}`);
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
