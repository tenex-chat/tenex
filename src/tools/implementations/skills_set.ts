import { z } from "zod";
import { tool } from "ai";
import type { AISdkTool, ConversationToolContext } from "@/tools/types";
import { SkillService } from "@/services/skill/SkillService";
import { renderSkill } from "@/prompts/fragments/12-skills";
import { agentStorage } from "@/agents/AgentStorage";
import { getProjectContext } from "@/services/projects";

const skillsSetSchema = z.object({
    skills: z
        .array(z.string())
        .describe(
            "The full set of skill IDs to activate. Use the IDs shown in the available-skills list. Passing [] clears all self-applied skills."
        ),
    always: z
        .boolean()
        .optional()
        .describe(
            "When true, saves these skills to the agent's persistent config so they are active by default in all future conversations."
        ),
});

type SkillsSetInput = z.infer<typeof skillsSetSchema>;

/**
 * Creates the `skills_set` tool that lets agents self-apply skills during a conversation.
 * Accepts an array of skill identifiers exactly as surfaced in the prompt.
 * Passing `[]` clears all self-applied skills.
 *
 * Semantics:
 * - Each call sets the complete active skill list (not additive). Prior tool-result messages
 *   from earlier calls remain in conversation history, but the system prompt and future steps
 *   reflect only the latest set via `prepareStep` rehydration.
 * - All input IDs must already exist in the available skill list. Partial resolution is rejected
 *   to prevent garbage IDs from persisting.
 * - Local skill IDs are persisted, because the local skill store is authoritative.
 * - Tool result includes the full rendered skill payload (matching system prompt format) so the
 *   agent sees file paths and content immediately, not just on the next RAL.
 */
export function createSkillsSetTool(context: ConversationToolContext): AISdkTool {
    const { conversationStore, agent } = context;

    return tool({
        description:
            "Activate skills on yourself for this conversation. Pass the complete set of skill IDs you want active, using the IDs shown in the available-skills list. Each call sets the full list (not additive). Passing an empty array clears all self-applied skills. Skill content is returned immediately; the system prompt updates on the next step and in future RALs.",
        inputSchema: skillsSetSchema,
        execute: async (input: SkillsSetInput) => {
            const { skills: rawRequestedSkillIds, always } = input;
            const agentPubkey = agent.pubkey;
            const requestedSkillIds = rawRequestedSkillIds.map((skillId) => skillId.trim());

            // If clearing all skills
            if (requestedSkillIds.length === 0) {
                conversationStore.setSelfAppliedSkills([], agentPubkey);
                if (always) {
                    await agentStorage.updateDefaultConfig(agentPubkey, { skills: [] });
                }
                return {
                    success: true,
                    message: "All self-applied skills cleared.",
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            const skillService = SkillService.getInstance();
            const projectContext = getProjectContext();
            const skillLookupContext = {
                agentPubkey,
                projectDTag:
                    projectContext.project.dTag || projectContext.project.tagValue("d") || undefined,
            };
            const availableSkills = await skillService.listAvailableSkills(skillLookupContext);
            const availableSkillIds = new Set(
                availableSkills
                    .map((skill) => skill.identifier)
                    .filter((skillId): skillId is string => Boolean(skillId))
            );
            const unresolvedIdentifiers = requestedSkillIds.filter(
                (skillId) => !availableSkillIds.has(skillId)
            );
            const uniqueRequestedSkillIds = [...new Set(requestedSkillIds)];

            if (uniqueRequestedSkillIds.length === 0) {
                return {
                    success: false,
                    message: "Could not resolve any skills from the provided identifiers.",
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            if (unresolvedIdentifiers.length > 0) {
                return {
                    success: false,
                    message: `Partial resolution rejected: ${unresolvedIdentifiers.length} skill(s) are not in the available skill list: ${unresolvedIdentifiers.join(", ")}. All IDs must be valid skill IDs. No changes were made.`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Fetch and validate skills
            const result = await skillService.fetchSkills(
                uniqueRequestedSkillIds,
                skillLookupContext
            );

            // Reject if no skills resolved at all
            if (result.skills.length === 0) {
                return {
                    success: false,
                    message: `Could not resolve any skills from the provided identifiers: ${requestedSkillIds.join(", ")}`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Reject partial resolution — every input ID must resolve to prevent garbage IDs from persisting
            if (result.skills.length < uniqueRequestedSkillIds.length) {
                const loadedSkillIds = new Set(
                    result.skills
                        .map((skill) => skill.identifier)
                        .filter((skillId): skillId is string => Boolean(skillId))
                );
                const unresolvedIds = uniqueRequestedSkillIds.filter((id) => !loadedSkillIds.has(id));
                return {
                    success: false,
                    message: `Partial resolution rejected: ${unresolvedIds.length} skill(s) could not be resolved: ${unresolvedIds.join(", ")}. All IDs must be valid. No changes were made.`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            const resolvedLocalSkillIds = result.skills
                .map((skill) => skill.identifier)
                .filter((skillId): skillId is string => Boolean(skillId));

            if (resolvedLocalSkillIds.length !== result.skills.length) {
                return {
                    success: false,
                    message: "One or more loaded skills did not have a local identifier. No changes were made.",
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            conversationStore.setSelfAppliedSkills(resolvedLocalSkillIds, agentPubkey);

            if (always) {
                await agentStorage.updateDefaultConfig(agentPubkey, { skills: resolvedLocalSkillIds });
            }

            // Build full rendered skill content matching system prompt format (includes file paths)
            const renderedContent = result.skills.map((s) => renderSkill(s)).join("\n\n");

            const activatedIds = resolvedLocalSkillIds;

            const message = always
                ? `Activated ${result.skills.length} skill(s): ${activatedIds.join(", ")}. Saved as always-on to agent config.`
                : `Activated ${result.skills.length} skill(s): ${activatedIds.join(", ")}. Full skill content (including file paths) is included below — apply it immediately.`;

            return {
                success: true,
                message,
                activeSkills: activatedIds,
                skillContent: renderedContent,
            };
        },
    }) as AISdkTool;
}
