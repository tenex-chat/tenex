import { z } from "zod";
import { tool } from "ai";
import type { AISdkTool, ConversationToolContext } from "@/tools/types";
import { SkillService } from "@/services/skill/SkillService";
import { renderSkill } from "@/prompts/fragments/12-skills";

const skillsSetSchema = z.object({
    skills: z
        .array(z.string())
        .describe(
            "The full set of skill event IDs to activate. Passing [] clears all self-applied skills."
        ),
});

type SkillsSetInput = z.infer<typeof skillsSetSchema>;

/**
 * Creates the `skills_set` tool that lets agents self-apply skills during a conversation.
 * Accepts an array of skill identifiers (hex event IDs).
 * Passing `[]` clears all self-applied skills.
 *
 * Semantics:
 * - Each call sets the complete active skill list (not additive). Prior tool-result messages
 *   from earlier calls remain in conversation history, but the system prompt and future steps
 *   reflect only the latest set via `prepareStep` rehydration.
 * - All input IDs must resolve. Partial resolution is rejected to prevent garbage IDs from persisting.
 * - Only canonical eventIds from resolved SkillData are persisted (not raw input strings).
 * - Tool result includes the full rendered skill payload (matching system prompt format) so the
 *   agent sees file paths and content immediately, not just on the next RAL.
 */
export function createSkillsSetTool(context: ConversationToolContext) {
    const { conversationStore, agent } = context;

    return tool({
        description:
            "Activate skills on yourself for this conversation. Pass the complete set of skill event IDs you want active — each call sets the full list (not additive). Passing an empty array clears all self-applied skills. Skill content is returned immediately; the system prompt updates on the next step and in future RALs.",
        inputSchema: skillsSetSchema,
        execute: async (input: SkillsSetInput) => {
            const { skills: skillEventIds } = input;
            const agentPubkey = agent.pubkey;

            // If clearing all skills
            if (skillEventIds.length === 0) {
                conversationStore.setSelfAppliedSkills([], agentPubkey);
                return {
                    success: true,
                    message: "All self-applied skills cleared.",
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Fetch and validate skills
            const skillService = SkillService.getInstance();
            const result = await skillService.fetchSkills(skillEventIds);

            // Reject if no skills resolved at all
            if (result.skills.length === 0) {
                return {
                    success: false,
                    message: `Could not resolve any skills from the provided identifiers: ${skillEventIds.join(", ")}`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Reject partial resolution — every input ID must resolve to prevent garbage IDs from persisting
            if (result.skills.length < skillEventIds.length) {
                const resolvedIds = new Set(result.skills.map((s) => s.eventId));
                const unresolvedIds = skillEventIds.filter((id) => !resolvedIds.has(id));
                return {
                    success: false,
                    message: `Partial resolution rejected: ${unresolvedIds.length} skill(s) could not be resolved: ${unresolvedIds.join(", ")}. All IDs must be valid. No changes were made.`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Persist only canonical resolved eventIds (not raw input strings)
            const resolvedEventIds = result.skills.map((s) => s.eventId);
            conversationStore.setSelfAppliedSkills(resolvedEventIds, agentPubkey);

            // Build full rendered skill content matching system prompt format (includes file paths)
            const renderedContent = result.skills.map((s) => renderSkill(s)).join("\n\n");

            const activatedNames = result.skills.map(
                (s) => s.name || s.shortId || "unnamed"
            );

            return {
                success: true,
                message: `Activated ${result.skills.length} skill(s): ${activatedNames.join(", ")}. Full skill content (including file paths) is included below — apply it immediately.`,
                activeSkills: activatedNames,
                // Return full rendered payload so agent sees installed file paths in this RAL
                skillContent: renderedContent,
            };
        },
    }) as AISdkTool;
}
