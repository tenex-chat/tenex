import { z } from "zod";
import { tool } from "ai";
import type { AISdkTool, ConversationToolContext } from "@/tools/types";
import { SkillService } from "@/services/skill/SkillService";

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
 * This is a full replacement — passing `[]` clears all self-applied skills.
 */
export function createSkillsSetTool(context: ConversationToolContext) {
    const { conversationStore, agent } = context;

    return tool({
        description:
            "Activate skills on yourself for this conversation. Pass the full set of skill event IDs you want active. This is a full replacement — passing an empty array clears all self-applied skills. Skill content is returned immediately and persisted for future cycles.",
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

            // Validate that the skills exist by fetching them
            const skillService = SkillService.getInstance();
            const result = await skillService.fetchSkills(skillEventIds);

            if (result.skills.length === 0) {
                return {
                    success: false,
                    message: `Could not resolve any skills from the provided identifiers: ${skillEventIds.join(", ")}`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Store the resolved IDs on the conversation for persistence across RAL cycles
            conversationStore.setSelfAppliedSkills(skillEventIds, agentPubkey);

            // Build feedback about which skills were activated
            const activatedNames = result.skills.map(
                (s) => s.name ?? s.shortId ?? "unnamed"
            );

            return {
                success: true,
                message: `Activated ${result.skills.length} skill(s): ${activatedNames.join(", ")}. Skill content is included below — apply it immediately.`,
                activeSkills: activatedNames,
                // Return full skill content so the LLM sees it in the current turn
                skillContent: result.content,
            };
        },
    }) as AISdkTool;
}
