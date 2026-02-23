import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import type { EffectiveInstructionsCacheEntry } from "@/services/prompt-compiler";
import { PromptCompilerService } from "@/services/prompt-compiler";
import { getProjectContext } from "@/services/projects";
import { ReportService } from "@/services/reports";
import { logger } from "@/utils/logger";
import * as fs from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";

// Define the input schema
const agentsReadSchema = z.object({
    slug: z.string().describe("The slug identifier of the agent to read"),
});

type AgentsReadInput = z.infer<typeof agentsReadSchema>;

// Define the report shape returned in the response
interface MemorizedReport {
    slug: string;
    title?: string;
    content?: string;
    publishedAt?: number;
}

// Define the output type — all fields are always present for a consistent response contract
interface AgentsReadOutput {
    success: boolean;
    message?: string;
    error?: string;
    agent?: {
        slug: string;
        name: string;
        role: string;
        description?: string;
        instructions?: string;
        compiledInstructions: string | null;
        memorizedReports: MemorizedReport[];
        useCriteria?: string;
        llmConfig?: string;
        tools?: string[];
        eventId?: string;
        pubkey: string;
    };
}

/**
 * Read compiled (effective) instructions from the PromptCompilerService disk cache.
 * Uses the shared static helper from PromptCompilerService for the cache path.
 *
 * @returns The compiled instructions string, or null if no cache exists
 */
async function readCompiledInstructions(agentPubkey: string): Promise<string | null> {
    try {
        const cachePath = PromptCompilerService.getCachePathForAgent(agentPubkey);
        const data = await fs.readFile(cachePath, "utf-8");
        const entry = JSON.parse(data) as EffectiveInstructionsCacheEntry;
        return entry.effectiveAgentInstructions;
    } catch {
        // No cache file or invalid JSON — compiled instructions not available
        return null;
    }
}

/**
 * Read memorized reports for an agent from the ReportService cache.
 * Returns team reports first, then agent-specific reports (deduped by slug).
 * Each report includes publishedAt for chronological ordering by consumers.
 *
 * @returns Array of memorized report summaries, or empty array
 */
function readMemorizedReports(agentPubkey: string): MemorizedReport[] {
    try {
        const reportService = new ReportService();
        const agentReports = reportService.getMemorizedReportsForAgent(agentPubkey);
        const teamReports = reportService.getTeamMemorizedReports();

        // Deduplicate: team reports take precedence over agent reports with the same slug
        const teamSlugs = new Set(teamReports.map(r => r.slug));
        const combined = [
            ...teamReports,
            ...agentReports.filter(r => !teamSlugs.has(r.slug)),
        ];

        return combined
            .filter(r => !r.isDeleted)
            .map(r => ({
                slug: r.slug,
                title: r.title,
                content: r.content,
                publishedAt: r.publishedAt,
            }));
    } catch {
        // ReportService may fail if no project context — return empty
        return [];
    }
}

/**
 * Core implementation of reading agents.
 * Returns both the base agent definition and compiled runtime data when available.
 */
async function executeAgentsRead(
    input: AgentsReadInput,
    _context: ToolExecutionContext
): Promise<AgentsReadOutput> {
    const { slug } = input;

    if (!slug) {
        throw new Error("Agent slug is required");
    }

    // Get agent from project context
    const projectCtx = getProjectContext();
    const agent = projectCtx.getAgent(slug);

    if (!agent) {
        throw new Error(`Agent with slug "${slug}" not found in current project`);
    }

    // Fetch compiled instructions from disk cache (non-blocking, best-effort)
    const compiledInstructions = await readCompiledInstructions(agent.pubkey);

    // Fetch memorized reports from in-memory cache (synchronous, best-effort)
    const memorizedReports = readMemorizedReports(agent.pubkey);

    logger.info(`Successfully read agent definition for "${agent.name}" (${slug})`, {
        hasCompiledInstructions: compiledInstructions !== null,
        memorizedReportsCount: memorizedReports.length,
    });

    return {
        success: true,
        message: `Successfully read agent definition for "${agent.name}"`,
        agent: {
            slug: agent.slug,
            name: agent.name,
            role: agent.role,
            description: agent.description,
            instructions: agent.instructions,
            compiledInstructions,
            memorizedReports,
            useCriteria: agent.useCriteria,
            llmConfig: agent.llmConfig,
            tools: agent.tools,
            eventId: agent.eventId,
            pubkey: agent.pubkey,
        },
    };
}

/**
 * Create an AI SDK tool for reading agents
 * This is the primary implementation
 */
export function createAgentsReadTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Read a local agent definition, including base instructions and compiled runtime instructions when available",
        inputSchema: agentsReadSchema,
        execute: async (input: AgentsReadInput) => {
            try {
                return await executeAgentsRead(input, context);
            } catch (error) {
                logger.error("Failed to read agent definition", { error });
                throw new Error(
                    `Failed to read agent definition: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error }
                );
            }
        },
    }) as AISdkTool;
}
