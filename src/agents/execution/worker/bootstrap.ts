import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import { config } from "@/services/ConfigService";
import { MCPManager } from "@/services/mcp/MCPManager";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { createProjectDTag } from "@/types/project-ids";
import { NDKProject } from "@nostr-dev-kit/ndk";
import {
    createWorkerProtocolPublisherFactory,
    type WorkerProtocolPublisherExecutionState,
} from "./publisher-bridge";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";
import {
    WorkerTelegramSendBridge,
    setActiveTelegramSendBridge,
    type TelegramSendResultSource,
} from "./telegram-send-bridge";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type AgentWorkerExecutor = Pick<AgentExecutor, "execute">;

export class AgentWorkerExecutionFailure extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly retryable: boolean,
        options?: ErrorOptions
    ) {
        super(message, options);
        this.name = "AgentWorkerExecutionFailure";
    }
}

export interface AgentWorkerExecutionResult {
    finalRalState: "completed" | "waiting_for_delegation" | "no_response";
    publishedUserVisibleEvent: boolean;
    finalEventIds: string[];
    pendingDelegations: string[];
    pendingDelegationsRemain: boolean;
    keepWorkerWarm: boolean;
}

export interface AgentWorkerBootstrapDependencies {
    createAgentRegistry?: (projectBasePath: string, metadataPath: string) => AgentRegistry;
    createMcpManager?: () => MCPManager;
    createExecutor?: (
        options: ConstructorParameters<typeof AgentExecutor>[0]
    ) => AgentWorkerExecutor;
    publishResults?: Parameters<typeof createWorkerProtocolPublisherFactory>[0]["publishResults"];
    telegramSendResults?: TelegramSendResultSource;
}

export async function executeAgentWorkerRequest(
    message: ExecuteMessage,
    emit: AgentWorkerProtocolEmit,
    dependencies: AgentWorkerBootstrapDependencies = {}
): Promise<AgentWorkerExecutionResult> {
    await config.loadConfig(message.metadataPath);
    await fs.mkdir(config.getConfigPath("daemon"), { recursive: true });
    await fs.mkdir(path.join(message.metadataPath, "conversations"), { recursive: true });
    await fs.mkdir(path.join(message.metadataPath, "logs"), { recursive: true });

    const project = await buildWorkerProject(message);
    const agentRegistry =
        dependencies.createAgentRegistry?.(message.projectBasePath, message.metadataPath) ??
        new AgentRegistry(message.projectBasePath, message.metadataPath);
    await agentRegistry.loadFromProject(project, { publishProfiles: false });

    const agent = agentRegistry.getAgentByPubkey(message.agentPubkey);
    if (!agent) {
        throw new AgentWorkerExecutionFailure(
            "missing_agent",
            "Agent was not found in shared filesystem state",
            false
        );
    }

    const projectContext = new ProjectContext(project, agentRegistry);
    const mcpManager = dependencies.createMcpManager?.() ?? new MCPManager();
    projectContext.mcpManager = mcpManager;

    const agentPubkeys = Array.from(projectContext.agents.values()).map(
        (candidate) => candidate.pubkey
    );
    ConversationStore.initialize(message.metadataPath, agentPubkeys);
    const conversationCatalog = ConversationCatalogService.getInstance(
        createProjectDTag(message.projectId),
        message.metadataPath,
        agentPubkeys
    );
    conversationCatalog.initialize();
    conversationCatalog.reconcile();

    await mcpManager.initialize(message.metadataPath, message.projectBasePath);

    const publisherExecutionState: WorkerProtocolPublisherExecutionState = {
        silentCompletionRequested: false,
    };
    const executorOptions: ConstructorParameters<typeof AgentExecutor>[0] = {
        publisherFactory: createWorkerProtocolPublisherFactory({
            emit,
            execution: message,
            executionState: publisherExecutionState,
            publishResults: dependencies.publishResults,
        }),
    };
    const executor =
        dependencies.createExecutor?.(executorOptions) ?? new AgentExecutor(executorOptions);

    let telegramSendRequestCounter = 0;
    const telegramBridge = dependencies.telegramSendResults
        ? new WorkerTelegramSendBridge({
              emit,
              correlationId: message.correlationId,
              nextRequestCorrelationId: () => {
                  telegramSendRequestCounter += 1;
                  return `${message.correlationId}:tg-send:${telegramSendRequestCounter}`;
              },
              results: dependencies.telegramSendResults,
          })
        : undefined;
    setActiveTelegramSendBridge(telegramBridge);

    try {
        return await projectContextStore.run(projectContext, async () => {
            await ensureTriggeringEnvelopeStored(message);
            const workerRalClaim = seedWorkerRalBridge(message);

            await emit({
                type: "execution_started",
                correlationId: message.correlationId,
                ...executionIdentity(message),
            });

            const executionContext = await createExecutionContext({
                agent,
                conversationId: message.conversationId,
                projectBasePath: message.projectBasePath,
                triggeringEnvelope: message.triggeringEnvelope,
                isDelegationCompletion: message.executionFlags.isDelegationCompletion,
                hasPendingDelegations: message.executionFlags.hasPendingDelegations,
                debug: message.executionFlags.debug,
                mcpManager,
            });
            if (workerRalClaim) {
                executionContext.preferredRalNumber = workerRalClaim.ralNumber;
                executionContext.preferredRalClaimToken = workerRalClaim.claimToken;
            }

            const response = await executor.execute(executionContext);
            const outstandingWork = RALRegistry.getInstance().hasOutstandingWork(
                message.agentPubkey,
                message.conversationId,
                message.ralNumber
            );
            const pendingDelegations = RALRegistry.getInstance()
                .getConversationPendingDelegations(
                    message.agentPubkey,
                    message.conversationId,
                    message.ralNumber
                )
                .map((delegation) => delegation.delegationConversationId);
            const pendingDelegationsRemain =
                outstandingWork.details.pendingDelegations > 0 || pendingDelegations.length > 0;

            return {
                finalRalState: pendingDelegationsRemain
                    ? "waiting_for_delegation"
                    : !response &&
                        publisherExecutionState.silentCompletionRequested &&
                        !outstandingWork.hasWork
                      ? "no_response"
                      : "completed",
                publishedUserVisibleEvent: Boolean(response),
                finalEventIds: response ? [response.id] : [],
                pendingDelegations,
                pendingDelegationsRemain,
                keepWorkerWarm: false,
            };
        });
    } finally {
        setActiveTelegramSendBridge(undefined);
        await mcpManager.shutdown();
        await ConversationStore.cleanup();
        ConversationCatalogService.closeProject(
            createProjectDTag(message.projectId),
            message.metadataPath
        );
    }
}

