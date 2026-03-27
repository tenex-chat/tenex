import type {
    TelegramChatAdministratorMetadata,
    TelegramSeenParticipantMetadata,
} from "@/events/runtime/InboundEnvelope";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TelegramChatContextRecord {
    projectId: string;
    agentPubkey: string;
    channelId: string;
    chatId: string;
    topicId?: string;
    chatTitle?: string;
    topicTitle?: string;
    chatUsername?: string;
    memberCount?: number;
    administrators: TelegramChatAdministratorMetadata[];
    seenParticipants: TelegramSeenParticipantMetadata[];
    updatedAt: number;
    lastApiSyncAt?: number;
}

function makeKey(projectId: string, agentPubkey: string, channelId: string): string {
    return `${projectId}::${agentPubkey}::${channelId}`;
}

export class TelegramChatContextStore {
    private static instance: TelegramChatContextStore;
    private readonly contexts = new Map<string, TelegramChatContextRecord>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            "telegram-chat-contexts.json"
        )
    ) {}

    static getInstance(): TelegramChatContextStore {
        if (!TelegramChatContextStore.instance) {
            TelegramChatContextStore.instance = new TelegramChatContextStore();
        }
        return TelegramChatContextStore.instance;
    }

    static resetInstance(): void {
        TelegramChatContextStore.instance = undefined as unknown as TelegramChatContextStore;
    }

    getContext(
        projectId: string,
        agentPubkey: string,
        channelId: string
    ): TelegramChatContextRecord | undefined {
        this.ensureLoaded();
        return this.contexts.get(makeKey(projectId, agentPubkey, channelId));
    }

    rememberContext(
        record: Omit<TelegramChatContextRecord, "updatedAt"> & { updatedAt?: number }
    ): TelegramChatContextRecord {
        this.ensureLoaded();
        const next: TelegramChatContextRecord = {
            ...record,
            updatedAt: record.updatedAt ?? Date.now(),
        };
        this.contexts.set(makeKey(record.projectId, record.agentPubkey, record.channelId), next);
        this.persist();
        return next;
    }

    listContexts(): TelegramChatContextRecord[] {
        this.ensureLoaded();
        return Array.from(this.contexts.values());
    }

    clear(): void {
        this.contexts.clear();
        this.loaded = true;
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
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TelegramChatContextRecord[];
            for (const context of parsed) {
                if (!context.projectId || !context.agentPubkey || !context.channelId || !context.chatId) {
                    continue;
                }
                this.contexts.set(
                    makeKey(context.projectId, context.agentPubkey, context.channelId),
                    {
                        ...context,
                        administrators: context.administrators ?? [],
                        seenParticipants: context.seenParticipants ?? [],
                    }
                );
            }
        } catch (error) {
            logger.warn("[TelegramChatContextStore] Failed to load chat contexts", {
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
                `${JSON.stringify(Array.from(this.contexts.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[TelegramChatContextStore] Failed to persist chat contexts", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export const getTelegramChatContextStore = (): TelegramChatContextStore =>
    TelegramChatContextStore.getInstance();
