import { existsSync } from "node:fs";
import path from "node:path";
import type { Event, SimplePool } from "nostr-tools";

type BunDatabase = any;

export type ConversationStoreMessage = {
    conversationId: string;
    sequence: number;
    nostrEventId: string | null;
    authorPubkey: string;
    role: string | null;
    content: string;
    humanReadable: string | null;
    messageType: string;
};

export type ConversationTranscript = {
    conversationId: string;
    messages: ConversationStoreMessage[];
};

export type ConversationMonitor = {
    conversationId: string;
    events: Event[];
    close: () => void;
    waitFor: (
        predicate: (event: Event) => boolean,
        timeoutMs: number,
        label: string
    ) => Promise<Event>;
};

export function conversationDbPath(baseDir: string, projectDtag: string): string {
    return path.join(baseDir, "projects", projectDtag, "conversation.db");
}

export function monitorConversation(
    pool: SimplePool,
    relayUrl: string,
    conversationId: string,
    options: {
        since?: number;
        onEvent?: (event: Event) => void;
        delay: (ms: number) => Promise<void>;
    }
): ConversationMonitor {
    const events: Event[] = [];
    const filter = {
        kinds: [1],
        "#e": [conversationId],
        ...(options.since === undefined ? {} : { since: options.since }),
    };
    const sub = pool.subscribeMany([relayUrl], filter, {
        onevent: (event) => {
            events.push(event);
            options.onEvent?.(event);
        },
    });

    return {
        conversationId,
        events,
        close: () => sub.close(),
        waitFor: async (predicate, timeoutMs, label) => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const event = events.find(predicate);
                if (event) {
                    return event;
                }
                await options.delay(100);
            }
            throw new Error(
                `did not observe ${label} in conversation ${conversationId.slice(0, 8)} within ${timeoutMs}ms`
            );
        },
    };
}

export function readConversationTranscript(
    dbPath: string,
    conversationId: string
): ConversationTranscript {
    if (!existsSync(dbPath)) {
        return { conversationId, messages: [] };
    }

    const db = createBunDatabase(dbPath);
    try {
        const rows = db
            .query(
                `SELECT conversation_id AS conversationId,
                        sequence,
                        nostr_event_id AS nostrEventId,
                        author_pubkey AS authorPubkey,
                        role,
                        content,
                        human_readable AS humanReadable,
                        message_type AS messageType
                   FROM messages
                  WHERE conversation_id = ?1
                  ORDER BY sequence ASC`
            )
            .all(conversationId) as ConversationStoreMessage[];
        return { conversationId, messages: rows };
    } finally {
        db.close();
    }
}

export function readAllConversationTranscripts(dbPath: string): ConversationTranscript[] {
    if (!existsSync(dbPath)) {
        return [];
    }

    const db = createBunDatabase(dbPath);
    try {
        const rows = db
            .query(
                `SELECT conversation_id AS conversationId,
                        sequence,
                        nostr_event_id AS nostrEventId,
                        author_pubkey AS authorPubkey,
                        role,
                        content,
                        human_readable AS humanReadable,
                        message_type AS messageType
                   FROM messages
                  ORDER BY conversation_id ASC, sequence ASC`
            )
            .all() as ConversationStoreMessage[];
        const byConversation = new Map<string, ConversationStoreMessage[]>();
        for (const row of rows) {
            const messages = byConversation.get(row.conversationId) ?? [];
            messages.push(row);
            byConversation.set(row.conversationId, messages);
        }
        return Array.from(byConversation, ([conversationId, messages]) => ({
            conversationId,
            messages,
        }));
    } finally {
        db.close();
    }
}

export async function waitForStoredMessage(
    dbPath: string,
    conversationId: string,
    predicate: (message: ConversationStoreMessage) => boolean,
    timeoutMs: number,
    label: string,
    delay: (ms: number) => Promise<void>
): Promise<ConversationStoreMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const message = readConversationTranscript(dbPath, conversationId).messages.find(predicate);
        if (message) {
            return message;
        }
        await delay(100);
    }
    throw new Error(
        `did not observe ${label} in stored conversation ${conversationId.slice(0, 8)} within ${timeoutMs}ms`
    );
}

export function messageText(message: ConversationStoreMessage): string {
    return message.humanReadable ?? message.content;
}

function createBunDatabase(dbPath: string): BunDatabase {
    const { Database } = require("bun:sqlite");
    return new Database(dbPath, { readonly: true });
}
