import { z } from "zod";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { logger } from "@/utils/logger";
import type { LLMConfiguration } from "@/services/config/types";
import type { OpenClawWorkspaceFiles } from "./openclaw-reader";

const DistilledIdentitySchema = z.object({
    name: z.string(),
    description: z.string(),
    role: z.string(),
    useCriteria: z.string(),
    instructions: z.string(),
});
export type DistilledAgentIdentity = z.infer<typeof DistilledIdentitySchema>;

export function buildDistillationPrompt(files: OpenClawWorkspaceFiles): string {
    const sections: string[] = [];

    if (files.soul) {
        sections.push(`<SOUL.md>\n${files.soul}\n</SOUL.md>`);
    }
    if (files.identity) {
        sections.push(`<IDENTITY.md>\n${files.identity}\n</IDENTITY.md>`);
    }
    if (files.agents) {
        sections.push(`<AGENTS.md>\n${files.agents}\n</AGENTS.md>`);
    }

    return `You are extracting a portable agent identity from an OpenClaw installation.
Given these workspace files, return a JSON object with exactly these fields:

- name: the agent's display name (string)
- description: one-sentence description of who this agent is (string)
- role: short phrase describing expertise/personality, e.g. "personal AI assistant" (string)
- useCriteria: when this agent should be selected over others (string)
- instructions: a clean, platform-agnostic system prompt capturing the agent's
  personality, behavioral guidelines, and identity. Discard anything specific
  to OpenClaw: heartbeat polling, HEARTBEAT_OK responses, workspace file reading
  rituals, emoji reaction guidance, silence tokens, tool-specific commands,
  and memory file management instructions. (string)

${sections.join("\n\n")}`;
}

async function distillWithRetry<T>(
    llmConfigs: LLMConfiguration[],
    run: (service: ReturnType<typeof llmServiceFactory.createService>) => Promise<T>,
): Promise<T> {
    if (llmConfigs.length === 0) {
        throw new Error("No LLM configurations available for distillation");
    }

    let lastError: unknown;
    for (const config of llmConfigs) {
        try {
            const service = llmServiceFactory.createService(config);
            return await run(service);
        } catch (error) {
            lastError = error;
            if (llmConfigs.length > 1) {
                logger.warn(
                    `[distiller] call failed with ${config.provider}:${config.model}, trying next model...`
                );
            }
        }
    }

    throw lastError;
}

export async function distillAgentIdentity(
    files: OpenClawWorkspaceFiles,
    llmConfigs: LLMConfiguration[]
): Promise<DistilledAgentIdentity> {
    const prompt = buildDistillationPrompt(files);
    const messages = [{ role: "user" as const, content: prompt }];

    return distillWithRetry(llmConfigs, async (service) => {
        const { object } = await service.generateObject(messages, DistilledIdentitySchema);
        return object;
    });
}

export function buildUserContextPrompt(rawUserMd: string): string {
    return `You are cleaning up a user profile document for use as context in an AI assistant's system prompt.

Given the raw USER.md content below, produce a clean, concise summary of everything that would be useful for an AI assistant to know about this user. Write it as a brief markdown section.

Keep anything that helps the assistant interact better: name, preferences, timezone, communication style, interests, projects, technical background, etc.

Drop anything that is noise: unknown/empty fields, platform-specific metadata (IDs, timestamps of first conversations), internal bookkeeping, and formatting artifacts.

If the document contains almost nothing useful, return an empty string.

<USER.md>
${rawUserMd}
</USER.md>`;
}

export async function distillUserContext(
    rawUserMd: string,
    llmConfigs: LLMConfiguration[],
): Promise<string> {
    const prompt = buildUserContextPrompt(rawUserMd);
    const messages = [{ role: "user" as const, content: prompt }];

    const result = await distillWithRetry(llmConfigs, async (service) => {
        const { text } = await service.generateText(messages);
        return text;
    });

    return result.trim();
}
