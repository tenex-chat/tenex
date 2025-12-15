import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AgentIndex, ToolMessage } from "../types.js";

const TENEX_DIR = join(homedir(), ".tenex");
const AGENTS_DIR = join(TENEX_DIR, "agents");
const TOOL_MESSAGES_DIR = join(TENEX_DIR, "tool-messages");

export class TenexLogReader {
    private agentIndex: AgentIndex | null = null;
    private pubkeyToSlug: Map<string, string> = new Map();

    /**
     * Load agent index and build reverse mapping (pubkey -> slug)
     */
    loadAgentIndex(): AgentIndex | null {
        if (this.agentIndex) return this.agentIndex;

        try {
            // Find the most recent agents index file
            if (!existsSync(AGENTS_DIR)) return null;

            const files = readdirSync(AGENTS_DIR)
                .filter((f) => f.endsWith(".json"))
                .map((f) => ({
                    name: f,
                    path: join(AGENTS_DIR, f),
                }));

            // The main index is typically the file without a hash name
            // or we can look for one with bySlug
            for (const file of files) {
                try {
                    const content = readFileSync(file.path, "utf-8");
                    const data = JSON.parse(content);

                    if (data.bySlug) {
                        this.agentIndex = data as AgentIndex;

                        // Build reverse mapping
                        for (const [slug, pubkey] of Object.entries(data.bySlug)) {
                            this.pubkeyToSlug.set(pubkey as string, slug);
                        }

                        return this.agentIndex;
                    }
                } catch {
                    // Skip files that don't parse or don't have bySlug
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }

        return null;
    }

    /**
     * Get agent slug from pubkey
     */
    getAgentSlug(pubkey: string): string {
        if (!this.agentIndex) {
            this.loadAgentIndex();
        }

        return this.pubkeyToSlug.get(pubkey) || pubkey.substring(0, 8) + "...";
    }

    /**
     * Load a specific tool message by event ID
     */
    loadToolMessage(eventId: string): ToolMessage | null {
        try {
            // Tool messages are stored with their hash as filename
            // We need to search for the right file
            if (!existsSync(TOOL_MESSAGES_DIR)) return null;

            const files = readdirSync(TOOL_MESSAGES_DIR).filter((f) => f.endsWith(".json"));

            for (const file of files) {
                try {
                    const filePath = join(TOOL_MESSAGES_DIR, file);
                    const content = readFileSync(filePath, "utf-8");
                    const data = JSON.parse(content) as ToolMessage;

                    if (data.eventId === eventId) {
                        return data;
                    }
                } catch {
                    // Skip files that don't parse
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }

        return null;
    }

    /**
     * Load recent tool messages (for enriching stream view)
     */
    loadRecentToolMessages(limit = 100): ToolMessage[] {
        const messages: ToolMessage[] = [];

        try {
            if (!existsSync(TOOL_MESSAGES_DIR)) return messages;

            const files = readdirSync(TOOL_MESSAGES_DIR)
                .filter((f) => f.endsWith(".json"))
                .slice(0, limit * 2); // Read more to account for parsing failures

            for (const file of files) {
                if (messages.length >= limit) break;

                try {
                    const filePath = join(TOOL_MESSAGES_DIR, file);
                    const content = readFileSync(filePath, "utf-8");
                    const data = JSON.parse(content) as ToolMessage;

                    if (data.eventId && data.messages) {
                        messages.push(data);
                    }
                } catch {
                    // Skip files that don't parse
                }
            }

            // Sort by timestamp descending
            messages.sort((a, b) => b.timestamp - a.timestamp);
        } catch {
            // Directory doesn't exist or can't be read
        }

        return messages;
    }

    /**
     * Build a map of eventId -> ToolMessage for quick lookup
     */
    buildToolMessageIndex(messages: ToolMessage[]): Map<string, ToolMessage> {
        const index = new Map<string, ToolMessage>();
        for (const msg of messages) {
            index.set(msg.eventId, msg);
        }
        return index;
    }
}
