import type { ExecutionContext } from "@/agents/execution/types";
import { agentStorage } from "@/agents/AgentStorage";
import { getDaemon } from "@/daemon";
import { getNDK } from "@/nostr/ndkClient";
import type { StopExecutionSignal } from "@/services/ral/types";
import type { AISdkTool } from "@/tools/types";
import { logger } from "@/utils/logger";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { tool } from "ai";
import { z } from "zod";

const delegateCrossProjectSchema = z.object({
    content: z.string().describe("The content of the chat message to send"),
    projectId: z
        .string()
        .describe(
            "The project ID (dTag) to delegate to. Use project_list to discover available projects."
        ),
    agentSlug: z
        .string()
        .describe(
            "The slug of the agent within the target project to delegate to. Use project_list to see available agents."
        ),
});

type DelegateCrossProjectInput = z.infer<typeof delegateCrossProjectSchema>;
type DelegateCrossProjectOutput = StopExecutionSignal;

async function executeDelegateCrossProject(
    input: DelegateCrossProjectInput,
    context: ExecutionContext
): Promise<DelegateCrossProjectOutput> {
    const { content, projectId, agentSlug } = input;

    // Get known projects from daemon
    const daemon = getDaemon();
    const knownProjects = daemon.getKnownProjects();
    const activeRuntimes = daemon.getActiveRuntimes();

    // Find project by id (dTag) - projectId in knownProjects is "31933:pubkey:dTag"
    let project = null;
    let fullProjectId = "";
    for (const [pId, p] of knownProjects) {
        const dTag = pId.split(":")[2];
        if (dTag === projectId) {
            project = p;
            fullProjectId = pId;
            break;
        }
    }

    if (!project) {
        throw new Error(
            `Project '${projectId}' not found. Use project_list to see available projects.`
        );
    }

    // Find agent pubkey
    let agentPubkey: string | null = null;

    // Try runtime first (if project is running)
    const runtime = activeRuntimes.get(fullProjectId);
    if (runtime) {
        const runtimeContext = runtime.getContext();
        const agentMap = runtimeContext?.agentRegistry.getAllAgentsMap();
        if (agentMap) {
            for (const agent of agentMap.values()) {
                if (agent.slug === agentSlug) {
                    agentPubkey = agent.pubkey;
                    break;
                }
            }
        }
    }

    // Fall back to storage
    if (!agentPubkey) {
        const agents = await agentStorage.getProjectAgents(projectId);
        const agent = agents.find((a) => a.slug === agentSlug);
        if (agent) {
            const signer = new NDKPrivateKeySigner(agent.nsec);
            agentPubkey = signer.pubkey;
        }
    }

    if (!agentPubkey) {
        throw new Error(
            `Agent '${agentSlug}' not found in project '${projectId}'. Use project_list to see available agents.`
        );
    }

    // Prevent self-delegation within the same project
    if (agentPubkey === context.agent.pubkey) {
        throw new Error(
            "Cannot delegate to yourself in another project. Use delegate tool for same-project delegation."
        );
    }

    const ndk = getNDK();

    logger.info("[delegate_crossproject] Publishing cross-project delegation", {
        agent: context.agent.name,
        targetProject: projectId,
        targetAgent: agentSlug,
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

    return {
        __stopExecution: true,
        pendingDelegations: [
            {
                type: "external" as const,
                delegationConversationId: chatEvent.id,
                recipientPubkey: agentPubkey,
                senderPubkey: context.agent.pubkey,
                prompt: content,
                projectId: fullProjectId,
                ralNumber: context.ralNumber!,
            },
        ],
    };
}

export function createDelegateCrossProjectTool(context: ExecutionContext): AISdkTool {
    const aiTool = tool({
        description: `Delegate a task to an agent in another project. Use project_list first to discover available projects and their agents.

When using this tool, provide context to the recipient, introduce yourself and explain you are an agent and the project you are working on.`,
        inputSchema: delegateCrossProjectSchema,
        execute: async (input: DelegateCrossProjectInput) => {
            return await executeDelegateCrossProject(input, context);
        },
    });

    Object.defineProperty(aiTool, "getHumanReadableContent", {
        value: (args: unknown) => {
            if (!args || typeof args !== "object") {
                return "Delegating to cross-project agent";
            }

            const { projectId, agentSlug } = args as Partial<DelegateCrossProjectInput>;

            if (!projectId || !agentSlug) {
                return "Delegating to cross-project agent";
            }

            return `Delegating to agent '${agentSlug}' in project '${projectId}'`;
        },
        enumerable: false,
        configurable: true,
    });

    return aiTool as AISdkTool;
}