function seedWorkerRalBridge(
    message: ExecuteMessage
): { ralNumber: number; claimToken: string } | undefined {
    if (message.ralNumber === 1) {
        return undefined;
    }

    const ralRegistry = RALRegistry.getInstance();
    ralRegistry.seed({
        agentPubkey: message.agentPubkey,
        conversationId: message.conversationId,
        projectId: createProjectDTag(message.projectId),
        ralNumber: message.ralNumber,
        originalTriggeringEventId: message.triggeringEnvelope.message.nativeId,
        executionClaimToken: message.ralClaimToken,
    });
    ralRegistry.queueUserMessage(
        message.agentPubkey,
        message.conversationId,
        message.ralNumber,
        message.triggeringEnvelope.content,
        {
            senderPubkey: message.triggeringEnvelope.principal.linkedPubkey,
            senderPrincipal: message.triggeringEnvelope.principal,
            targetedPrincipals: message.triggeringEnvelope.recipients,
            eventId: message.triggeringEnvelope.message.nativeId,
        }
    );

    return {
        ralNumber: message.ralNumber,
        claimToken: message.ralClaimToken,
    };
}

async function ensureTriggeringEnvelopeStored(message: ExecuteMessage): Promise<void> {
    const conversation = ConversationStore.getOrLoad(message.conversationId);
    if (conversation.hasEventId(message.triggeringEnvelope.message.nativeId)) {
        return;
    }

    await ConversationStore.addEnvelope(message.conversationId, message.triggeringEnvelope);
}

async function buildWorkerProject(message: ExecuteMessage): Promise<NDKProject> {
    const project = new NDKProject(undefined as never);
    const ownerPubkey = resolveProjectOwnerPubkey(message);
    const projectAgentPubkeys = await readProjectAgentPubkeys(message);
    project.pubkey = ownerPubkey;
    project.dTag = message.projectId;
    project.tags = [
        ["d", message.projectId],
        ["title", message.projectId],
        ...projectAgentPubkeys.map((pubkey) => [
            "p",
            pubkey,
            pubkey === message.agentPubkey ? "pm" : "agent",
        ]),
    ];
    return project;
}

async function readProjectAgentPubkeys(message: ExecuteMessage): Promise<string[]> {
    const tenexBasePath = path.dirname(path.dirname(message.metadataPath));
    const indexPath = path.join(tenexBasePath, "agents", "index.json");

    try {
        const rawIndex = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
            byProject?: Record<string, unknown>;
        };
        const projectPubkeys = rawIndex.byProject?.[message.projectId];
        const pubkeys = Array.isArray(projectPubkeys)
            ? projectPubkeys.filter((pubkey): pubkey is string => isHexPubkey(pubkey))
            : [];

        return Array.from(new Set([message.agentPubkey, ...pubkeys]));
    } catch {
        return [message.agentPubkey];
    }
}

function resolveProjectOwnerPubkey(message: ExecuteMessage): string {
    const projectBinding = message.triggeringEnvelope.channel.projectBinding;
    if (projectBinding) {
        const parts = projectBinding.split(":");
        if (parts.length >= 3 && /^[0-9a-f]{64}$/.test(parts[1])) {
            return parts[1];
        }
    }

    const principalPubkey = message.triggeringEnvelope.principal.linkedPubkey;
    if (principalPubkey && /^[0-9a-f]{64}$/.test(principalPubkey)) {
        return principalPubkey;
    }

    return "0".repeat(64);
}

function isHexPubkey(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function executionIdentity(message: ExecuteMessage): {
    projectId: string;
    agentPubkey: string;
    conversationId: string;
    ralNumber: number;
} {
    return {
        projectId: message.projectId,
        agentPubkey: message.agentPubkey,
        conversationId: message.conversationId,
        ralNumber: message.ralNumber,
    };
}
