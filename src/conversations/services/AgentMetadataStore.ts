import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@/utils/logger";

/**
 * Simple KV store for agent-specific metadata within a conversation.
 * Each agent in each conversation gets its own isolated metadata store.
 */
export class AgentMetadataStore {
    private data = new Map<string, unknown>();
    private filePath: string;

    constructor(
        private conversationId: string,
        private agentSlug: string,
        metadataPath: string
    ) {
        // metadataPath is ~/.tenex/projects/<dTag>/
        const metadataDir = path.join(metadataPath, "metadata");
        this.filePath = path.join(metadataDir, `${conversationId}-${agentSlug}.json`);
        this.load();
    }

    get<T = unknown>(key: string): T | undefined {
        return this.data.get(key);
    }

    set(key: string, value: unknown): void {
        this.data.set(key, value);
        this.save();
    }

    private load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const content = fs.readFileSync(this.filePath, "utf-8");
                const parsed = JSON.parse(content);
                this.data = new Map(Object.entries(parsed));
                logger.debug("[AgentMetadataStore] Loaded metadata", {
                    conversationId: this.conversationId.substring(0, 8),
                    agentSlug: this.agentSlug,
                    keys: Array.from(this.data.keys()),
                });
            }
        } catch (error) {
            logger.error("[AgentMetadataStore] Failed to load metadata", {
                conversationId: this.conversationId.substring(0, 8),
                agentSlug: this.agentSlug,
                error,
            });
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const obj = Object.fromEntries(this.data);
            fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
            logger.debug("[AgentMetadataStore] Saved metadata", {
                conversationId: this.conversationId.substring(0, 8),
                agentSlug: this.agentSlug,
                keys: Array.from(this.data.keys()),
            });
        } catch (error) {
            logger.error("[AgentMetadataStore] Failed to save metadata", {
                conversationId: this.conversationId.substring(0, 8),
                agentSlug: this.agentSlug,
                error,
            });
        }
    }
}
