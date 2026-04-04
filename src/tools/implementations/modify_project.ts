import { agentStorage, deriveAgentPubkeyFromNsec } from "@/agents/AgentStorage";
import {
    projectEventPublishService,
    type ProjectEventPublishOutcome,
    type ProjectMetadataKey,
} from "@/services/projects";
import type { AISdkTool, ToolExecutionContext } from "@/tools/types";
import { logger } from "@/utils/logger";
import { tool } from "ai";
import { z } from "zod";

const projectSetKeySchema = z.enum(["image", "repo", "title", "description"]);

const modifyProjectSchema = z.object({
    add_agents: z
        .array(z.string())
        .optional()
        .describe("Agent slugs to add to the current project as lowercase p-tags."),
    remove_agents: z
        .array(z.string())
        .optional()
        .describe("Agent pubkeys or slugs to remove from the current project's lowercase p-tags."),
    set: z
        .array(z.tuple([projectSetKeySchema, z.string()]))
        .optional()
        .describe("Project metadata updates: [key, value] where key is image, repo, title, or description."),
});

type ModifyProjectInput = z.infer<typeof modifyProjectSchema>;

interface ModifyProjectOutput {
    success: boolean;
    projectDTag: string;
    publishedEventId?: string;
    addedPubkeys: string[];
    removedPubkeys: string[];
    updatedFields: ProjectMetadataKey[];
    skipped: string[];
    error?: string;
}

const HEX_PUBKEY_REGEX = /^[0-9a-f]{64}$/;

function uniqueOrdered(values: string[] | undefined): string[] {
    return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function buildSetMap(
    entries: Array<[ProjectMetadataKey, string]> | undefined,
): Partial<Record<ProjectMetadataKey, string>> {
    const mapped: Partial<Record<ProjectMetadataKey, string>> = {};
    for (const [key, value] of entries ?? []) {
        mapped[key] = value;
    }
    return mapped;
}

async function resolveSlugToPubkey(slug: string): Promise<string | null> {
    const agent = await agentStorage.getAgentBySlug(slug);
    if (!agent) {
        return null;
    }

    return deriveAgentPubkeyFromNsec(agent.nsec);
}

function buildPublishError(
    outcome: ProjectEventPublishOutcome,
    projectDTag: string,
    reason?: string,
): string {
    switch (outcome) {
        case "project_not_found":
            return `Could not find an active 31933 event for project "${projectDTag}".`;
        case "signing_disabled":
            return "NIP-46 signing is disabled; project update was not published.";
        case "signing_failed":
            return reason
                ? `NIP-46 signing failed: ${reason}`
                : "NIP-46 signing failed; project update was not published.";
        case "publish_failed":
            return reason
                ? `Failed to publish updated project event: ${reason}`
                : "Failed to publish updated project event.";
        default:
            return reason ?? "Project update failed.";
    }
}

async function executeModifyProject(
    input: ModifyProjectInput,
    context: ToolExecutionContext,
): Promise<ModifyProjectOutput> {
    const addAgentSlugs = uniqueOrdered(input.add_agents);
    const removeAgentInputs = uniqueOrdered(input.remove_agents);
    const set = buildSetMap(input.set);

    const projectDTag = context.projectContext.project.dTag
        || context.projectContext.project.tagValue("d");
    const ownerPubkey = context.projectContext.project.pubkey;

    if (!projectDTag) {
        return {
            success: false,
            projectDTag: "unknown-project",
            addedPubkeys: [],
            removedPubkeys: [],
            updatedFields: [],
            skipped: [],
            error: "Current project is missing a d-tag.",
        };
    }

    if (addAgentSlugs.length === 0 && removeAgentInputs.length === 0 && Object.keys(set).length === 0) {
        return {
            success: false,
            projectDTag,
            addedPubkeys: [],
            removedPubkeys: [],
            updatedFields: [],
            skipped: [],
            error: "modify_project requires at least one add_agents, remove_agents, or set mutation.",
        };
    }

    const addAgentPubkeys: string[] = [];
    for (const slug of addAgentSlugs) {
        const pubkey = await resolveSlugToPubkey(slug);
        if (!pubkey) {
            return {
                success: false,
                projectDTag,
                addedPubkeys: [],
                removedPubkeys: [],
                updatedFields: [],
                skipped: [],
                error: `Could not resolve agent slug "${slug}".`,
            };
        }

        addAgentPubkeys.push(pubkey);
    }

    const removeAgentPubkeys: string[] = [];
    for (const identifier of removeAgentInputs) {
        if (HEX_PUBKEY_REGEX.test(identifier)) {
            removeAgentPubkeys.push(identifier);
            continue;
        }

        const pubkey = await resolveSlugToPubkey(identifier);
        if (!pubkey) {
            return {
                success: false,
                projectDTag,
                addedPubkeys: [],
                removedPubkeys: [],
                updatedFields: [],
                skipped: [],
                error: `Could not resolve agent "${identifier}" for removal.`,
            };
        }

        removeAgentPubkeys.push(pubkey);
    }

    const addSet = new Set(addAgentPubkeys);
    const removeSet = new Set(removeAgentPubkeys);
    const conflictingPubkeys = addAgentPubkeys.filter((pubkey) => removeSet.has(pubkey));
    if (conflictingPubkeys.length > 0) {
        return {
            success: false,
            projectDTag,
            addedPubkeys: [],
            removedPubkeys: [],
            updatedFields: [],
            skipped: [],
            error: `Conflicting mutation: the same agent appears in both add and remove (${conflictingPubkeys.join(", ")}).`,
        };
    }

    const result = await projectEventPublishService.publishMutation({
        ownerPubkey,
        projectDTag,
        trigger: "modify_project_31933",
        addAgentPubkeys: Array.from(addSet),
        removeAgentPubkeys: Array.from(removeSet),
        set,
    });

    if (result.outcome !== "published" && result.outcome !== "no_changes") {
        return {
            success: false,
            projectDTag,
            addedPubkeys: result.addedPubkeys,
            removedPubkeys: result.removedPubkeys,
            updatedFields: result.updatedFields,
            skipped: result.skipped,
            error: buildPublishError(result.outcome, projectDTag, result.reason),
        };
    }

    return {
        success: true,
        projectDTag,
        publishedEventId: result.eventId,
        addedPubkeys: result.addedPubkeys,
        removedPubkeys: result.removedPubkeys,
        updatedFields: result.updatedFields,
        skipped: result.skipped,
    };
}

export function createModifyProjectTool(context: ToolExecutionContext): AISdkTool {
    return tool({
        description:
            "Modify the current project's owner-signed 31933 event. " +
            "Use add_agents with agent slugs to add p-tags, remove_agents with pubkeys or slugs to remove p-tags, " +
            "and set to update title, repo, image, or description before republishing via NIP-46.",
        inputSchema: modifyProjectSchema,
        execute: async (input: ModifyProjectInput) => {
            try {
                return await executeModifyProject(input, context);
            } catch (error) {
                logger.error("Failed to modify project event", { error });
                throw new Error(
                    `Failed to modify project event: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                );
            }
        },
    }) as AISdkTool;
}
