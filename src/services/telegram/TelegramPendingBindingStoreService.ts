import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
        return this.pending.get(makeKey(agentPubkey, channelId));
    }

    rememberPending(record: TelegramPendingBindingRecord): TelegramPendingBindingRecord {
        this.ensureLoaded();
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
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TelegramPendingBindingRecord[];
            for (const record of parsed) {
                if (record.agentPubkey && record.channelId) {
                    this.pending.set(makeKey(record.agentPubkey, record.channelId), record);
                }
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
}

export const getTelegramPendingBindingStore = (): TelegramPendingBindingStore =>
    TelegramPendingBindingStore.getInstance();
