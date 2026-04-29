import type { ToolExecutionContext } from "@/tools/types";
import { agentStorage } from "@/agents/AgentStorage";
import { getDaemon } from "@/daemon";
import { getNDK } from "@/nostr/ndkClient";
import { resolveAgentIdFromCandidates, type AgentIdCandidate } from "@/services/agents";
import { readProjectAgentPubkeys } from "@/services/projects/ProjectMembersReader";
import { PendingDelegationsRegistry, RALRegistry } from "@/services/ral";
import type { PendingDelegation } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { shortenConversationId } from "@/utils/conversation-id";
import { logger } from "@/utils/logger";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const delegateCrossProjectSchema = z.object({
    content: z.string().describe("The content of the chat message to send"),
    projectId: z
        .string()
        .describe(
            "The project ID (dTag) to delegate to. Use project_list to discover available projects."
        ),
    agentId: z
        .string()
        .describe(
            "The id of the agent within the target project to delegate to. Use project_list to see available agents."
        ),
});

type DelegateCrossProjectInput = z.infer<typeof delegateCrossProjectSchema>;

interface DelegateCrossProjectOutput {
    success: boolean;
    message: string;
    delegationConversationId: string;
}

/**
 * Check if the agent has any todos in the current conversation.
 */
function hasTodos(context: ToolExecutionContext): boolean {
    const conversation = context.getConversation();
    if (!conversation) return true; // No conversation context - assume OK
    return conversation.getTodos(context.agent.pubkey).length > 0;
}

async function executeDelegateCrossProject(
    input: DelegateCrossProjectInput,
    context: ToolExecutionContext
): Promise<DelegateCrossProjectOutput> {
    const { content, projectId, agentId } = input;

    // Get known projects from daemon
    const daemon = getDaemon();
    const knownProjects = daemon.getKnownProjects();
    const activeRuntimes = daemon.getActiveRuntimes();

    // Find project by d-tag — knownProjects is keyed by ProjectDTag
    const project = knownProjects.get(projectId as import("@/types/project-ids").ProjectDTag);
    if (!project) {
        throw new Error(
            `Project '${projectId}' not found. Use project_list to see available projects.`
        );
    }

    const candidates: AgentIdCandidate[] = [];

    // Try runtime first (if project is running)
    const runtime = activeRuntimes.get(projectId as import("@/types/project-ids").ProjectDTag);
    if (runtime) {
        const runtimeContext = runtime.getContext();
        if (runtimeContext && typeof runtimeContext.getProjectAgentRuntimeInfo === "function") {
            candidates.push(
                ...runtimeContext.getProjectAgentRuntimeInfo().map((agent) => ({
                    slug: agent.slug,
                    pubkey: agent.pubkey,
                }))
            );
        } else {
            const agentMap = runtimeContext?.agentRegistry.getAllAgentsMap();
            if (agentMap) {
                for (const agent of agentMap.values()) {
                    candidates.push({ slug: agent.slug, pubkey: agent.pubkey });
                }
            }
        }
    }

    const projectPubkeys = await readProjectAgentPubkeys(projectId);
    for (const pubkey of projectPubkeys) {
        const agent = await agentStorage.loadAgent(pubkey);
        if (agent) {
            candidates.push({ slug: agent.slug, pubkey });
        }
    }

    const resolution = resolveAgentIdFromCandidates(agentId, candidates);
    const agentPubkey = resolution.pubkey;

    if (!agentPubkey) {
        const availableIds = resolution.availableIds.length > 0
            ? `Available agent ids: ${resolution.availableIds.join(", ")}`
            : "No agents are available in the target project.";
        throw new Error(
            `Agent id '${agentId}' not found in project '${projectId}'. ${availableIds}`
        );
    }

    const ndk = getNDK();

    logger.info("[delegate_crossproject] Publishing cross-project delegation", {
        agent: context.agent.name,
        targetProject: projectId,
        targetAgent: resolution.slug ?? agentId,
        recipientPubkey: agentPubkey.substring(0, 8),
    });

    // Create delegation event
    const chatEvent = new NDKEvent(ndk);
    chatEvent.kind = 1;
    chatEvent.content = content;
    chatEvent.tags.push(["p", agentPubkey]);
    // Add "a" tag referencing the target project
    chatEvent.tags.push(["a", `31933:${project.pubkey}:${projectId}`]);

    await context.agent.sign(chatEvent);
    await chatEvent.publish();

    // Register with PendingDelegationsRegistry for q-tag correlation
    PendingDelegationsRegistry.register(context.agent.pubkey, context.conversationId, chatEvent.id);

    // Register pending delegation in RALRegistry for response routing
    // Uses atomic merge to safely handle concurrent delegation calls
    const ralRegistry = RALRegistry.getInstance();
    const newDelegation: PendingDelegation = {
        type: "external" as const,
        delegationConversationId: chatEvent.id,
        recipientPubkey: agentPubkey,
        senderPubkey: context.agent.pubkey,
        prompt: content,
        projectId,
        ralNumber: context.ralNumber,
    };

    ralRegistry.mergePendingDelegations(
        context.agent.pubkey,
        context.conversationId,
        context.ralNumber,
        [newDelegation]
    );

    logger.info("[delegate_crossproject] Delegation registered, agent continues without blocking", {
        delegationConversationId: chatEvent.id,
    });

    // Return normal result - agent continues without blocking
    let message = `Delegated to agent '${resolution.slug ?? agentId}' in project '${projectId}'. The agent will respond when ready.`;

    if (!hasTodos(context)) {
        message +=
            "\n\n<system-reminder type=\"delegation-todo-nudge\">\n" +
            "You just delegated task(s) but don't have a todo list yet. Use `todo_write()` to set up a todo list tracking your delegated work and overall workflow.\n" +
            "</system-reminder>";
    }

    return {
        success: true,
        message,
        delegationConversationId: shortenConversationId(chatEvent.id),
    };
}

export function createDelegateCrossProjectTool(context: ToolExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Delegate a task to an agent in another project. Use project_list first to discover available projects and their agents.

When using this tool, provide context to the recipient, introduce yourself and explain you are an agent and the project you are working on.`,
        inputSchema: delegateCrossProjectSchema,
        execute: async (input: DelegateCrossProjectInput) => {
            return await executeDelegateCrossProject(input, context);
        },
    });

    return aiTool as AISdkTool;
}
