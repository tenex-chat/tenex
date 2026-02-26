import { z } from "zod";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
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

export async function distillAgentIdentity(
    files: OpenClawWorkspaceFiles,
    llmConfig: LLMConfiguration
): Promise<DistilledAgentIdentity> {
    const service = llmServiceFactory.createService(llmConfig);
    const prompt = buildDistillationPrompt(files);

    const { object } = await service.generateObject(
        [{ role: "user", content: prompt }],
        DistilledIdentitySchema
    );

    return object;
}
