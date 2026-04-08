import { deriveAgentPubkeyFromNsec, type AgentStorage, type StoredAgent } from "@/agents/AgentStorage";
import { categorizeAgent, type AgentMetadata } from "@/agents/categorizeAgent";
import { logger } from "@/utils/logger";

export interface BackfillOptions {
    dryRun?: boolean;
}

export interface BackfillResult {
    processed: number;
    categorized: number;
    skipped: number;
    failed: number;
}

function toMetadata(agent: StoredAgent): AgentMetadata {
    return {
        name: agent.name,
        role: agent.role,
        description: agent.description,
        instructions: agent.instructions,
        useCriteria: agent.useCriteria,
    };
}

export async function backfillAgentCategories(
    storage: Pick<AgentStorage, "initialize" | "getCanonicalActiveAgents" | "updateInferredCategory">,
    options: BackfillOptions = {}
): Promise<BackfillResult> {
    await storage.initialize();

    const allAgents = await storage.getCanonicalActiveAgents();
    const uncategorized = allAgents.filter((agent) => !agent.category && !agent.inferredCategory);

    const result: BackfillResult = {
        processed: uncategorized.length,
        categorized: 0,
        skipped: allAgents.length - uncategorized.length,
        failed: 0,
    };

    for (const agent of uncategorized) {
        const pubkey = deriveAgentPubkeyFromNsec(agent.nsec);
        const metadata = toMetadata(agent);

        const inferredCategory = await categorizeAgent(metadata);
        if (!inferredCategory) {
            result.failed++;
            continue;
        }

        result.categorized++;

        if (options.dryRun) {
            logger.info("[AgentCategorization] Dry run classification", {
                slug: agent.slug,
                pubkey,
                category: inferredCategory,
            });
            continue;
        }

        const updated = await storage.updateInferredCategory(pubkey, inferredCategory);
        if (!updated) {
            result.failed++;
            logger.warn("[AgentCategorization] Failed to persist inferred category", {
                slug: agent.slug,
                pubkey,
                category: inferredCategory,
            });
        } else {
            logger.info("[AgentCategorization] Persisted inferred category", {
                slug: agent.slug,
                pubkey,
                category: inferredCategory,
            });
        }
    }

    return result;
}
