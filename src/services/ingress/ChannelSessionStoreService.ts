import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ChannelSession {
    projectId: string;
    agentPubkey: string;
    channelId: string;
    conversationId: string;
    lastMessageId: string;
    updatedAt: number;
}

function makeKey(projectId: string, agentPubkey: string, channelId: string): string {
    return `${projectId}::${agentPubkey}::${channelId}`;
}

export class ChannelSessionStore {
    private static instance: ChannelSessionStore;
    private readonly sessions = new Map<string, ChannelSession>();
    private loaded = false;

    constructor(
        private readonly storagePath: string = join(
            config.getConfigPath("data"),
            "channel-sessions.json"
        )
    ) {}

    static getInstance(): ChannelSessionStore {
        if (!ChannelSessionStore.instance) {
            ChannelSessionStore.instance = new ChannelSessionStore();
        }
        return ChannelSessionStore.instance;
    }

    static resetInstance(): void {
        ChannelSessionStore.instance = undefined as unknown as ChannelSessionStore;
    }

    getSession(projectId: string, agentPubkey: string, channelId: string): ChannelSession | undefined {
        this.ensureLoaded();
        return this.sessions.get(makeKey(projectId, agentPubkey, channelId));
    }

    findSessionByAgentChannel(agentPubkey: string, channelId: string): ChannelSession | undefined {
        this.ensureLoaded();

        for (const session of this.sessions.values()) {
            if (session.agentPubkey === agentPubkey && session.channelId === channelId) {
                return session;
            }
        }

        return undefined;
    }

    rememberSession(session: Omit<ChannelSession, "updatedAt">): ChannelSession {
        this.ensureLoaded();
        const next: ChannelSession = {
            ...session,
            updatedAt: Date.now(),
        };
        this.sessions.set(makeKey(session.projectId, session.agentPubkey, session.channelId), next);
        this.persist();
        return next;
    }

    clearSession(projectId: string, agentPubkey: string, channelId: string): boolean {
        this.ensureLoaded();
        const deleted = this.sessions.delete(makeKey(projectId, agentPubkey, channelId));
        if (deleted) {
            this.persist();
        }
        return deleted;
    }

    clearSessionsByAgentChannel(agentPubkey: string, channelId: string): number {
        this.ensureLoaded();

        let deletedCount = 0;
        for (const [key, session] of this.sessions.entries()) {
            if (session.agentPubkey !== agentPubkey || session.channelId !== channelId) {
                continue;
            }

            this.sessions.delete(key);
            deletedCount += 1;
        }

        if (deletedCount > 0) {
            this.persist();
        }

        return deletedCount;
    }

    clear(): void {
        this.sessions.clear();
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
            const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as ChannelSession[];
            for (const session of parsed) {
                if (session.projectId && session.agentPubkey && session.channelId) {
                    this.sessions.set(
                        makeKey(session.projectId, session.agentPubkey, session.channelId),
                        session
                    );
                }
            }
        } catch (error) {
            logger.warn("[ChannelSessionStore] Failed to load channel sessions", {
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
                `${JSON.stringify(Array.from(this.sessions.values()), null, 2)}\n`
            );
        } catch (error) {
            logger.error("[ChannelSessionStore] Failed to persist channel sessions", {
                storagePath: this.storagePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

export const getChannelSessionStore = (): ChannelSessionStore =>
    ChannelSessionStore.getInstance();
