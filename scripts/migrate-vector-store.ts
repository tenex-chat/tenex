#!/usr/bin/env bun
/**
 * Migration script to transfer RAG data between vector store providers.
 *
 * Usage:
 *   bun run scripts/migrate-vector-store.ts --from lancedb --to sqlite-vec [options]
 *
 * Options:
 *   --from <provider>       Source provider: lancedb, sqlite-vec, qdrant
 *   --to <provider>         Target provider: lancedb, sqlite-vec, qdrant
 *   --from-path <path>      Source data directory (LanceDB, SQLite-vec)
 *   --to-path <path>        Target data directory (LanceDB, SQLite-vec)
 *   --from-url <url>        Source server URL (Qdrant)
 *   --to-url <url>          Target server URL (Qdrant)
 *   --from-api-key <key>    Source API key (Qdrant)
 *   --to-api-key <key>      Target API key (Qdrant)
 *   --batch-size <n>        Documents per batch (default: 100)
 *   --collections <names>   Comma-separated collection names to migrate (default: all)
 */

import { LanceDBProvider } from "../src/services/rag/providers/LanceDBProvider";
import { SqliteVecProvider } from "../src/services/rag/providers/SqliteVecProvider";
import { QdrantProvider } from "../src/services/rag/providers/QdrantProvider";
import type { VectorStore, VectorStoreConfig } from "../src/services/rag/providers/types";

function parseArgs(): {
    from: VectorStoreConfig;
    to: VectorStoreConfig;
    batchSize: number;
    collections?: string[];
} {
    const args = process.argv.slice(2);
    let fromProvider: string | undefined;
    let toProvider: string | undefined;
    let fromPath: string | undefined;
    let toPath: string | undefined;
    let fromUrl: string | undefined;
    let toUrl: string | undefined;
    let fromApiKey: string | undefined;
    let toApiKey: string | undefined;
    let batchSize = 100;
    let collections: string[] | undefined;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case "--from": fromProvider = args[++i]; break;
            case "--to": toProvider = args[++i]; break;
            case "--from-path": fromPath = args[++i]; break;
            case "--to-path": toPath = args[++i]; break;
            case "--from-url": fromUrl = args[++i]; break;
            case "--to-url": toUrl = args[++i]; break;
            case "--from-api-key": fromApiKey = args[++i]; break;
            case "--to-api-key": toApiKey = args[++i]; break;
            case "--batch-size": batchSize = parseInt(args[++i], 10); break;
            case "--collections": collections = args[++i].split(","); break;
            default:
                console.error(`Unknown argument: ${args[i]}`);
                process.exit(1);
        }
    }

    if (!fromProvider || !toProvider) {
        console.error("Usage: migrate-vector-store.ts --from <provider> --to <provider>");
        console.error("Providers: lancedb, sqlite-vec, qdrant");
        process.exit(1);
    }

    if (fromProvider === toProvider && fromPath === toPath && fromUrl === toUrl) {
        console.error("Source and target cannot be the same provider with the same path/URL");
        process.exit(1);
    }

    const validProviders = ["lancedb", "sqlite-vec", "qdrant"];
    if (!validProviders.includes(fromProvider) || !validProviders.includes(toProvider)) {
        console.error(`Invalid provider. Must be one of: ${validProviders.join(", ")}`);
        process.exit(1);
    }

    return {
        from: {
            provider: fromProvider as VectorStoreConfig["provider"],
            path: fromPath,
            url: fromUrl,
            apiKey: fromApiKey,
        },
        to: {
            provider: toProvider as VectorStoreConfig["provider"],
            path: toPath,
            url: toUrl,
            apiKey: toApiKey,
        },
        batchSize,
        collections,
    };
}

function createProvider(config: VectorStoreConfig): VectorStore {
    switch (config.provider) {
        case "lancedb": return new LanceDBProvider(config);
        case "sqlite-vec": return new SqliteVecProvider(config);
        case "qdrant": return new QdrantProvider(config);
    }
}

async function migrate(): Promise<void> {
    const { from: fromConfig, to: toConfig, batchSize, collections: requestedCollections } = parseArgs();

    console.log(`Migrating from ${fromConfig.provider} to ${toConfig.provider}`);
    console.log(`  Batch size: ${batchSize}`);

    const source = createProvider(fromConfig);
    const target = createProvider(toConfig);

    await source.initialize();
    await target.initialize();

    try {
        const allCollections = await source.listCollections();
        const collectionsToMigrate = requestedCollections
            ? allCollections.filter((c) => requestedCollections.includes(c))
            : allCollections;

        console.log(`\nFound ${allCollections.length} collections, migrating ${collectionsToMigrate.length}`);

        let totalDocsMigrated = 0;
        let totalFailures = 0;

        for (const collectionName of collectionsToMigrate) {
            console.log(`\n--- Migrating collection: ${collectionName} ---`);

            // Get first batch to determine vector dimensions
            const firstBatch = await source.getAllDocuments(collectionName, 1, 0);
            if (firstBatch.length === 0) {
                console.log(`  Empty collection, skipping`);
                continue;
            }

            const dimensions = firstBatch[0].vector.length;
            console.log(`  Vector dimensions: ${dimensions}`);

            // Create collection in target
            const exists = await target.collectionExists(collectionName);
            if (exists) {
                console.log(`  Collection already exists in target, adding documents`);
            } else {
                await target.createCollection(collectionName, dimensions);
                console.log(`  Created collection in target`);
            }

            // Migrate documents in batches
            let offset = 0;
            let collectionDocs = 0;

            while (true) {
                const documents = await source.getAllDocuments(collectionName, batchSize, offset);
                if (documents.length === 0) break;

                await target.addDocuments(collectionName, documents);
                collectionDocs += documents.length;
                offset += documents.length;

                process.stdout.write(`\r  Migrated ${collectionDocs} documents...`);

                if (documents.length < batchSize) break;
            }

            console.log(`\r  Migrated ${collectionDocs} documents total`);
            totalDocsMigrated += collectionDocs;
        }

        console.log(`\n=== Migration Complete ===`);
        console.log(`  Collections: ${collectionsToMigrate.length}`);
        console.log(`  Documents: ${totalDocsMigrated}`);
        console.log(`  Failures: ${totalFailures}`);

    } finally {
        await source.close();
        await target.close();
    }
}

migrate().catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
});
