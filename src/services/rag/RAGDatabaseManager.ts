import * as os from "node:os";
import { config } from "@/services/ConfigService";
import * as path from "node:path";
import { handleError } from "@/utils/error-handler";
import { logger } from "@/utils/logger";
import { type Connection, type Table, connect } from "@lancedb/lancedb";

/**
 * Custom error for database-related issues
 */
export class RAGDatabaseError extends Error {
    constructor(
        message: string,
        public readonly cause?: Error
    ) {
        super(message);
        this.name = "RAGDatabaseError";
    }
}

/**
 * Manages LanceDB connection lifecycle and table access
 * Single Responsibility: Database connection and table management only
 */
export class RAGDatabaseManager {
    private connection: Connection | null = null;
    private readonly dataDir: string;
    private tableCache: Map<string, Table> = new Map();

    constructor(dataDir?: string) {
        // Use provided directory or environment variable, fallback to global location
        this.dataDir =
            dataDir ||
            process.env.LANCEDB_DATA_DIR ||
            path.join(config.getConfigPath("data"), "lancedb");

        logger.debug(`RAGDatabaseManager initialized with data directory: ${this.dataDir}`);
    }

    /**
     * Ensure database connection is established
     */
    async ensureConnection(): Promise<Connection> {
        if (!this.connection) {
            try {
                this.connection = await connect(this.dataDir);
                logger.info(`LanceDB connection established at ${this.dataDir}`);
            } catch (error) {
                const message = `Failed to connect to LanceDB at ${this.dataDir}`;
                handleError(error, message, { logLevel: "error" });
                throw new RAGDatabaseError(message, error as Error);
            }
        }
        return this.connection;
    }

    /**
     * Get or open a table by name
     */
    async getTable(name: string): Promise<Table> {
        // Check cache first
        let table = this.tableCache.get(name);
        if (table) {
            return table;
        }

        const connection = await this.ensureConnection();

        try {
            // Check if table exists
            const tables = await connection.tableNames();
            if (!tables.includes(name)) {
                throw new RAGDatabaseError(`Collection '${name}' does not exist`);
            }

            // Open table and cache it
            table = await connection.openTable(name);
            this.tableCache.set(name, table);
            logger.debug(`Opened table: ${name}`);

            return table;
        } catch (error) {
            if (error instanceof RAGDatabaseError) {
                throw error;
            }
            const message = `Failed to open table: ${name}`;
            handleError(error, message, { logLevel: "error" });
            throw new RAGDatabaseError(message, error as Error);
        }
    }

    /**
     * Create a new table with schema
     */
    async createTable(
        name: string,
        initialData: Record<string, unknown>[],
        options?: { mode?: "create" | "overwrite" }
    ): Promise<Table> {
        const connection = await this.ensureConnection();

        try {
            const table = await connection.createTable(name, initialData, options);

            // Cache the new table
            this.tableCache.set(name, table);
            logger.info(`Created table: ${name}`);

            return table;
        } catch (error) {
            const message = `Failed to create table: ${name}`;
            handleError(error, message, { logLevel: "error" });
            throw new RAGDatabaseError(message, error as Error);
        }
    }

    /**
     * Drop a table
     */
    async dropTable(name: string): Promise<void> {
        const connection = await this.ensureConnection();

        try {
            await connection.dropTable(name);

            // Remove from cache
            this.tableCache.delete(name);
            logger.info(`Dropped table: ${name}`);
        } catch (error) {
            const message = `Failed to drop table: ${name}`;
            handleError(error, message, { logLevel: "error" });
            throw new RAGDatabaseError(message, error as Error);
        }
    }

    /**
     * List all table names
     */
    async listTables(): Promise<string[]> {
        const connection = await this.ensureConnection();

        try {
            return await connection.tableNames();
        } catch (error) {
            const message = "Failed to list tables";
            handleError(error, message, { logLevel: "error" });
            throw new RAGDatabaseError(message, error as Error);
        }
    }

    /**
     * Check if a table exists
     */
    async tableExists(name: string): Promise<boolean> {
        const tables = await this.listTables();
        return tables.includes(name);
    }

    /**
     * Close connection and clear cache
     */
    async close(): Promise<void> {
        this.tableCache.clear();
        this.connection = null;
        logger.debug("RAGDatabaseManager closed");
    }

    /**
     * Get the data directory path
     */
    getDataDirectory(): string {
        return this.dataDir;
    }
}
