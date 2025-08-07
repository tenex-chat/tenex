import { getNDK } from "@/nostr";
import { getProjectContext } from "@/services/ProjectContext";
import { formatAnyError } from "@/utils/error-formatter";
import { logger } from "@/utils/logger";
import { NDKTask } from "@nostr-dev-kit/ndk";
import { z } from "zod";
import type { Tool } from "../types";
import { createZodSchema } from "../types";

const createMilestoneTaskSchema = z.object({
    title: z.string().describe("Title for the milestone task"),
    description: z.string().describe("Detailed description of what needs to be accomplished"),
    assignees: z
        .array(z.string())
        .optional()
        .describe("Agent slugs to assign to this task (e.g., 'executor', 'planner')"),
});

interface CreateMilestoneTaskInput {
    title: string;
    description: string;
    assignees?: string[];
}

interface CreateMilestoneTaskOutput {
    message: string;
    eventId: string;
    title: string;
    descriptionLength: number;
    assignees: string[] | undefined;
}

export const createMilestoneTaskTool: Tool<CreateMilestoneTaskInput, CreateMilestoneTaskOutput> = {
    name: "create_milestone_task",
    description:
        "Create a trackable milestone task for dividing complex work. Tasks can be assigned to specific agents and tracked for completion. Only available to orchestrator agents.",

    parameters: createZodSchema(createMilestoneTaskSchema),

    execute: async (input, context) => {
        const { title, description, assignees } = input.value;

        logger.info("📋 Creating milestone task", {
            agent: context.agent.name,
            agentPubkey: context.agent.pubkey,
            title,
            descriptionLength: description.length,
            assigneeCount: assignees?.length || 0,
            phase: context.phase,
            conversationId: context.conversationId,
        });

        // Check if agent signer is available
        const agentSigner = context.agent.signer;
        if (!agentSigner) {
            logger.warn("Agent signer not available, cannot create task", {
                agent: context.agent.name,
            });
            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "create_milestone_task",
                    message: "Agent signer not available for creating task",
                },
            };
        }

        // Get NDK instance
        const ndk = getNDK();
        if (!ndk) {
            logger.error("NDK instance not available", {
                agent: context.agent.name,
            });
            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "create_milestone_task",
                    message: "NDK instance not available",
                },
            };
        }

        // Get project context
        const projectCtx = getProjectContext();

        try {
            // Create the task event
            const task = new NDKTask(ndk);
            task.title = title;
            task.content = description;

            // Tag the project event
            task.tag(projectCtx.project);

            // Add status tag
            task.tags.push(["status", "pending"]);

            // Add milestone tag to distinguish from claude_code tasks
            task.tags.push(["milestone", "true"]);

            // Add phase tag
            task.tags.push(["phase", context.phase]);

            // If we're in a conversation, reference it as parent
            if (context.conversationId) {
                task.tags.push(["e", context.conversationId]);
            }

            // Add assignee tags if provided
            if (assignees && Array.isArray(assignees)) {
                const agents = Array.from(projectCtx.agents.values());
                for (const slug of assignees) {
                    const agent = agents.find((a) => a.slug === slug);
                    if (agent?.pubkey) {
                        task.tags.push(["p", agent.pubkey]);
                        logger.debug("Added assignee to task", {
                            agentSlug: slug,
                            agentPubkey: agent.pubkey,
                        });
                    } else {
                        logger.warn("Could not find agent for assignment", {
                            requestedSlug: slug,
                        });
                    }
                }
            }

            // Sign and publish the event
            await task.sign(agentSigner);
            await task.publish();

            logger.info("✅ Successfully created milestone task", {
                agent: context.agent.name,
                agentPubkey: context.agent.pubkey,
                eventId: task.id,
                title,
                assigneeCount: assignees?.length || 0,
                phase: context.phase,
                projectId: projectCtx.project.tagId(),
            });

            const assigneeText =
                assignees && assignees.length > 0
                    ? `\nAssigned to: ${assignees.join(", ")}`
                    : "\nNo specific assignees (available for any agent)";

            const message = `✅ Milestone task created: "${title}"${assigneeText}\n\nTask ID: ${task.id}\n\nThe task is now available for the assigned agents to work on.`;

            return {
                ok: true,
                value: {
                    message,
                    eventId: task.id,
                    title,
                    descriptionLength: description.length,
                    assignees,
                },
            };
        } catch (error) {
            logger.error("❌ Create milestone task tool failed", {
                error: formatAnyError(error),
                agent: context.agent.name,
                agentPubkey: context.agent.pubkey,
                title,
                phase: context.phase,
                conversationId: context.conversationId,
            });

            return {
                ok: false,
                error: {
                    kind: "execution" as const,
                    tool: "create_milestone_task",
                    message: formatAnyError(error),
                },
            };
        }
    },
};
