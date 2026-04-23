import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";

type Nip46PublishResultMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "nip46_publish_result" }
>;

export interface Nip46PublishRequestInput {
    correlationId: string;
    projectId: string;
    agentPubkey: string;
    conversationId: string;
    ralNumber: number;
    requestId: string;
    ownerPubkey: string;
    waitForRelayOk: boolean;
    timeoutMs: number;
    unsignedEvent: {
        kind: number;
        content: string;
        tags: string[][];
        created_at?: number;
    };
    tenexExplanation?: string;
}

export interface Nip46PublishCoordinatorTransport {
    waitForNip46Result(requestId: string, timeoutMs: number): Promise<Nip46PublishResultMessage>;
}

export class Nip46PublishCoordinator implements Nip46PublishCoordinatorTransport {
    private readonly bufferedResults = new Map<string, Nip46PublishResultMessage>();
    private readonly waiters = new Map<
        string,
        {
            resolve: (message: Nip46PublishResultMessage) => void;
            reject: (error: Error) => void;
            timeout: ReturnType<typeof setTimeout>;
        }
    >();

    waitForNip46Result(requestId: string, timeoutMs: number): Promise<Nip46PublishResultMessage> {
        const buffered = this.bufferedResults.get(requestId);
        if (buffered) {
            this.bufferedResults.delete(requestId);
            return Promise.resolve(buffered);
        }

        return new Promise<Nip46PublishResultMessage>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.waiters.delete(requestId);
                reject(new Error(`Timed out waiting for nip46_publish_result ${requestId}`));
            }, timeoutMs);

            this.waiters.set(requestId, { resolve, reject, timeout });
        });
    }

    resolve(message: Nip46PublishResultMessage): void {
        const waiter = this.waiters.get(message.requestId);
        if (!waiter) {
            this.bufferedResults.set(message.requestId, message);
            return;
        }

        clearTimeout(waiter.timeout);
        this.waiters.delete(message.requestId);
        waiter.resolve(message);
    }

    rejectAll(error: Error): void {
        for (const [requestId, waiter] of this.waiters) {
            clearTimeout(waiter.timeout);
            this.waiters.delete(requestId);
            waiter.reject(error);
        }
    }
}

let installedBridge: Nip46WorkerBridge | undefined;

export class Nip46WorkerBridge {
    constructor(
        private readonly emit: AgentWorkerProtocolEmit,
        private readonly transport: Nip46PublishCoordinatorTransport
    ) {}

    static install(emit: AgentWorkerProtocolEmit, transport: Nip46PublishCoordinatorTransport): void {
        installedBridge = new Nip46WorkerBridge(emit, transport);
    }

    static uninstall(): void {
        installedBridge = undefined;
    }

    static current(): Nip46WorkerBridge {
        if (!installedBridge) {
            throw new Error(
                "Nip46WorkerBridge not installed: NIP-46 publishing is only available inside the agent worker process"
            );
        }
        return installedBridge;
    }

    async requestPublish(input: Nip46PublishRequestInput): Promise<string> {
        await this.emit({
            type: "nip46_publish_request",
            correlationId: input.correlationId,
            projectId: input.projectId,
            agentPubkey: input.agentPubkey,
            conversationId: input.conversationId,
            ralNumber: input.ralNumber,
            requestId: input.requestId,
            ownerPubkey: input.ownerPubkey,
            waitForRelayOk: input.waitForRelayOk,
            timeoutMs: input.timeoutMs,
            unsignedEvent: input.unsignedEvent,
            ...(input.tenexExplanation ? { tenexExplanation: input.tenexExplanation } : {}),
        });

        const result = await this.transport.waitForNip46Result(
            input.requestId,
            input.timeoutMs
        );

        if (result.status === "accepted") {
            if (!result.eventId) {
                throw new Error(
                    `nip46_publish_result for ${input.requestId} accepted without eventId`
                );
            }
            return result.eventId;
        }

        const reason = result.reason ?? "(no reason provided)";
        throw new Nip46PublishError(result.status, reason);
    }
}

export class Nip46PublishError extends Error {
    readonly status: "rejected" | "failed";
    readonly reason: string;

    constructor(status: "rejected" | "failed", reason: string) {
        super(`NIP-46 publish ${status}: ${reason}`);
        this.name = "Nip46PublishError";
        this.status = status;
        this.reason = reason;
    }
}
