import { z } from "zod";
import { tool } from "ai";
import { homedir } from "node:os";
import type { AISdkTool, ConversationToolContext } from "@/tools/types";
import { SkillService } from "@/services/skill/SkillService";
import { renderSkill } from "@/agents/execution/skill-reminder-renderers";
import { agentStorage } from "@/agents/AgentStorage";
import { getProjectContext } from "@/services/projects";
import { getAgentHomeDirectory } from "@/lib/agent-home";
import {
    buildExpandedBlockedSet,
    buildSkillAliasMap,
    isSkillBlocked,
} from "@/services/skill/skill-blocking";

const skillsSetSchema = z.object({
    add: z
        .array(z.string())
        .optional()
        .describe(
            "Skill IDs to activate (merged into current set). Use IDs returned by `skill_list`."
        ),
    remove: z
        .array(z.string())
        .optional()
        .describe(
            'Skill IDs to deactivate. Pass ["*"] to clear all skills before applying `add`.'
        ),
    always: z
        .boolean()
        .optional()
        .describe(
            "When true, persists the resulting skill set to agent config for all future conversations."
        ),
});

type SkillsSetInput = z.infer<typeof skillsSetSchema>;

/**
 * Creates the `skills_set` tool that lets agents incrementally add/remove skills during a conversation.
 *
 * Semantics:
 * - Reads the current active skill set from the conversation store.
 * - Applies `remove` first (subtract listed IDs, or clear all with `["*"]`).
 * - Validates `add` IDs against `skill_list` results. Partial resolution is rejected.
 * - Merges `add` into the remaining set (deduped).
 * - Fetches only newly-added skills for rendering (the agent already has content for previously-active ones).
 * - Persists via `setSelfAppliedSkills` and optionally `updateDefaultConfig`.
 */
