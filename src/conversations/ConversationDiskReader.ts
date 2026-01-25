/**
 * Utilities for reading conversation data from disk without full store loading.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { logger } from "@/utils/logger";
import type { ConversationEntry } from "./types";

/**
 * Read lightweight metadata without loading full conversation store.
 */
export function readLightweightMetadata(
    basePath: string,
    projectId: string,
    conversationId: string
): {
    id: string;
    lastActivity: number;
    title?: string;
    summary?: string;
    lastUserMessage?: string;
} | null {
    const filePath = join(basePath, projectId, "conversations", `${conversationId}.json`);

    try {
        if (!existsSync(filePath)) return null;
        const content = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(content);

        const messages = parsed.messages ?? [];
        const lastMessage = messages[messages.length - 1];
        const lastActivity = lastMessage?.timestamp || 0;

        return {
            id: conversationId,
            lastActivity,
            title: parsed.metadata?.title,
            summary: parsed.metadata?.summary,
            lastUserMessage: parsed.metadata?.last_user_message,
        };
    } catch {
        return null;
    }
}

/**
 * Read messages from disk without caching.
 */
export function readMessagesFromDisk(
    basePath: string,
    projectId: string,
    conversationId: string
): ConversationEntry[] | null {
    const filePath = join(basePath, projectId, "conversations", `${conversationId}.json`);

    try {
        if (!existsSync(filePath)) return null;
        const content = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(content);
        return parsed.messages ?? [];
    } catch {
        return null;
    }
}

/**
 * Read conversation preview for a specific project.
 */
export function readConversationPreviewForProject(
    basePath: string,
    conversationId: string,
    agentPubkey: string,
    projectId: string
): {
    id: string;
    lastActivity: number;
    title?: string;
    summary?: string;
    agentParticipated: boolean;
} | null {
    if (!projectId || projectId.includes("/") || projectId.includes("\\") || projectId.includes("..")) {
        logger.warn(`[ConversationDiskReader] Invalid projectId rejected: "${projectId}"`);
        return null;
    }

    const filePath = join(basePath, projectId, "conversations", `${conversationId}.json`);

    try {
        if (!existsSync(filePath)) return null;
        const content = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(content);

        const messages: ConversationEntry[] = parsed.messages ?? [];
        const lastMessage = messages[messages.length - 1];
        const lastActivity = lastMessage?.timestamp || 0;
        const agentParticipated = messages.some(msg => msg.pubkey === agentPubkey);

        return {
            id: conversationId,
            lastActivity,
            title: parsed.metadata?.title,
            summary: parsed.metadata?.summary,
            agentParticipated,
        };
    } catch {
        return null;
    }
}

/**
 * List project IDs from disk.
 */
export function listProjectIdsFromDisk(basePath: string): string[] {
    try {
        if (!existsSync(basePath)) return [];
        const entries = readdirSync(basePath);
        return entries.filter(entry => {
            const entryPath = join(basePath, entry);
            try {
                return statSync(entryPath).isDirectory();
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

/**
 * List conversation IDs for a specific project from disk.
 */
export function listConversationIdsFromDiskForProject(
    basePath: string,
    projectId: string
): string[] {
    const conversationsDir = join(basePath, projectId, "conversations");
    try {
        if (!existsSync(conversationsDir)) return [];
        const files = readdirSync(conversationsDir);
        return files
            .filter(file => file.endsWith(".json"))
            .map(file => file.replace(".json", ""));
    } catch {
        return [];
    }
}
