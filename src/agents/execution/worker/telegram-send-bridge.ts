import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";

type TelegramSendResultMessage = Extract<
    AgentWorkerProtocolMessage,
    { type: "telegram_send_result" }
>;

/**
 * The worker-owned path for the `send_message` tool. The agent worker
 * session emits a `telegram_send_request` frame and awaits the correlated
 * `telegram_send_result` by correlation id. This bridge is the single
 * primitive the tool talks to; it has no Telegram specifics beyond the
 * protocol frames themselves.
 */
export interface TelegramSendBridge {
    sendProactive(params: {
        senderAgentPubkey: string;
        channelId: string;
        content: string;
    }): Promise<TelegramSendResultMessage>;
}

interface WorkerTelegramSendBridgeOptions {
    emit: AgentWorkerProtocolEmit;
    correlationId: string;
    /**
     * Producer for unique correlation ids so concurrent sends correlate to
     * distinct results. The worker session provides the execute
     * correlation id as a stable prefix; the coordinator appends a
     * per-request suffix.
     */
    nextRequestCorrelationId: () => string;
    results: TelegramSendResultSource;
    timeoutMs?: number;
}

export interface TelegramSendResultSource {
    waitForTelegramSendResult(
        correlationId: string,
        timeoutMs: number
    ): Promise<TelegramSendResultMessage>;
}

export class WorkerTelegramSendBridge implements TelegramSendBridge {
    private readonly timeoutMs: number;

    constructor(private readonly options: WorkerTelegramSendBridgeOptions) {
        this.timeoutMs = options.timeoutMs ?? 30_000;
    }

    async sendProactive(params: {
        senderAgentPubkey: string;
        channelId: string;
        content: string;
    }): Promise<TelegramSendResultMessage> {
        const correlationId = this.options.nextRequestCorrelationId();
        await this.options.emit({
            type: "telegram_send_request",
            correlationId,
            senderAgentPubkey: params.senderAgentPubkey,
            channelId: params.channelId,
            content: params.content,
        });
        return this.options.results.waitForTelegramSendResult(correlationId, this.timeoutMs);
    }
}

export class TelegramSendResultCoordinator implements TelegramSendResultSource {
    private readonly bufferedResults = new Map<string, TelegramSendResultMessage>();
    private readonly waiters = new Map<
        string,
        {
            resolve: (message: TelegramSendResultMessage) => void;
            reject: (error: Error) => void;
            timeout: ReturnType<typeof setTimeout>;
        }
    >();

    waitForTelegramSendResult(
        correlationId: string,
        timeoutMs: number
    ): Promise<TelegramSendResultMessage> {
        const buffered = this.bufferedResults.get(correlationId);
        if (buffered) {
            this.bufferedResults.delete(correlationId);
            return Promise.resolve(buffered);
        }

        return new Promise<TelegramSendResultMessage>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.waiters.delete(correlationId);
                reject(new Error(`Timed out waiting for telegram_send_result ${correlationId}`));
            }, timeoutMs);

            this.waiters.set(correlationId, { resolve, reject, timeout });
        });
    }

    resolve(message: TelegramSendResultMessage): void {
        const waiter = this.waiters.get(message.correlationId);
        if (!waiter) {
            this.bufferedResults.set(message.correlationId, message);
            return;
        }

        clearTimeout(waiter.timeout);
        this.waiters.delete(message.correlationId);
        waiter.resolve(message);
    }

    rejectAll(error: Error): void {
        for (const [correlationId, waiter] of this.waiters) {
            clearTimeout(waiter.timeout);
            this.waiters.delete(correlationId);
            waiter.reject(error);
        }
    }
}

// Module-local singleton used by the in-worker `send_message` tool to find
// the currently active bridge. Set during execution setup (see
// bootstrap.ts) and cleared once the execution completes; a tool call
// outside a registered execution is a programmer error and returns
// undefined so callers surface a structured tool error rather than crash.
let activeBridge: TelegramSendBridge | undefined;

export function setActiveTelegramSendBridge(bridge: TelegramSendBridge | undefined): void {
    activeBridge = bridge;
}

export function getActiveTelegramSendBridge(): TelegramSendBridge | undefined {
    return activeBridge;
}
