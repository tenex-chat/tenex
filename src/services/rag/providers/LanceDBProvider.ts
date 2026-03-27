import { handleError } from "@/utils/error-handler";
import { logger } from "@/utils/logger";
import { config } from "@/services/ConfigService";
import { type Connection, type Table, type VectorQuery, connect } from "@lancedb/lancedb";
import * as path from "node:path";
import type { StoredDocument, VectorSearchResult, VectorStore, VectorStoreConfig } from "./types";

/**
 * Resolve the LanceDB data directory path.
 */
function getLanceDBDataDir(customPath?: string): string {
    return (
        customPath ||
        process.env.LANCEDB_DATA_DIR ||
        path.join(config.getConfigPath("data"), "lancedb")
    );
}

/**
 * Convert L2 (Euclidean) distance to normalized similarity score (0-1).
 *
 * distance = 0   -> 1.0
 * distance = 1   -> 0.5
 * distance = 1.5 -> 0.4
 * distance = 2   -> 0.33
 */
function l2DistanceToScore(distance: number | undefined): number {
    if (distance === undefined || distance === null) return 0;
    if (!Number.isFinite(distance)) return 0;
    if (distance < 0) return 0;
    return 1 / (1 + distance);
}

interface LanceDBResult {
    id: string | undefined;
    content: string | undefined;
    metadata?: string | Record<string, unknown>;
    timestamp: number | undefined;
    source: string | undefined;
    vector?: number[];
    _distance?: number;
}

/**
 * LanceDB implementation of the VectorStore interface.
 *
 * Manages connection lifecycle, table operations, vector search,
 * and periodic maintenance (compaction/pruning).
 */
export class LanceDBProvider implements VectorStore {
    private connection: Connection | null = null;
    private readonly dataDir: string;
    private tableCache: Map<string, Table> = new Map();

    constructor(storeConfig?: VectorStoreConfig) {
        this.dataDir = getLanceDBDataDir(storeConfig?.path);
    }

    async initialize(): Promise<void> {
        await this.ensureConnection();
    }

    async close(): Promise<void> {
        this.tableCache.clear();
        this.connection = null;
        logger.debug("LanceDBProvider closed");
    }

    // -- Collection management --

    async createCollection(name: string, dimensions: number): Promise<void> {
        const connection = await this.ensureConnection();

        const tables = await connection.tableNames();
        if (tables.includes(name)) {
            throw new Error(`Collection '${name}' already exists`);
        }

        const initialRow = {
            id: "initial",
            content: "",
            vector: Array(dimensions).fill(0),
            metadata: "{}",
            timestamp: Date.now(),
            source: "system",
        };

        const table = await connection.createTable(name, [initialRow], { mode: "overwrite" });
        this.tableCache.set(name, table);

        // Delete the seed row
        await table.delete("id = 'initial'");
        logger.info(`LanceDB collection '${name}' created (${dimensions} dimensions)`);
    }

    async deleteCollection(name: string): Promise<void> {
        const connection = await this.ensureConnection();
        await connection.dropTable(name);
        this.tableCache.delete(name);
        logger.info(`LanceDB collection '${name}' dropped`);
    }

    async listCollections(): Promise<string[]> {
        const connection = await this.ensureConnection();
        return connection.tableNames();
    }

    async collectionExists(name: string): Promise<boolean> {
        const tables = await this.listCollections();
        return tables.includes(name);
    }

    // -- Document operations --

    async addDocuments(collection: string, documents: StoredDocument[]): Promise<void> {
        const table = await this.getTable(collection);
        await table.add(documents as unknown as Record<string, unknown>[]);
        logger.debug(`Added ${documents.length} documents to LanceDB collection '${collection}'`);
    }

    async upsertDocuments(
        collection: string,
        documents: StoredDocument[]
    ): Promise<{ upsertedCount: number; failedIndices: number[] }> {
        if (documents.length === 0) {
            return { upsertedCount: 0, failedIndices: [] };
        }

        const table = await this.getTable(collection);
        let totalUpserted = 0;
        const failedIndices: number[] = [];
        const BATCH_SIZE = 100;

        for (let i = 0; i < documents.length; i += BATCH_SIZE) {
            const chunkEnd = Math.min(i + BATCH_SIZE, documents.length);
            const batch = documents.slice(i, chunkEnd);

            try {
                const result = await table
                    .mergeInsert("id")
                    .whenMatchedUpdateAll()
                    .whenNotMatchedInsertAll()
                    .execute(batch as unknown as Record<string, unknown>[]);

                totalUpserted += result.numInsertedRows + result.numUpdatedRows;

                logger.debug(
                    `LanceDB upsert batch: ${batch.length} docs -> ${result.numInsertedRows} inserted, ${result.numUpdatedRows} updated in '${collection}'`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`LanceDB upsert chunk failed (indices ${i}..${chunkEnd - 1})`, {
                    collection,
                    chunkSize: batch.length,
                    error: message,
                });
                for (let idx = i; idx < chunkEnd; idx++) {
                    failedIndices.push(idx);
                }
            }
        }

        return { upsertedCount: totalUpserted, failedIndices };
    }

