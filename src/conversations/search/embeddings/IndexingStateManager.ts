/**
 * IndexingStateManager - Durable per-conversation indexing state
 *
 * Backed by the per-project conversation catalog instead of a standalone JSON file.
 * The public API remains stable so the indexing job can keep its current workflow.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { listProjectIdsFromDisk } from "@/conversations/ConversationDiskReader";
import type { ProjectDTag } from "@/types/project-ids";
import { logger } from "@/utils/logger";

export class IndexingStateManager {
    private readonly baseDir: string;

    constructor(baseDir: string) {
        this.baseDir = baseDir;
    }

    private getCatalog(projectId: ProjectDTag): ConversationCatalogService {
        return ConversationCatalogService.getInstance(projectId, join(this.baseDir, projectId));
    }

    private calculateMetadataHash(
        basePath: string,
        projectId: ProjectDTag,
        conversationId: string
    ): { hash: string; lastActivity: number } | null {
        try {
            const catalog = this.getCatalog(projectId);
            let preview = catalog.getPreview(conversationId);
            if (!preview) {
                catalog.reconcile();
                preview = catalog.getPreview(conversationId);
            }
            if (!preview) {
                return null;
            }

            const hashInput = [
                preview.title || "",
                preview.summary || "",
                preview.lastUserMessage || "",
                String(preview.lastActivity || 0),
            ].join("|");

            return {
                hash: createHash("sha256").update(hashInput).digest("hex"),
                lastActivity: preview.lastActivity || 0,
            };
        } catch (error) {
            logger.debug(`Failed to calculate metadata hash for ${conversationId.substring(0, 8)}`, {
                error,
                basePath,
                projectId,
            });
            return null;
        }
    }

    public needsIndexing(
        basePath: string,
        projectId: ProjectDTag,
        conversationId: string
    ): boolean {
        const currentState = this.getCatalog(projectId).getEmbeddingState(conversationId);
        const result = this.calculateMetadataHash(basePath, projectId, conversationId);
        if (!result) {
            return false;
        }

        const { hash: currentHash } = result;

        if (!currentState) {
            return true;
        }

        if (currentState.metadataHash !== currentHash) {
            return true;
        }

        return false;
    }

    public markIndexed(
        basePath: string,
        projectId: ProjectDTag,
        conversationId: string,
        noContent = false
    ): void {
        const result = this.calculateMetadataHash(basePath, projectId, conversationId);
        if (!result) {
            logger.debug(`Cannot mark ${conversationId.substring(0, 8)} as indexed - no metadata`);
            return;
        }

        this.getCatalog(projectId).setEmbeddingState(conversationId, {
            metadataHash: result.hash,
            lastIndexedAt: Date.now(),
            noContent,
        });
    }

    public clearState(projectId: ProjectDTag, conversationId: string): void {
        this.getCatalog(projectId).clearEmbeddingState(conversationId);
    }

    public clearAllState(): void {
        for (const projectId of listProjectIdsFromDisk(this.baseDir)) {
            this.getCatalog(projectId).clearAllEmbeddingState();
        }
    }

    public getStats(): {
        totalEntries: number;
        maxEntries: number;
        isDirty: boolean;
    } {
        let totalEntries = 0;
        for (const projectId of listProjectIdsFromDisk(this.baseDir)) {
            totalEntries += this.getCatalog(projectId).getEmbeddingStateCount();
        }

        return {
            totalEntries,
            maxEntries: Number.MAX_SAFE_INTEGER,
            isDirty: false,
        };
    }

    public saveNow(): void {
        ConversationCatalogService.flushAll();
    }

    public dispose(): void {
        this.saveNow();
    }
}
