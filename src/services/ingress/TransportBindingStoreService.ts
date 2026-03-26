import type { RuntimeTransport } from "@/events/runtime/InboundEnvelope";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TransportBindingRecord {
    transport: RuntimeTransport;
    agentPubkey: string;
    channelId: string;
    projectId: string;
    createdAt: number;
    updatedAt: number;
}

const TRANSPORT_BINDINGS_FILENAME = "transport-bindings.json";

function isRuntimeTransport(value: string | undefined): value is RuntimeTransport {
    return value === "local" ||
        value === "mcp" ||
        value === "nostr" ||
        value === "telegram";
}

function inferTransportFromChannelId(channelId: string): RuntimeTransport | undefined {
    const [transport] = channelId.split(":", 1);
    return isRuntimeTransport(transport) ? transport : undefined;
}

function resolveTransport(
    channelId: string,
    transport?: RuntimeTransport
): RuntimeTransport | undefined {
    return transport ?? inferTransportFromChannelId(channelId);
}

function makeKey(agentPubkey: string, channelId: string, transport: RuntimeTransport): string {
    return `${transport}::${agentPubkey}::${channelId}`;
}

function normalizeBindingRecord(
    record: TransportBindingRecord
): TransportBindingRecord | undefined {
    const transport = resolveTransport(record.channelId, record.transport);
    if (!transport || !record.agentPubkey || !record.channelId || !record.projectId) {
        return undefined;
    }

    return {
        ...record,
        transport,
    };
}

export class TransportBindingStore {
    private static instance: TransportBindingStore;
    private readonly bindings = new Map<string, TransportBindingRecord>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            TRANSPORT_BINDINGS_FILENAME
        )
    ) {}

    static getInstance(): TransportBindingStore {
        if (!TransportBindingStore.instance) {
            TransportBindingStore.instance = new TransportBindingStore();
        }
        return TransportBindingStore.instance;
    }

    static resetInstance(): void {
        TransportBindingStore.instance = undefined as unknown as TransportBindingStore;
    }

    getBinding(
        agentPubkey: string,
        channelId: string,
        transport?: RuntimeTransport
    ): TransportBindingRecord | undefined {
        this.ensureLoaded();
        const resolvedTransport = resolveTransport(channelId, transport);
        if (!resolvedTransport) {
            return undefined;
        }
        return this.bindings.get(makeKey(agentPubkey, channelId, resolvedTransport));
    }

    rememberBinding(
        record: Omit<TransportBindingRecord, "createdAt" | "updatedAt">
    ): TransportBindingRecord {
        this.ensureLoaded();
        const transport = resolveTransport(record.channelId, record.transport);
        if (!transport) {
            throw new Error(
                `Cannot remember transport binding without a valid transport for channel ${record.channelId}`
            );
        }

        const key = makeKey(record.agentPubkey, record.channelId, transport);
        const existing = this.bindings.get(key);
        const next: TransportBindingRecord = {
            ...record,
            transport,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
        };
        this.bindings.set(key, next);
        this.persist();
        return next;
    }

    clearBinding(agentPubkey: string, channelId: string, transport?: RuntimeTransport): void {
        this.ensureLoaded();
        const resolvedTransport = resolveTransport(channelId, transport);
        if (!resolvedTransport) {
            return;
        }
        this.bindings.delete(makeKey(agentPubkey, channelId, resolvedTransport));
        this.persist();
    }

    listBindings(): TransportBindingRecord[] {
        this.ensureLoaded();
        return Array.from(this.bindings.values());
    }

    listBindingsForAgentProject(
        agentPubkey: string,
        projectId: string,
        transport?: RuntimeTransport
    ): TransportBindingRecord[] {
        this.ensureLoaded();
        return Array.from(this.bindings.values()).filter((binding) =>
            binding.agentPubkey === agentPubkey &&
            binding.projectId === projectId &&
            (!transport || binding.transport === transport)
        );
    }

    private ensureLoaded(): void {
        if (this.loaded) {
            return;
        }

        this.loaded = true;

        if (existsSync(this.storagePath)) {
            try {
                const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TransportBindingRecord[];
                for (const binding of parsed) {
                    const normalized = normalizeBindingRecord(binding);
                    if (!normalized) {
                        continue;
                    }
                    this.bindings.set(
                        makeKey(normalized.agentPubkey, normalized.channelId, normalized.transport),
                        normalized
                    );
                }
            } catch (error) {
                logger.warn("[TransportBindingStore] Failed to load transport bindings", {
                    storagePath: this.storagePath,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    private persist(): void {
        try {
            mkdirSync(dirname(this.storagePath), { recursive: true });
            writeFileSync(
                this.storagePath,
                `${JSON.stringify(Array.from(this.bindings.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[TransportBindingStore] Failed to persist transport bindings", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export const getTransportBindingStore = (): TransportBindingStore =>
    TransportBindingStore.getInstance();
