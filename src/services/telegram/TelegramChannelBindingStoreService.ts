import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TelegramChannelBindingRecord {
    agentPubkey: string;
    channelId: string;
    projectId: string;
    createdAt: number;
    updatedAt: number;
}

function makeKey(agentPubkey: string, channelId: string): string {
    return `${agentPubkey}::${channelId}`;
}

export class TelegramChannelBindingStore {
    private static instance: TelegramChannelBindingStore;
    private readonly bindings = new Map<string, TelegramChannelBindingRecord>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            "telegram-channel-bindings.json"
        )
    ) {}

    static getInstance(): TelegramChannelBindingStore {
        if (!TelegramChannelBindingStore.instance) {
            TelegramChannelBindingStore.instance = new TelegramChannelBindingStore();
        }
        return TelegramChannelBindingStore.instance;
    }

    static resetInstance(): void {
        TelegramChannelBindingStore.instance = undefined as unknown as TelegramChannelBindingStore;
    }

    getBinding(agentPubkey: string, channelId: string): TelegramChannelBindingRecord | undefined {
        this.ensureLoaded();
        return this.bindings.get(makeKey(agentPubkey, channelId));
    }

    rememberBinding(
        record: Omit<TelegramChannelBindingRecord, "createdAt" | "updatedAt">
    ): TelegramChannelBindingRecord {
        this.ensureLoaded();
        const key = makeKey(record.agentPubkey, record.channelId);
        const existing = this.bindings.get(key);
        const next: TelegramChannelBindingRecord = {
            ...record,
            createdAt: existing?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
        };
        this.bindings.set(key, next);
        this.persist();
        return next;
    }

    clearBinding(agentPubkey: string, channelId: string): void {
        this.ensureLoaded();
        this.bindings.delete(makeKey(agentPubkey, channelId));
        this.persist();
    }

    listBindings(): TelegramChannelBindingRecord[] {
        this.ensureLoaded();
        return Array.from(this.bindings.values());
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
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TelegramChannelBindingRecord[];
            for (const binding of parsed) {
                if (binding.agentPubkey && binding.channelId && binding.projectId) {
                    this.bindings.set(makeKey(binding.agentPubkey, binding.channelId), binding);
                }
            }
        } catch (error) {
            logger.warn("[TelegramChannelBindingStore] Failed to load bindings", {
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
                `${JSON.stringify(Array.from(this.bindings.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[TelegramChannelBindingStore] Failed to persist bindings", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export const getTelegramChannelBindingStore = (): TelegramChannelBindingStore =>
    TelegramChannelBindingStore.getInstance();
