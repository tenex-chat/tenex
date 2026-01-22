#!/usr/bin/env bun
/**
 * Migration script to populate the prefix KV store from existing conversation files.
 *
 * Scans all conversation JSON files in ~/.tenex/projects/<project>/conversations/
 * and extracts event IDs and pubkeys to index them for prefix lookups.
 *
 * Usage: bun run src/scripts/migrate-prefix-index.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTenexBasePath } from "@/constants";
import { prefixKVStore } from "@/services/storage";

interface ConversationEntry {
    pubkey: string;
    eventId?: string;
}

interface ConversationState {
    messages: ConversationEntry[];
}

async function migrateConversations(): Promise<void> {
    const projectsBase = join(getTenexBasePath(), "projects");

    console.log("🔍 Starting prefix KV store migration...");
    console.log(`📂 Scanning projects in: ${projectsBase}`);

    // Initialize the prefix store
    await prefixKVStore.initialize();

    let totalEventIds = 0;
    let totalPubkeys = 0;
    let totalConversations = 0;
    let projectsScanned = 0;
    const corruptFiles: string[] = [];

    try {
        // Get all project directories
        let projectDirs: string[];
        try {
            projectDirs = readdirSync(projectsBase).filter((dir) => {
                const fullPath = join(projectsBase, dir);
                return statSync(fullPath).isDirectory() && dir !== "metadata";
            });
        } catch (error) {
            // Throw instead of process.exit to ensure finally block runs
            throw new Error(`Failed to read projects directory: ${error}`);
        }

        console.log(`📁 Found ${projectDirs.length} projects`);

        for (const projectDir of projectDirs) {
            const conversationsDir = join(projectsBase, projectDir, "conversations");

            let files: string[];
            try {
                files = readdirSync(conversationsDir).filter((f) => f.endsWith(".json"));
            } catch {
                // No conversations directory for this project
                continue;
            }

            projectsScanned++;
            console.log(`\n📂 Processing project: ${projectDir} (${files.length} conversations)`);

            const idsToIndex: string[] = [];

            for (const file of files) {
                const conversationId = file.replace(".json", "");
                const filePath = join(conversationsDir, file);

                try {
                    const content = readFileSync(filePath, "utf-8");
                    let state: ConversationState;

                    try {
                        state = JSON.parse(content);
                    } catch {
                        // Track corrupt JSON files instead of silently ignoring
                        corruptFiles.push(filePath);
                        continue;
                    }

                    // Skip files without messages (might be metadata files or corrupted)
                    if (!state.messages || !Array.isArray(state.messages)) {
                        continue;
                    }

                    // Add conversation ID itself (it's an event ID)
                    idsToIndex.push(conversationId);
                    totalEventIds++;

                    // Extract event IDs and pubkeys from messages
                    const pubkeysSeen = new Set<string>();
                    for (const message of state.messages) {
                        if (message.eventId) {
                            idsToIndex.push(message.eventId);
                            totalEventIds++;
                        }
                        if (message.pubkey && !pubkeysSeen.has(message.pubkey)) {
                            idsToIndex.push(message.pubkey);
                            pubkeysSeen.add(message.pubkey);
                            totalPubkeys++;
                        }
                    }

                    totalConversations++;
                } catch {
                    // File read error - track it
                    corruptFiles.push(filePath);
                }
            }

            // Batch add all IDs for this project
            if (idsToIndex.length > 0) {
                await prefixKVStore.addBatch(idsToIndex);
                console.log(`  ✅ Indexed ${idsToIndex.length} IDs from ${files.length} files`);
            }
        }

        // Get final stats
        const stats = await prefixKVStore.getStats();

        const separator = "=".repeat(50);
        console.log("\n" + separator);
        console.log("✅ Migration complete!");
        console.log(separator);
        console.log("📊 Statistics:");
        console.log(`   Projects scanned: ${projectsScanned}`);
        console.log(`   Conversations processed: ${totalConversations}`);
        console.log(`   Event IDs found: ${totalEventIds}`);
        console.log(`   Pubkeys found: ${totalPubkeys}`);
        console.log(`   Total entries in store: ${stats.count}`);

        // Report corrupt files if any
        if (corruptFiles.length > 0) {
            console.log(`   ⚠️  Corrupt/unreadable files: ${corruptFiles.length}`);
            for (const file of corruptFiles) {
                console.log(`      - ${file}`);
            }
        }

        console.log(separator);
    } finally {
        // Always close the store, even on error
        await prefixKVStore.forceClose();
    }
}

// Run the migration
migrateConversations().catch((error) => {
    console.error("❌ Migration failed:", error);
    process.exit(1);
});
