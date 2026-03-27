export type {
    StoredDocument,
    VectorSearchResult,
    VectorStore,
    VectorStoreConfig,
} from "./types";
export { DEFAULT_VECTOR_STORE_CONFIG } from "./types";
export { LanceDBProvider } from "./LanceDBProvider";
export { SqliteVecProvider } from "./SqliteVecProvider";
export { QdrantProvider } from "./QdrantProvider";

import { logger } from "@/utils/logger";
import { LanceDBProvider } from "./LanceDBProvider";
import { QdrantProvider } from "./QdrantProvider";
import { SqliteVecProvider } from "./SqliteVecProvider";
import type { VectorStore, VectorStoreConfig } from "./types";
import { DEFAULT_VECTOR_STORE_CONFIG } from "./types";

/**
 * Create a VectorStore instance based on configuration.
 * Defaults to LanceDB if no config is provided.
 */
export function createVectorStore(storeConfig?: VectorStoreConfig): VectorStore {
    const resolvedConfig = storeConfig ?? DEFAULT_VECTOR_STORE_CONFIG;

    logger.debug(`Creating vector store: ${resolvedConfig.provider}`);

    switch (resolvedConfig.provider) {
        case "lancedb":
            return new LanceDBProvider(resolvedConfig);
        case "sqlite-vec":
            return new SqliteVecProvider(resolvedConfig);
        case "qdrant":
            return new QdrantProvider(resolvedConfig);
    }
}
