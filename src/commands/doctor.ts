import { Command } from "commander";
import chalk from "chalk";
import { agentStorage, type StoredAgent } from "@/agents/AgentStorage";
import { backfillAgentCategories } from "@/agents/backfillAgentCategories";
import { NDKAgentDefinition } from "@/events/NDKAgentDefinition";
import { initNDK, getNDK } from "@/nostr/ndkClient";
import { migrationService } from "@/services/migrations";
import { shortenEventId } from "@/utils/conversation-id";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { getConversationIndexingJob, getConversationEmbeddingService } from "@/conversations/search/embeddings";
import { RAGService } from "@/services/rag/RAGService";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { listProjectIdsFromDisk, listConversationIdsFromDiskForProject } from "@/conversations/ConversationDiskReader";
import { getTenexBasePath } from "@/constants";
import { createPublishOutboxCommand } from "@/commands/doctor/publish-outbox";
import { join } from "node:path";

const refetchCommand = new Command("refetch")
    .description("Refetch and update all agent definitions from Nostr")
    .action(repairAgents);

const orphansCommand = new Command("orphans")
    .description("List agents not assigned to any project")
    .option("--purge", "Delete orphaned agents")
    .action(async (options) => {
        await findOrphanedAgents(!!options.purge);
    });

const categorizeCommand = new Command("categorize")
    .description("Auto-categorize agents that lack an explicit or inferred category")
    .option("--dry-run", "Show what would be categorized without making changes")
    .action(async (options) => {
        try {
            const result = await backfillAgentCategories(agentStorage, { dryRun: !!options.dryRun });

            console.log(chalk.blue(`Processed: ${result.processed}, Categorized: ${result.categorized}, Skipped: ${result.skipped}, Failed: ${result.failed}`));

            if (result.failed > 0) {
                console.error(chalk.red(`${result.failed} agent(s) failed categorization — check logs for details`));
                process.exit(1);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(chalk.red(`Failed to categorize agents: ${message}`));
            process.exit(1);
        }
    });

const agentsCommand = new Command("agents")
    .description("Agent diagnostics and repair")
    .addCommand(refetchCommand)
    .addCommand(orphansCommand)
    .addCommand(categorizeCommand);

const migrateCommand = new Command("migrate")
    .description("Apply pending TENEX state migrations")
    .action(runMigrations);

const conversationStatusCommand = new Command("status")
    .description("Check conversation indexing status")
    .action(checkConversationIndexingStatus);

const conversationReindexCommand = new Command("reindex")
    .description("Force full re-index of all conversations")
    .option("--confirm", "Skip confirmation prompt")
    .action(async (options) => {
        await reindexConversations(!!options.confirm);
    });

const conversationsCommand = new Command("conversations")
    .description("Conversation indexing diagnostics and repair")
    .addCommand(conversationStatusCommand)
    .addCommand(conversationReindexCommand);

export const doctorCommand = new Command("doctor")
    .description("Diagnose and repair TENEX state")
    .addCommand(agentsCommand)
    .addCommand(migrateCommand)
    .addCommand(conversationsCommand)
    .addCommand(createPublishOutboxCommand());

function agentChanged(before: StoredAgent, after: StoredAgent): boolean {
    if (before.name !== after.name) return true;
    if (before.role !== after.role) return true;
    if (before.description !== after.description) return true;
    if (before.instructions !== after.instructions) return true;
    if (before.useCriteria !== after.useCriteria) return true;
    const oldTools = before.default?.tools?.slice().sort().join("\0") ?? "";
    const newTools = after.default?.tools?.slice().sort().join("\0") ?? "";
    return oldTools !== newTools;
}

async function repairAgents(): Promise<void> {
    await agentStorage.initialize();
    await initNDK();
    const ndk = getNDK();

    const agents = await agentStorage.getAllStoredAgents();
    const nostrAgents = agents.filter((a): a is typeof a & { eventId: string } => !!a.eventId);
    const skipped = agents.length - nostrAgents.length;

    console.log(chalk.blue(`Checking ${nostrAgents.length} Nostr agent(s)...`));

    let updated = 0;
    let failed = 0;

    for (const agent of nostrAgents) {
        const pubkey = new NDKPrivateKeySigner(agent.nsec).pubkey;
        const label = `${agent.slug} (${pubkey.substring(0, 8)}...)`;

        const event = await ndk.fetchEvent(agent.eventId, { groupable: false });
        if (!event) {
            console.log(chalk.yellow(`  ⚠ ${label}: event not found on relays, skipping`));
            failed++;
            continue;
        }

        const agentDef = NDKAgentDefinition.from(event);
        const toolTags = event.tags
            .filter((t) => t[0] === "tool" && t[1])
            .map((t) => t[1] as string);

        const newDefault = {
            ...agent.default,
            tools: toolTags.length > 0 ? toolTags : undefined,
        };
        const updatedAgent = {
            ...agent,
            name: agentDef.title || agent.name,
            role: agentDef.role || agent.role,
            description: agentDef.description ?? agent.description,
            instructions: agentDef.instructions ?? agent.instructions,
            useCriteria: agentDef.useCriteria ?? agent.useCriteria,
            default: Object.values(newDefault).some((v) => v !== undefined) ? newDefault : undefined,
        };

        const toolsDisplay = toolTags.length > 0 ? toolTags.join(", ") : "(none)";
        const suffix = chalk.gray(`  [tools: ${toolsDisplay}]`);

        if (agentChanged(agent, updatedAgent)) {
            await agentStorage.saveAgent(updatedAgent);
            console.log(chalk.green(`  ✓ ${label}: updated`) + suffix);
            updated++;
        } else {
            console.log(chalk.gray(`  ${label}: ok`) + suffix);
        }
    }

    console.log(
        chalk.blue(
            `\nDone: ${updated} updated, ${skipped} skipped (no eventId), ${failed} failed`
        )
    );
}

async function findOrphanedAgents(purge: boolean): Promise<void> {
    await agentStorage.initialize();
    const agents = await agentStorage.getAllStoredAgents();

    const orphans: Array<{ agent: StoredAgent; pubkey: string }> = [];
    for (const agent of agents) {
        const pubkey = new NDKPrivateKeySigner(agent.nsec).pubkey;
        const projects = await agentStorage.getAgentProjects(pubkey);
        if (projects.length === 0) {
            orphans.push({ agent, pubkey });
        }
    }

    if (orphans.length === 0) {
        console.log(chalk.green("No orphaned agents found."));
        return;
    }

    console.log(chalk.yellow(`Found ${orphans.length} orphaned agent(s):`));
    for (const { agent, pubkey } of orphans) {
        const source = agent.eventId ? `nostr:${shortenEventId(agent.eventId)}` : "local";
        console.log(chalk.gray(`  ${agent.slug} (${pubkey.substring(0, 8)}...)  [${source}]`));
    }

    if (!purge) return;

    console.log(chalk.blue(`\nPurging ${orphans.length} orphaned agent(s)...`));
    for (const { agent, pubkey } of orphans) {
        await agentStorage.deleteAgent(pubkey);
        console.log(chalk.green(`  ✓ deleted ${agent.slug}`));
    }
    console.log(chalk.blue(`Done: ${orphans.length} deleted`));
}

async function runMigrations(): Promise<void> {
    const summary = await migrationService.migrate();

    console.log(
        chalk.blue(
            `Current migration version: ${String(summary.currentVersion)} (latest: ${summary.latestVersion})`
        )
    );

    if (summary.applied.length === 0) {
        console.log(chalk.green("No pending migrations."));
        return;
    }

    for (const migration of summary.applied) {
        console.log(
            chalk.green(
                `Applied migration ${String(migration.from)} -> ${migration.to}: ${migration.description}`
            )
        );
        console.log(
            chalk.gray(
                `  migrated=${migration.result.migratedCount} skipped=${migration.result.skippedCount}`
            )
        );

        for (const warning of migration.result.warnings) {
            console.log(chalk.yellow(`  warning: ${warning}`));
        }
    }

    console.log(chalk.blue(`Final migration version: ${String(summary.finalVersion)}`));
}

async function getContentVersionBreakdown(): Promise<{
    total: number;
    v1: number;
    v2: number;
    unknown: number;
}> {
    const breakdown = { total: 0, v1: 0, v2: 0, unknown: 0 };
    const projectsBasePath = join(getTenexBasePath(), "projects");
    const projectIds = listProjectIdsFromDisk(projectsBasePath);

    for (const projectId of projectIds) {
        const catalog = ConversationCatalogService.getInstance(projectId, join(projectsBasePath, projectId));
        const conversationIds = listConversationIdsFromDiskForProject(projectsBasePath, projectId);

        for (const conversationId of conversationIds) {
            const state = catalog.getEmbeddingState(conversationId);
            if (state) {
                breakdown.total++;
                if (state.contentVersion === "v2") {
                    breakdown.v2++;
                } else if (state.contentVersion === "v1") {
                    breakdown.v1++;
                } else {
                    breakdown.unknown++;
                }
            }
        }
    }

    return breakdown;
}

async function checkConversationIndexingStatus(): Promise<void> {
    const conversationEmbeddingService = getConversationEmbeddingService();
    const indexingJob = getConversationIndexingJob();

    console.log(chalk.blue("Checking conversation indexing status...\n"));

    try {
        await conversationEmbeddingService.initialize();

        const hasIndexed = await conversationEmbeddingService.hasIndexedConversations();
        const ragService = RAGService.getInstance();
        const stats = await ragService.getCollectionStats("conversation_embeddings");
        const jobStatus = indexingJob.getStatus();
        const embeddingInfo = await conversationEmbeddingService.getEmbeddingInfo();

        console.log(chalk.bold("RAG Collection:"));
        console.log(chalk.gray(`  Collection: conversation_embeddings`));
        console.log(chalk.gray(`  Total indexed: ${stats.totalCount}`));
        console.log(chalk.gray(`  Has content: ${hasIndexed ? "yes" : "no"}`));
        console.log(chalk.gray(`  Embedding provider: ${embeddingInfo}`));

        console.log(chalk.bold("\nIndexing Job:"));
        console.log(chalk.gray(`  Running: ${jobStatus.isRunning ? "yes" : "no"}`));
        console.log(chalk.gray(`  Batch in progress: ${jobStatus.isBatchRunning ? "yes" : "no"}`));
        console.log(chalk.gray(`  Interval: ${jobStatus.intervalMs / 60000} minutes`));

        console.log(chalk.bold("\nIndexing State:"));
        console.log(chalk.gray(`  Tracked conversations: ${jobStatus.stateStats.totalEntries}`));

        const versionBreakdown = await getContentVersionBreakdown();
        if (versionBreakdown.total > 0) {
            console.log(chalk.bold("\nContent Versions:"));
            if (versionBreakdown.v2 > 0) {
                console.log(chalk.gray(`  v2 (full transcript): ${versionBreakdown.v2}`));
            }
            if (versionBreakdown.v1 > 0) {
                console.log(chalk.yellow(`  v1 (metadata only): ${versionBreakdown.v1}`));
            }
            if (versionBreakdown.unknown > 0) {
                console.log(chalk.gray(`  unknown/legacy: ${versionBreakdown.unknown}`));
            }
            if (versionBreakdown.v1 > 0) {
                console.log(chalk.yellow(`\n  ⚠ ${versionBreakdown.v1} conversation(s) using old format. Run 'reindex' to upgrade to v2.`));
            }
        }

        if (!hasIndexed) {
            console.log(chalk.yellow("\n⚠ No conversations indexed yet. Run 'tenex doctor conversations reindex' to backfill."));
        } else {
            console.log(chalk.green("\n✓ Conversation indexing is active"));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n✗ Error checking status: ${message}`));
        process.exit(1);
    }
}

async function reindexConversations(skipConfirm: boolean): Promise<void> {
    if (!skipConfirm) {
        console.log(chalk.yellow("This will clear all conversation indexing state and re-index all conversations."));
        console.log(chalk.yellow("This may take several minutes depending on the number of conversations.\n"));
        console.log(chalk.gray("Run with --confirm to skip this prompt.\n"));

        const readline = await import("node:readline");
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
            rl.question(chalk.blue("Continue? (yes/no): "), resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
            console.log(chalk.gray("Cancelled."));
            return;
        }
    }

    const indexingJob = getConversationIndexingJob();

    console.log(chalk.blue("\nStarting full conversation re-index...\n"));

    const startTime = Date.now();

    try {
        await indexingJob.forceFullReindex();

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(chalk.green(`\n✓ Re-index complete in ${duration}s`));
        console.log(chalk.gray("Run 'tenex doctor conversations status' to verify."));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n✗ Re-index failed: ${message}`));
        process.exit(1);
    }
}
