import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PENDING_BINDING_TTL_MS = 1000 * 60 * 60 * 24;

export interface TelegramPendingProjectOption {
    projectId: string;
    title: string;
}

export interface TelegramPendingBindingRecord {
    agentPubkey: string;
    channelId: string;
    projects: TelegramPendingProjectOption[];
    requestedAt: number;
}

function makeKey(agentPubkey: string, channelId: string): string {
    return `${agentPubkey}::${channelId}`;
}

function isExpired(record: TelegramPendingBindingRecord, now: number = Date.now()): boolean {
    return now - record.requestedAt > PENDING_BINDING_TTL_MS;
}

export class TelegramPendingBindingStore {
    private static instance: TelegramPendingBindingStore;
    private readonly pending = new Map<string, TelegramPendingBindingRecord>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            "telegram-pending-bindings.json"
        )
    ) {}

    static getInstance(): TelegramPendingBindingStore {
        if (!TelegramPendingBindingStore.instance) {
            TelegramPendingBindingStore.instance = new TelegramPendingBindingStore();
        }
        return TelegramPendingBindingStore.instance;
    }

    static resetInstance(): void {
        TelegramPendingBindingStore.instance = undefined as unknown as TelegramPendingBindingStore;
    }

    getPending(agentPubkey: string, channelId: string): TelegramPendingBindingRecord | undefined {
        this.ensureLoaded();
        const key = makeKey(agentPubkey, channelId);
        const record = this.pending.get(key);
        if (!record) {
            return undefined;
        }

        if (isExpired(record)) {
            this.pending.delete(key);
            this.persist();
            return undefined;
        }

        return record;
    }

    rememberPending(record: TelegramPendingBindingRecord): TelegramPendingBindingRecord {
        this.ensureLoaded();
        this.pruneExpired();
        this.pending.set(makeKey(record.agentPubkey, record.channelId), record);
        this.persist();
        return record;
    }

    clearPending(agentPubkey: string, channelId: string): void {
        this.ensureLoaded();
        this.pending.delete(makeKey(agentPubkey, channelId));
        this.persist();
    }

    private ensureLoaded(): void {
        if (this.loaded) {
            return;
        }

        this.loaded = true;

        if (!existsSync(this.storagePath)) {
            return;
        }

        try {
            let droppedExpiredRecords = false;
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TelegramPendingBindingRecord[];
            for (const record of parsed) {
                if (!record.agentPubkey || !record.channelId) {
                    continue;
                }

                if (isExpired(record)) {
                    droppedExpiredRecords = true;
                    continue;
                }

                if (record.agentPubkey && record.channelId) {
                    this.pending.set(makeKey(record.agentPubkey, record.channelId), record);
                }
            }
            if (droppedExpiredRecords) {
                this.persist();
            }
        } catch (error) {
            logger.warn("[TelegramPendingBindingStore] Failed to load pending bindings", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private persist(): void {
        try {
            mkdirSync(dirname(this.storagePath), { recursive: true });
            writeFileSync(
                this.storagePath,
                `${JSON.stringify(Array.from(this.pending.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[TelegramPendingBindingStore] Failed to persist pending bindings", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private pruneExpired(now: number = Date.now()): void {
        let changed = false;

        for (const [key, record] of this.pending.entries()) {
            if (!isExpired(record, now)) {
                continue;
            }

            this.pending.delete(key);
            changed = true;
        }

        if (changed) {
            this.persist();
        }
    }
}

export const getTelegramPendingBindingStore = (): TelegramPendingBindingStore =>
    TelegramPendingBindingStore.getInstance();
