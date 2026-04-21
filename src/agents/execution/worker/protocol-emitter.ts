import {
    WORKER_TO_DAEMON_MESSAGE_TYPES,
    type AgentWorkerProtocolMessage,
} from "@/events/runtime/AgentWorkerProtocol";

type WorkerToDaemonMessageType = (typeof WORKER_TO_DAEMON_MESSAGE_TYPES)[number];

export type AgentWorkerOutboundProtocolMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: WorkerToDaemonMessageType }
>;

export type AgentWorkerProtocolEmit = (
    message: Omit<AgentWorkerOutboundProtocolMessage, "version" | "sequence" | "timestamp">
) => Promise<AgentWorkerOutboundProtocolMessage>;