    async deleteDocument(collection: string, documentId: string): Promise<void> {
        const table = await this.getTable(collection);
        const escapedId = documentId.replace(/'/g, "''");
        await table.delete(`id = '${escapedId}'`);
        logger.debug(`Deleted document '${documentId}' from LanceDB collection '${collection}'`);
    }

    async getAllDocuments(
        collection: string,
        limit: number,
        offset: number
    ): Promise<StoredDocument[]> {
        const table = await this.getTable(collection);
        const results = await table
            .query()
            .limit(limit)
            .offset(offset)
            .toArray();

        return results.map((row) => ({
            id: row.id as string,
            content: row.content as string,
            vector: Array.from(row.vector as number[]),
            metadata: row.metadata as string,
            timestamp: row.timestamp as number,
            source: row.source as string,
        }));
    }

    // -- Search --

    async search(
        collection: string,
        vector: number[],
        topK: number,
        filter?: string
    ): Promise<VectorSearchResult[]> {
        const table = await this.getTable(collection);

        let query = table.search(vector).limit(topK) as VectorQuery;
        if (filter) {
            query = query.where(filter) as VectorQuery;
        }

        const results = await this.executeQuery(query);

        return results.map((result) => ({
            document: {
                id: result.id ?? "",
                content: result.content ?? "",
                vector: result.vector ?? [],
                metadata: typeof result.metadata === "string"
                    ? result.metadata
                    : JSON.stringify(result.metadata ?? {}),
                timestamp: result.timestamp ?? Date.now(),
                source: result.source ?? "",
            },
            score: l2DistanceToScore(result._distance),
        }));
    }

    // -- Stats --

    async countDocuments(collection: string, filter?: string): Promise<number> {
        const table = await this.getTable(collection);
        return table.countRows(filter);
    }

    // -- Maintenance --

    async runMaintenance(): Promise<void> {
        const tableNames = await this.listCollections();
        if (tableNames.length === 0) {
            logger.debug("No LanceDB tables to optimize");
            return;
        }

        logger.info("Starting LanceDB maintenance", { tableCount: tableNames.length });

        const cleanupOlderThan = new Date();
        cleanupOlderThan.setDate(cleanupOlderThan.getDate() - 1);

        let optimizedCount = 0;

        for (const tableName of tableNames) {
            try {
                const table = await this.getTable(tableName);
                const stats = await table.optimize({ cleanupOlderThan });
                optimizedCount++;
                logger.info(`Optimized LanceDB table '${tableName}'`, {
                    compaction: stats.compaction,
                    prune: stats.prune,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.error(`Failed to optimize LanceDB table '${tableName}'`, { error: message });
            }
        }

        logger.info("LanceDB maintenance complete", {
            tablesOptimized: optimizedCount,
            totalTables: tableNames.length,
        });
    }

    // -- Internal helpers --

    getDataDirectory(): string {
        return this.dataDir;
    }

    private async ensureConnection(): Promise<Connection> {
        if (!this.connection) {
            try {
                this.connection = await connect(this.dataDir);
                logger.info(`LanceDB connection established at ${this.dataDir}`);
            } catch (error) {
                handleError(error, `Failed to connect to LanceDB at ${this.dataDir}`, { logLevel: "error" });
                throw new Error(`Failed to connect to LanceDB at ${this.dataDir}`, { cause: error });
            }
        }
        return this.connection;
    }

    private async getTable(name: string): Promise<Table> {
        let table = this.tableCache.get(name);
        if (table) return table;

        const connection = await this.ensureConnection();
        const tables = await connection.tableNames();
        if (!tables.includes(name)) {
            throw new Error(`LanceDB collection '${name}' does not exist`);
        }

        table = await connection.openTable(name);
        this.tableCache.set(name, table);
        return table;
    }

    private async executeQuery(searchQuery: VectorQuery): Promise<LanceDBResult[]> {
        // Try toArray() first (most common path)
        if (typeof searchQuery.toArray === "function") {
            const results = await searchQuery.toArray();
            logger.debug(`LanceDB query returned ${results.length} results via toArray()`);
            return results;
        }

        // Fallback: execute()
        const queryWithExecute = searchQuery as VectorQuery & { execute?: () => Promise<unknown> };
        if (typeof queryWithExecute.execute === "function") {
            const queryResults = await queryWithExecute.execute();
            if (Array.isArray(queryResults)) return queryResults;

            if (queryResults) {
                const results: LanceDBResult[] = [];
                for await (const item of queryResults as AsyncIterable<unknown>) {
                    results.push(item as LanceDBResult);
                }
                return results;
            }
        }

        // Fallback: direct iteration
        const results: LanceDBResult[] = [];
        for await (const item of searchQuery) {
            results.push(item as unknown as LanceDBResult);
        }
        return results;
    }
}
