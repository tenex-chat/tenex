import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_SESSION_TTL_MS = 1000 * 60 * 15;

export type TelegramConfigSessionKind = "model" | "tools";

export interface TelegramConfigSessionRecord {
    id: string;
    kind: TelegramConfigSessionKind;
    projectId: string;
    projectTitle: string;
    projectBinding: string;
    agentPubkey: string;
    agentName: string;
    principalId: string;
    chatId: string;
    channelId: string;
    messageId: string;
    messageThreadId?: string;
    currentPage: number;
    availableModels: string[];
    availableTools: string[];
    selectedModel: string;
    selectedTools: string[];
    createdAt: number;
    updatedAt: number;
}

function isExpired(
    record: Pick<TelegramConfigSessionRecord, "updatedAt">,
    now: number = Date.now()
): boolean {
    return now - record.updatedAt > CONFIG_SESSION_TTL_MS;
}

export class TelegramConfigSessionStore {
    private static instance: TelegramConfigSessionStore;
    private readonly sessions = new Map<string, TelegramConfigSessionRecord>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            "telegram-config-sessions.json"
        )
    ) {}

    static getInstance(): TelegramConfigSessionStore {
        if (!TelegramConfigSessionStore.instance) {
            TelegramConfigSessionStore.instance = new TelegramConfigSessionStore();
        }
        return TelegramConfigSessionStore.instance;
    }

    static resetInstance(): void {
        TelegramConfigSessionStore.instance = undefined as unknown as TelegramConfigSessionStore;
    }

    createSession(
        record: Omit<TelegramConfigSessionRecord, "createdAt" | "id" | "updatedAt">
    ): TelegramConfigSessionRecord {
        this.ensureLoaded();
        this.pruneExpired();

        const session: TelegramConfigSessionRecord = {
            ...record,
            id: randomBytes(6).toString("base64url"),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        this.sessions.set(session.id, session);
        this.persist();
        return session;
    }

    getSession(id: string): TelegramConfigSessionRecord | undefined {
        this.ensureLoaded();
        const session = this.sessions.get(id);
        if (!session) {
            return undefined;
        }

        if (isExpired(session)) {
            this.sessions.delete(id);
            this.persist();
            return undefined;
        }

        return session;
    }

    updateSession(
        id: string,
        updates: Partial<Omit<TelegramConfigSessionRecord, "createdAt" | "id">>
    ): TelegramConfigSessionRecord | undefined {
        this.ensureLoaded();
        const existing = this.getSession(id);
        if (!existing) {
            return undefined;
        }

        const next: TelegramConfigSessionRecord = {
            ...existing,
            ...updates,
            updatedAt: Date.now(),
        };

        this.sessions.set(id, next);
        this.persist();
        return next;
    }

    clearSession(id: string): void {
        this.ensureLoaded();
        this.sessions.delete(id);
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
            let droppedExpired = false;
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TelegramConfigSessionRecord[];
            for (const record of parsed) {
                if (!record.id) {
                    continue;
                }

                if (isExpired(record)) {
                    droppedExpired = true;
                    continue;
                }

                this.sessions.set(record.id, record);
            }

            if (droppedExpired) {
                this.persist();
            }
        } catch (error) {
            logger.warn("[TelegramConfigSessionStore] Failed to load config sessions", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private pruneExpired(now: number = Date.now()): void {
        let changed = false;
        for (const [id, record] of this.sessions.entries()) {
            if (!isExpired(record, now)) {
                continue;
            }

            this.sessions.delete(id);
            changed = true;
        }

        if (changed) {
            this.persist();
        }
    }

    private persist(): void {
        try {
            mkdirSync(dirname(this.storagePath), { recursive: true });
            writeFileSync(
                this.storagePath,
                `${JSON.stringify(Array.from(this.sessions.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[TelegramConfigSessionStore] Failed to persist config sessions", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export const getTelegramConfigSessionStore = (): TelegramConfigSessionStore =>
    TelegramConfigSessionStore.getInstance();