export function createSkillsSetTool(context: ConversationToolContext): AISdkTool {
    const { conversationStore, agent } = context;

    return tool({
        description:
            "Add or remove skills on yourself for this conversation. Use `add` to activate skills and `remove` to deactivate them (or pass remove: [\"*\"] to clear all). Both fields are optional and can be combined. Only newly-added skill content is returned; the system prompt updates on the next step.",
        inputSchema: skillsSetSchema,
        execute: async (input: SkillsSetInput) => {
            const { add: rawAdd, remove: rawRemove, always } = input;
            const agentPubkey = agent.pubkey;

            const addIds = (rawAdd ?? []).map((id) => id.trim()).filter(Boolean);
            const removeIds = (rawRemove ?? []).map((id) => id.trim()).filter(Boolean);

            // Reject conflicting intent: same ID in both add and remove
            const conflicting = addIds.filter((id) => removeIds.includes(id));
            if (conflicting.length > 0) {
                return {
                    success: false,
                    message: `Conflicting intent: ${conflicting.join(", ")} appear in both \`add\` and \`remove\`. Decide whether to add or remove, not both.`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // No-op: both empty/omitted
            if (addIds.length === 0 && removeIds.length === 0) {
                const currentSkills = conversationStore.getSelfAppliedSkillIds(agentPubkey);
                return {
                    success: true,
                    message: currentSkills.length === 0
                        ? "No skills currently active. Pass `add` to activate skills."
                        : `Currently active skills: ${currentSkills.join(", ")}. Pass \`add\` or \`remove\` to change.`,
                    activeSkills: currentSkills,
                    skillContent: "",
                };
            }

            // Read current set
            const currentSkills = new Set(conversationStore.getSelfAppliedSkillIds(agentPubkey));

            // Apply remove
            if (removeIds.includes("*")) {
                currentSkills.clear();
            } else {
                for (const id of removeIds) {
                    currentSkills.delete(id);
                }
            }

            // If no add IDs, just persist the removal result
            if (addIds.length === 0) {
                const finalSkills = [...currentSkills];
                conversationStore.setSelfAppliedSkills(finalSkills, agentPubkey);
                if (always) {
                    await agentStorage.updateDefaultConfig(agentPubkey, { skills: finalSkills });
                }
                const message = finalSkills.length === 0
                    ? "All self-applied skills cleared."
                    : `Removed skill(s). Active skills: ${finalSkills.join(", ")}.`;
                return {
                    success: true,
                    message,
                    activeSkills: finalSkills,
                    skillContent: "",
                };
            }

            // Validate add IDs against available skills
            const skillService = SkillService.getInstance();
            const projectContext = getProjectContext();
            const skillLookupContext = {
                agentPubkey,
                projectPath: context.projectBasePath || undefined,
                projectDTag:
                    projectContext.project.dTag || projectContext.project.tagValue("d") || undefined,
            };
            const availableSkills = await skillService.listAvailableSkills(skillLookupContext);
            const availableSkillMap = buildSkillAliasMap(availableSkills);
            const availableSkillIds = new Set(
                availableSkills
                    .map((skill) => skill.identifier)
                    .filter((skillId): skillId is string => Boolean(skillId))
            );
            const blockedSet = buildExpandedBlockedSet(agent.blockedSkills ?? [], availableSkillMap);
            const blockedAttempts = addIds.filter((id) =>
                isSkillBlocked(id, blockedSet, availableSkillMap)
            );
            if (blockedAttempts.length > 0) {
                return {
                    success: false,
                    message: `Cannot activate blocked skill(s): ${blockedAttempts.join(", ")}. These skills are disabled by agent configuration.`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }
            const unresolvedIdentifiers = addIds.filter((id) => !availableSkillIds.has(id));

            if (unresolvedIdentifiers.length > 0) {
                return {
                    success: false,
                    message: `Partial resolution rejected: ${unresolvedIdentifiers.length} skill(s) are not available from \`skill_list\`: ${unresolvedIdentifiers.join(", ")}. All IDs must be valid skill IDs. No changes were made.`,
                    activeSkills: [] as string[],
                    skillContent: "",
                };
            }

            // Determine which IDs are genuinely new (not already in current set)
            const uniqueAddIds = [...new Set(addIds)];
            const newlyAddedIds = uniqueAddIds.filter((id) => !currentSkills.has(id));

            // Merge add into current set
            for (const id of uniqueAddIds) {
                currentSkills.add(id);
            }

            // Fetch only newly-added skills for rendering
            let renderedContent = "";
            if (newlyAddedIds.length > 0) {
                const result = await skillService.fetchSkills(newlyAddedIds, skillLookupContext);

                if (result.skills.length === 0) {
                    return {
                        success: false,
                        message: `Could not resolve any skills from the provided identifiers: ${newlyAddedIds.join(", ")}`,
                        activeSkills: [] as string[],
                        skillContent: "",
                    };
                }

                if (result.skills.length < newlyAddedIds.length) {
                    const loadedSkillIds = new Set(
                        result.skills
                            .map((skill) => skill.identifier)
                            .filter((skillId): skillId is string => Boolean(skillId))
                    );
                    const unresolvedIds = newlyAddedIds.filter((id) => !loadedSkillIds.has(id));
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

                const pathVars: Record<string, string> = {
                    "$USER_HOME": homedir(),
                    "$AGENT_HOME": getAgentHomeDirectory(agentPubkey),
                };
                if (context.projectBasePath) {
                    pathVars["$PROJECT_BASE"] = context.projectBasePath;
                }
                renderedContent = result.skills.map((s) => renderSkill(s, pathVars)).join("\n\n");
            }

            const finalSkills = [...currentSkills];
            conversationStore.setSelfAppliedSkills(finalSkills, agentPubkey);

            if (always) {
                await agentStorage.updateDefaultConfig(agentPubkey, { skills: finalSkills });
            }

            const message = always
                ? `Activated ${uniqueAddIds.length} skill(s): ${uniqueAddIds.join(", ")}. Saved as always-on to agent config.`
                : `Activated ${uniqueAddIds.length} skill(s): ${uniqueAddIds.join(", ")}. Full skill content (including file paths) is included below — apply it immediately.`;

            return {
                success: true,
                message,
                activeSkills: finalSkills,
                skillContent: renderedContent,
            };
        },
    }) as AISdkTool;
}
