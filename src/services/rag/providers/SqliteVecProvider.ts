import { logger } from "@/utils/logger";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import * as fs from "node:fs";
import type { StoredDocument, VectorSearchResult, VectorStore, VectorStoreConfig } from "./types";

/**
 * Bun's built-in SQLite database handle.
 * Typed as `any` because bun:sqlite types are only available at runtime
 * and the project's tsconfig does not include bun type definitions.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunDatabase = any;

/**
 * Create a bun:sqlite Database instance at runtime.
 * Uses dynamic require to avoid compile-time type resolution.
 */
function createBunDatabase(dbPath: string): BunDatabase {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(dbPath);
}

/**
 * Lazy-loaded sqlite-vec extension path.
 * Optional dependency only needed when this provider is selected.
 */
let sqliteVecPath: string;

async function loadSqliteVecExtension(): Promise<string> {
    if (!sqliteVecPath) {
        const sqliteVec = await import("sqlite-vec");
        sqliteVecPath = sqliteVec.getLoadablePath();
    }
    return sqliteVecPath;
}

function getSqliteVecDataDir(customPath?: string): string {
    return (
        customPath ||
        process.env.SQLITE_VEC_DATA_DIR ||
        path.join(config.getConfigPath("data"), "sqlite-vec")
    );
}

function qualifyMetadataFilter(filter: string, alias: string): string {
    return filter.replace(/\bmetadata\b/g, `${alias}.metadata`);
}

/**
 * Metadata registry file tracking collection dimensions,
 * since vec0 virtual tables don't expose schema introspection.
 */
interface CollectionRegistry {
    collections: Record<string, { dimensions: number; createdAt: number }>;
}

/**
 * SQLite-vec implementation of the VectorStore interface.
 *
 * Uses Bun's built-in SQLite with the sqlite-vec extension for vector similarity search.
 * Each collection maps to a vec0 virtual table plus a documents table for non-vector data.
 *
 * Storage layout:
 *   - <dataDir>/rag.db - Single SQLite database for all collections
 *   - vec0 virtual table per collection for vector indexing
 *   - Regular table per collection for document content/metadata
 */
export class SqliteVecProvider implements VectorStore {
    private db: BunDatabase | null = null;
    private readonly dataDir: string;
    private readonly dbPath: string;
    private registry: CollectionRegistry = { collections: {} };
    private readonly registryPath: string;

    constructor(storeConfig?: VectorStoreConfig) {
        this.dataDir = getSqliteVecDataDir(storeConfig?.path);
        this.dbPath = path.join(this.dataDir, "rag.db");
        this.registryPath = path.join(this.dataDir, "collections.json");
    }

    async initialize(): Promise<void> {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }

        this.db = createBunDatabase(this.dbPath);
        this.db.exec("PRAGMA journal_mode = WAL");

        // Load sqlite-vec extension
        const extPath = await loadSqliteVecExtension();
        this.db.loadExtension(extPath);

        this.loadRegistry();

