export type {
    StoredDocument,
    VectorSearchResult,
    VectorStore,
    VectorStoreConfig,
} from "./types";
export { DEFAULT_VECTOR_STORE_CONFIG } from "./types";

import { logger } from "@/utils/logger";
import type { VectorStore, VectorStoreConfig } from "./types";
import { DEFAULT_VECTOR_STORE_CONFIG } from "./types";

/**
 * Create a VectorStore instance based on configuration.
 * Uses dynamic imports to only load the configured provider.
 * Defaults to SQLite-vec if no config is provided.
 */
export async function createVectorStore(storeConfig?: VectorStoreConfig): Promise<VectorStore> {
    const resolvedConfig = storeConfig ?? DEFAULT_VECTOR_STORE_CONFIG;

    logger.debug(`Creating vector store: ${resolvedConfig.provider}`);

    switch (resolvedConfig.provider) {
        case "sqlite-vec": {
            const { SqliteVecProvider } = await import("./SqliteVecProvider");
            return new SqliteVecProvider(resolvedConfig);
        }
        case "qdrant": {
            const { QdrantProvider } = await import("./QdrantProvider");
            return new QdrantProvider(resolvedConfig);
        }
    }
}
