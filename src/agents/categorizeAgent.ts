import { llmServiceFactory } from "@/llm";
import { VALID_CATEGORIES, type AgentCategory, isValidCategory } from "@/agents/role-categories";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

export type AgentMetadata = {
    name: string;
    role?: string;
    description?: string;
    instructions?: string;
    useCriteria?: string;
};

const SYSTEM_PROMPT = `You classify TENEX agents into exactly one category.

Choose one of these values only:
- principal: the human user or a direct human representative
- orchestrator: routes, delegates, and coordinates work across agents
- worker: implements tasks directly and makes changes
- reviewer: evaluates quality, validates work, and enforces standards
- domain-expert: has deep specialist knowledge in a specific domain
- generalist: a broad-purpose agent that does not fit the other roles

Return only the category name. No explanation, no punctuation, no extra text.
Valid categories: ${VALID_CATEGORIES.join(", ")}`;

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CATEGORY_REGEX = new RegExp(
    `\\b(${VALID_CATEGORIES.map(escapeRegex).join("|")})\\b`,
    "i"
);

export function parseCategory(raw: string): AgentCategory | undefined {
    const normalized = raw.trim().toLowerCase();
    if (isValidCategory(normalized)) {
        return normalized;
    }

    const match = CATEGORY_REGEX.exec(raw);
    if (!match) {
        return undefined;
    }

    const candidate = match[1].toLowerCase();
    return isValidCategory(candidate) ? candidate : undefined;
}

function buildUserPrompt(metadata: AgentMetadata): string {
    const parts = [
        `Name: ${metadata.name}`,
        metadata.role ? `Role: ${metadata.role}` : undefined,
        metadata.description ? `Description: ${metadata.description}` : undefined,
        metadata.useCriteria ? `Use criteria: ${metadata.useCriteria}` : undefined,
    ].filter((value): value is string => Boolean(value));

    if (metadata.instructions) {
        parts.push(`Instructions excerpt: ${metadata.instructions.slice(0, 500)}`);
    }

    return parts.join("\n");
}

/**
 * Infer an agent category from its metadata using the configured LLM.
 * Returns undefined when inference fails or the LLM output cannot be parsed.
 */
export async function categorizeAgent(metadata: AgentMetadata): Promise<AgentCategory | undefined> {
    try {
        const { llms } = await config.loadConfig();
        const configName = llms.categorization || llms.summarization || llms.default;

        if (!configName) {
            logger.warn("[AgentCategorization] No LLM configuration available", {
                agentName: metadata.name,
            });
            return undefined;
        }

        const llmConfig = config.getLLMConfig(configName);
        const llmService = llmServiceFactory.createService(llmConfig, {
            agentName: "agent-categorizer",
        });

        const result = await llmService.generateText([
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(metadata) },
        ]);

        const category = parseCategory(result.text);
        if (!category) {
            logger.warn("[AgentCategorization] LLM output could not be parsed", {
                agentName: metadata.name,
                raw: result.text,
            });
            return undefined;
        }

        return category;
    } catch (error) {
        logger.warn("[AgentCategorization] Failed to infer agent category", {
            agentName: metadata.name,
            error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
}
