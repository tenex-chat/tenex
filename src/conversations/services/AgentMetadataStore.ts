import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@/utils/logger';

/**
 * Simple KV store for agent-specific metadata within a conversation.
 * Each agent in each conversation gets its own isolated metadata store.
 */
export class AgentMetadataStore {
  private data = new Map<string, any>();
  private filePath: string;

  constructor(
    private conversationId: string,
    private agentSlug: string,
    projectPath: string
  ) {
    this.filePath = path.join(projectPath, '.tenex', 'metadata', `${conversationId}-${agentSlug}.json`);
    this.load();
  }

  get<T = any>(key: string): T | undefined {
    return this.data.get(key);
  }

  set(key: string, value: any): void {
    this.data.set(key, value);
    this.save();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(content);
        this.data = new Map(Object.entries(parsed));
        logger.debug(`[AgentMetadataStore] Loaded metadata`, {
          conversationId: this.conversationId.substring(0, 8),
          agentSlug: this.agentSlug,
          keys: Array.from(this.data.keys())
        });
      }
    } catch (error) {
      logger.error(`[AgentMetadataStore] Failed to load metadata`, {
        conversationId: this.conversationId.substring(0, 8),
        agentSlug: this.agentSlug,
        error
      });
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const obj = Object.fromEntries(this.data);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
      logger.debug(`[AgentMetadataStore] Saved metadata`, {
        conversationId: this.conversationId.substring(0, 8),
        agentSlug: this.agentSlug,
        keys: Array.from(this.data.keys())
      });
    } catch (error) {
      logger.error(`[AgentMetadataStore] Failed to save metadata`, {
        conversationId: this.conversationId.substring(0, 8),
        agentSlug: this.agentSlug,
        error
      });
    }
  }
}