/**
 * RAGCollectionRegistry - Tracks collection metadata for scope-aware search.
 *
 * Stores scope, project, and agent metadata for each RAG collection as a
 * JSON sidecar file alongside the LanceDB data directory. This enables
 * rag_search() to automatically include only relevant collections based on
 * the agent's context (global, project, personal).
 *
 * IMPORTANT: This is NOT access control. No requests are ever denied.
 * Scoping only determines default visibility when rag_search() runs
 * without an explicit `collections` parameter.
 */

import { logger } from "@/utils/logger";
import { getLanceDBDataDir } from "./rag-utils";
import * as fs from "node:fs";
import * as path from "node:path";

/** Scope types for RAG collections */
export type CollectionScope = "global" | "project" | "personal";

/** Metadata stored for each registered collection */
export interface CollectionMetadata {
    /** Scope determines default visibility in rag_search() */
    scope: CollectionScope;

    /** Project ID (NIP-33 address) that created the collection */
    projectId?: string;

    /** Agent pubkey that created the collection */
    agentPubkey?: string;

    /** When the collection was first registered */
    createdAt: number;
}

/** Shape of the sidecar JSON file */
interface RegistryData {
    /** Schema version for future migrations */
    version: 1;

    /** Map of collection name → metadata */
    collections: Record<string, CollectionMetadata>;
}

const REGISTRY_FILENAME = "collection-registry.json";

export class RAGCollectionRegistry {
    private static instance: RAGCollectionRegistry | null = null;
    private data: RegistryData;
    private readonly filePath: string;

    private constructor() {
        this.filePath = path.join(getLanceDBDataDir(), REGISTRY_FILENAME);
        this.data = this.load();
    }

    public static getInstance(): RAGCollectionRegistry {
        if (!RAGCollectionRegistry.instance) {
            RAGCollectionRegistry.instance = new RAGCollectionRegistry();
        }
        return RAGCollectionRegistry.instance;
    }

    /**
     * Register a collection with scope metadata.
     * Overwrites existing metadata for the same collection name.
     */
    public register(
        name: string,
        metadata: Omit<CollectionMetadata, "createdAt">
    ): void {
        const existing = this.data.collections[name];
        this.data.collections[name] = {
            ...metadata,
            createdAt: existing?.createdAt ?? Date.now(),
        };
        this.save();
        logger.debug(`[RAGCollectionRegistry] Registered collection '${name}'`, {
            scope: metadata.scope,
            projectId: metadata.projectId,
        });
    }

    /**
     * Get metadata for a specific collection.
     * Returns undefined for unregistered (legacy) collections.
     */
    public get(name: string): CollectionMetadata | undefined {
        return this.data.collections[name];
    }

    /**
     * Remove a collection from the registry.
     */
    public unregister(name: string): void {
        if (this.data.collections[name]) {
            delete this.data.collections[name];
            this.save();
            logger.debug(`[RAGCollectionRegistry] Unregistered collection '${name}'`);
        }
    }

    /**
     * Get all collections that match the given context.
     *
     * Matching rules:
     * - `global` collections: always included
     * - `project` collections: included when projectId matches
     * - `personal` collections: included when agentPubkey matches
     * - Unregistered (legacy) collections: treated as global
     *
     * @param allCollections - All known collection names (from RAGService.listCollections)
     * @param projectId - Current project ID
     * @param agentPubkey - Current agent's pubkey
     * @returns Collection names that match the context
     */
    public getMatchingCollections(
        allCollections: string[],
        projectId: string,
        agentPubkey?: string
    ): string[] {
        return allCollections.filter((name) => {
            const metadata = this.data.collections[name];

            // Unregistered (legacy) collections are treated as global
            if (!metadata) return true;

            switch (metadata.scope) {
                case "global":
                    return true;
                case "project":
                    return metadata.projectId === projectId;
                case "personal":
                    return metadata.agentPubkey === agentPubkey;
                default:
                    // Unknown scope — treat as global for safety
                    return true;
            }
        });
    }

    /**
     * Get all registered collection metadata.
     * Returns a deep copy to prevent callers from mutating internal state.
     */
    public getAll(): Record<string, CollectionMetadata> {
        return JSON.parse(JSON.stringify(this.data.collections));
    }

    /**
     * Load registry from the sidecar JSON file.
     * Returns empty registry if file doesn't exist or is corrupted.
     */
    private load(): RegistryData {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, "utf-8");
                const parsed = JSON.parse(raw) as RegistryData;
                if (parsed.version === 1 && parsed.collections) {
                    return parsed;
                }
                logger.warn("[RAGCollectionRegistry] Unknown registry version, starting fresh");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("[RAGCollectionRegistry] Failed to load registry, starting fresh", {
                error: message,
            });
        }
        return { version: 1, collections: {} };
    }

    /**
     * Persist registry to the sidecar JSON file.
     */
    private save(): void {
        try {
            // Ensure directory exists
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("[RAGCollectionRegistry] Failed to save registry", {
                error: message,
            });
        }
    }

    /**
     * Reset singleton (for testing).
     */
    public static resetInstance(): void {
        RAGCollectionRegistry.instance = null;
    }
}