        logger.info(`SqliteVecProvider initialized at ${this.dbPath}`);
    }

    async close(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        logger.debug("SqliteVecProvider closed");
    }

    // -- Collection management --

    async createCollection(name: string, dimensions: number): Promise<void> {
        const db = this.ensureDb();

        // Create vec0 virtual table for vector search
        db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS "vec_${name}" USING vec0(
                id TEXT PRIMARY KEY,
                embedding float[${dimensions}]
            )
        `);

        // Create regular table for document data
        db.exec(`
            CREATE TABLE IF NOT EXISTS "docs_${name}" (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}',
                timestamp INTEGER NOT NULL,
                source TEXT NOT NULL
            )
        `);

        this.registry.collections[name] = { dimensions, createdAt: Date.now() };
        this.saveRegistry();

        logger.info(`SqliteVec collection '${name}' created (${dimensions} dimensions)`);
    }

    async deleteCollection(name: string): Promise<void> {
        const db = this.ensureDb();
        db.exec(`DROP TABLE IF EXISTS "vec_${name}"`);
        db.exec(`DROP TABLE IF EXISTS "docs_${name}"`);

        delete this.registry.collections[name];
        this.saveRegistry();

        logger.info(`SqliteVec collection '${name}' dropped`);
    }

    async listCollections(): Promise<string[]> {
        return Object.keys(this.registry.collections);
    }

    async collectionExists(name: string): Promise<boolean> {
        return name in this.registry.collections;
    }

    // -- Document operations --

    async addDocuments(collection: string, documents: StoredDocument[]): Promise<void> {
        const db = this.ensureDb();

        const insertVec = db.prepare(
            `INSERT INTO "vec_${collection}" (id, embedding) VALUES (?, ?)`
        );
        const insertDoc = db.prepare(
            `INSERT INTO "docs_${collection}" (id, content, metadata, timestamp, source) VALUES (?, ?, ?, ?, ?)`
        );

        const transaction = db.transaction(() => {
            for (const doc of documents) {
                const vectorBlob = float32ArrayToBlob(doc.vector);
                insertVec.run(doc.id, vectorBlob);
                insertDoc.run(doc.id, doc.content, doc.metadata, doc.timestamp, doc.source);
            }
        });

        transaction();
        logger.debug(`Added ${documents.length} documents to SqliteVec collection '${collection}'`);
    }

    async upsertDocuments(
        collection: string,
        documents: StoredDocument[]
    ): Promise<{ upsertedCount: number; failedIndices: number[] }> {
        if (documents.length === 0) {
            return { upsertedCount: 0, failedIndices: [] };
        }

        const db = this.ensureDb();
        const failedIndices: number[] = [];
        let upsertedCount = 0;

        const deleteVec = db.prepare(`DELETE FROM "vec_${collection}" WHERE id = ?`);
        const insertVec = db.prepare(
            `INSERT INTO "vec_${collection}" (id, embedding) VALUES (?, ?)`
        );
        const upsertDoc = db.prepare(
            `INSERT OR REPLACE INTO "docs_${collection}" (id, content, metadata, timestamp, source) VALUES (?, ?, ?, ?, ?)`
        );

        const transaction = db.transaction((startIdx: number, batch: StoredDocument[]) => {
            for (let i = 0; i < batch.length; i++) {
                try {
                    const doc = batch[i];
                    const vectorBlob = float32ArrayToBlob(doc.vector);
                    // vec0 doesn't support UPSERT, so delete then insert
                    deleteVec.run(doc.id);
                    insertVec.run(doc.id, vectorBlob);
                    upsertDoc.run(doc.id, doc.content, doc.metadata, doc.timestamp, doc.source);
                    upsertedCount++;
                } catch (error) {
                    failedIndices.push(startIdx + i);
                    logger.error(`SqliteVec upsert failed for document at index ${startIdx + i}`, {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        });

        const BATCH_SIZE = 100;
        for (let i = 0; i < documents.length; i += BATCH_SIZE) {
            const batch = documents.slice(i, Math.min(i + BATCH_SIZE, documents.length));
            try {
                transaction(i, batch);
            } catch (error) {
                logger.error(`SqliteVec upsert batch failed (indices ${i}..${i + batch.length - 1})`, {
                    error: error instanceof Error ? error.message : String(error),
                });
                for (let idx = i; idx < i + batch.length; idx++) {
                    if (!failedIndices.includes(idx)) {
                        failedIndices.push(idx);
                    }
                }
            }
        }

        return { upsertedCount, failedIndices };
    }

    async deleteDocument(collection: string, documentId: string): Promise<void> {
        const db = this.ensureDb();
        db.prepare(`DELETE FROM "vec_${collection}" WHERE id = ?`).run(documentId);
        db.prepare(`DELETE FROM "docs_${collection}" WHERE id = ?`).run(documentId);
        logger.debug(`Deleted document '${documentId}' from SqliteVec collection '${collection}'`);
    }

    async getAllDocuments(
        collection: string,
        limit: number,
        offset: number
    ): Promise<StoredDocument[]> {
        const db = this.ensureDb();

        const rows = db.prepare(
            `SELECT d.id, d.content, d.metadata, d.timestamp, d.source
             FROM "docs_${collection}" d
             ORDER BY d.id
             LIMIT ? OFFSET ?`
        ).all(limit, offset) as Array<{
            id: string;
            content: string;
            metadata: string;
            timestamp: number;
            source: string;
        }>;

        // Read vectors for those document IDs
        const result: StoredDocument[] = [];
        const getVec = db.prepare(
            `SELECT embedding FROM "vec_${collection}" WHERE id = ?`
        );

        for (const row of rows) {
            const vecRow = getVec.get(row.id) as { embedding: Buffer } | undefined;
            const vector = vecRow ? blobToFloat32Array(vecRow.embedding) : [];
            result.push({
                id: row.id,
                content: row.content,
                vector,
                metadata: row.metadata,
                timestamp: row.timestamp,
                source: row.source,
            });
        }

        return result;
    }

    // -- Search --

    async search(
        collection: string,
        vector: number[],
        topK: number,
        filter?: string
    ): Promise<VectorSearchResult[]> {
        const db = this.ensureDb();
        const vectorBlob = float32ArrayToBlob(vector);

        let query = `SELECT d.id, d.content, d.metadata, d.timestamp, d.source, v.distance
                     FROM "vec_${collection}" v
                     JOIN "docs_${collection}" d ON d.id = v.id
                     WHERE v.embedding MATCH ?
                     AND k = ?`;
        if (filter) {
            query += ` AND ${qualifyMetadataFilter(filter, "d")}`;
        }
        query += " ORDER BY v.distance";

        const rows = db.prepare(query).all(vectorBlob, topK) as Array<{
            id: string;
            content: string;
            metadata: string;
            timestamp: number;
            source: string;
            distance: number;
        }>;

        return rows.map((row) => ({
            document: {
                id: row.id,
                content: row.content,
                vector: [],
                metadata: row.metadata,
                timestamp: row.timestamp,
                source: row.source,
            },
            score: 1 / (1 + row.distance),
        }));
    }

    // -- Stats --

    async countDocuments(collection: string, filter?: string): Promise<number> {
        const db = this.ensureDb();

        let query = `SELECT COUNT(*) as count FROM "docs_${collection}"`;
        if (filter) {
            query += ` WHERE ${filter}`;
        }

        const result = db.prepare(query).get() as { count: number };
        return result.count;
    }

    // -- Maintenance --

    async runMaintenance(): Promise<void> {
        const db = this.ensureDb();
        db.exec("PRAGMA optimize");
        logger.debug("SqliteVec maintenance: PRAGMA optimize completed");
    }

    // -- Internal helpers --

    private ensureDb(): BunDatabase {
        if (!this.db) {
            throw new Error("SqliteVecProvider not initialized. Call initialize() first.");
        }
        return this.db;
    }

    private loadRegistry(): void {
        try {
            if (fs.existsSync(this.registryPath)) {
                const raw = fs.readFileSync(this.registryPath, "utf-8");
                this.registry = JSON.parse(raw);
            }
        } catch (error) {
            logger.warn("Failed to load SqliteVec collection registry, starting fresh", {
                error: error instanceof Error ? error.message : String(error),
            });
            this.registry = { collections: {} };
        }
    }

    private saveRegistry(): void {
        try {
            fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2), "utf-8");
        } catch (error) {
            logger.error("Failed to save SqliteVec collection registry", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

function float32ArrayToBlob(vector: number[]): Buffer {
    const float32 = new Float32Array(vector);
    return Buffer.from(float32.buffer);
}

function blobToFloat32Array(blob: Buffer): number[] {
    const float32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(float32);
}
