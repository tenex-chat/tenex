import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry } from "@/agents/AgentRegistry";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { createExecutionContext } from "@/agents/execution/ExecutionContextFactory";
import { resolveCategory } from "@/agents/role-categories";
import { processAgentTools } from "@/agents/tool-normalization";
import type { AgentInstance } from "@/agents/types";
import { ConversationCatalogService } from "@/conversations/ConversationCatalogService";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { AgentWorkerProtocolMessage } from "@/events/runtime/AgentWorkerProtocol";
import { DEFAULT_AGENT_LLM_CONFIG } from "@/llm/constants";
import { AgentMetadataStore } from "@/services/agents";
import { config } from "@/services/ConfigService";
import { MCPManager } from "@/services/mcp/MCPManager";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import { NDKPrivateKeySigner, NDKProject, type NDKEvent } from "@nostr-dev-kit/ndk";
import {
    createWorkerProtocolPublisherFactory,
    type WorkerProtocolPublisherExecutionState,
} from "./publisher-bridge";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type AgentWorkerExecutor = Pick<AgentExecutor, "execute">;

export interface ProjectScope {
    projectContext: ProjectContext;
    mcpManager: MCPManager;
    agentRegistry: AgentRegistry;
    projectId: string;
    projectDTag: ProjectDTag;
    metadataPath: string;
    projectBasePath: string;
}

export interface ProjectScopeBootstrapResult {
    scope: ProjectScope;
    cleanup: () => Promise<void>;
}

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
}

export async function bootstrapProjectScope(
    message: ExecuteMessage,
    dependencies: AgentWorkerBootstrapDependencies = {}
): Promise<ProjectScopeBootstrapResult> {
    await config.loadConfig(message.metadataPath);
    await fs.mkdir(config.getConfigPath("daemon"), { recursive: true });
    await fs.mkdir(path.join(message.metadataPath, "conversations"), { recursive: true });
    await fs.mkdir(path.join(message.metadataPath, "logs"), { recursive: true });

    const projectAgentPubkeys = message.projectAgentInventory
        ? message.projectAgentInventory.map((entry) => entry.pubkey)
        : [message.agentPubkey];
    const project = buildWorkerProjectFromInventory(message, projectAgentPubkeys);
    const agentRegistry =
        dependencies.createAgentRegistry?.(message.projectBasePath, message.metadataPath) ??
        new AgentRegistry(message.projectBasePath, message.metadataPath);
    // Project context is built from the inventory only — no agent storage
    // disk reads. The executing AgentInstance is materialized in
    // runOneExecution from the inline `agent` payload; placeholder
    // AgentInstances for the rest of the inventory are added during
    // reconcileProjectAgentInventory on the first execute.
    const projectContext = new ProjectContext(project, agentRegistry);
    const mcpManager = dependencies.createMcpManager?.() ?? new MCPManager();

    const projectDTag = createProjectDTag(message.projectId);
    ConversationStore.initialize(message.metadataPath, projectAgentPubkeys);
    const conversationCatalog = ConversationCatalogService.getInstance(
        projectDTag,
        message.metadataPath,
        projectAgentPubkeys
    );
    conversationCatalog.initialize();
    conversationCatalog.reconcile();

    await mcpManager.initialize(message.metadataPath, message.projectBasePath);

    return {
        scope: {
            projectContext,
            mcpManager,
            agentRegistry,
            projectId: message.projectId,
            projectDTag,
            metadataPath: message.metadataPath,
            projectBasePath: message.projectBasePath,
        },
        cleanup: async () => {
            await mcpManager.shutdown();
            await ConversationStore.cleanup();
            ConversationCatalogService.closeProject(projectDTag, message.metadataPath);
        },
    };
}

export async function runOneExecution(
    message: ExecuteMessage,
    scope: ProjectScope,
    emit: AgentWorkerProtocolEmit,
    dependencies: AgentWorkerBootstrapDependencies = {}
): Promise<AgentWorkerExecutionResult> {
    // Reconcile project agent inventory if the daemon supplied one.
    // This makes ProjectContext.agents reflect the daemon's authoritative
    // view at dispatch time without requiring the worker to read agent
    // storage from disk.
    if (message.projectAgentInventory && message.projectAgentInventory.length > 0) {
        reconcileProjectAgentInventory(scope, message.projectAgentInventory);
    }

    if (!message.agent) {
        throw new AgentWorkerExecutionFailure(
            "missing_inline_agent",
            "execute message did not include an inline `agent` payload; the daemon must populate it",
            false
        );
    }
    const agent = materializeInlineAgent(message.agent, scope, scope.projectDTag);
    if (!scope.agentRegistry.getAgentByPubkey(agent.pubkey)) {
        scope.agentRegistry.addAgent(agent);
    }

    const publisherExecutionState: WorkerProtocolPublisherExecutionState = {
        silentCompletionRequested: false,
    };
    const executorOptions: ConstructorParameters<typeof AgentExecutor>[0] = {
        publisherFactory: createWorkerProtocolPublisherFactory({
            emit,
            execution: message,
            executionState: publisherExecutionState,
            projectContext: scope.projectContext,
        }),
    };
    const executor =
        dependencies.createExecutor?.(executorOptions) ?? new AgentExecutor(executorOptions);

    return await projectContextStore.run(scope.projectContext, async () => {
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
            projectContext: scope.projectContext,
            projectBasePath: scope.projectBasePath,
            triggeringEnvelope: message.triggeringEnvelope,
            isDelegationCompletion: message.executionFlags.isDelegationCompletion,
            hasPendingDelegations: message.executionFlags.hasPendingDelegations,
            debug: message.executionFlags.debug,
            mcpManager: scope.mcpManager,
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
        const registryPendingDelegations = RALRegistry.getInstance()
            .getConversationPendingDelegations(
                message.agentPubkey,
                message.conversationId,
                message.ralNumber
            )
            .map((delegation) => delegation.delegationConversationId);
        const pendingDelegations =
            registryPendingDelegations.length > 0
                ? registryPendingDelegations
                : (message.executionFlags.pendingDelegationIds ?? []);
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
}

export async function executeAgentWorkerRequest(
    message: ExecuteMessage,
    emit: AgentWorkerProtocolEmit,
    dependencies: AgentWorkerBootstrapDependencies = {}
): Promise<AgentWorkerExecutionResult> {
    const { scope, cleanup } = await bootstrapProjectScope(message, dependencies);
    try {
        return await runOneExecution(message, scope, emit, dependencies);
    } finally {
        await cleanup();
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

function buildWorkerProjectFromInventory(
    message: ExecuteMessage,
    projectAgentPubkeys: readonly string[]
): NDKProject {
    const project = new NDKProject(undefined as never);
    const ownerPubkey = resolveProjectOwnerPubkey(message);
    project.pubkey = ownerPubkey;
    project.dTag = message.projectId;
    // PM designation: the executing agent is marked PM if the inventory says so.
    const pmPubkey = message.projectAgentInventory?.find((entry) => entry.isPM)?.pubkey;
    project.tags = [
        ["d", message.projectId],
        ["title", message.projectId],
        ...projectAgentPubkeys.map((pubkey) => [
            "p",
            pubkey,
            pubkey === pmPubkey ? "pm" : "agent",
        ]),
    ];
    return project;
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

type InlineAgent = NonNullable<ExecuteMessage["agent"]>;
type ProjectAgentInventoryEntry = NonNullable<ExecuteMessage["projectAgentInventory"]>[number];

/**
 * Materialize an executing AgentInstance from the inline payload that the
 * Rust daemon ships on `execute`. Bypasses the disk-backed AgentRegistry
 * load path so the worker stays stateless w.r.t. agent config.
 */
function materializeInlineAgent(
    inline: InlineAgent,
    scope: ProjectScope,
    projectDTag: string | undefined
): AgentInstance {
    const signer = new NDKPrivateKeySigner(inline.signingPrivateKey);
    const pubkey = signer.pubkey;
    const resolvedCategory = resolveCategory(inline.category);
    const tools = processAgentTools(inline.tools ?? [], resolvedCategory);
    const llmConfigName = inline.llmConfig ?? DEFAULT_AGENT_LLM_CONFIG;
    const metadataPath = scope.metadataPath;
    const projectBasePath = scope.projectBasePath;

    const agent: AgentInstance = {
        name: inline.name,
        pubkey,
        signer,
        role: inline.role,
        category: resolvedCategory,
        description: inline.description,
        instructions: inline.instructions,
        customInstructions: inline.customInstructions,
        useCriteria: inline.useCriteria,
        llmConfig: llmConfigName,
        tools,
        eventId: inline.eventId,
        slug: inline.slug,
        mcpServers: inline.mcpServers as AgentInstance["mcpServers"],
        pmOverrides: inline.pmOverrides,
        isPM: inline.isPM,
        alwaysSkills:
            inline.alwaysSkills && inline.alwaysSkills.length > 0
                ? inline.alwaysSkills
                : undefined,
        blockedSkills: inline.blockedSkills,
        mcpAccess: inline.mcpAccess ?? [],
        createMetadataStore: (conversationId: string) =>
            new AgentMetadataStore(conversationId, inline.slug, metadataPath),
        createLLMService: (options) =>
            config.createLLMService(options?.resolvedConfigName ?? llmConfigName, {
                tools: options?.tools ?? {},
                agentName: inline.name,
                agentSlug: inline.slug,
                agentId: pubkey,
                workingDirectory: options?.workingDirectory ?? projectBasePath,
                mcpConfig: options?.mcpConfig,
                conversationId: options?.conversationId,
                projectId: projectDTag,
                onStreamStart: options?.onStreamStart,
            }),
        sign: async (event: NDKEvent) => {
            await event.sign(signer, { pTags: false });
        },
    };

    return agent;
}

/**
 * Reconcile ProjectContext.agents against the daemon's authoritative
 * inventory. Adds discovery-only placeholders for inventory entries not
 * already known to the registry; existing entries (including the
 * executing agent's full record) are kept intact.
 */
function reconcileProjectAgentInventory(
    scope: ProjectScope,
    inventory: readonly ProjectAgentInventoryEntry[]
): void {
    for (const entry of inventory) {
        if (scope.agentRegistry.getAgentByPubkey(entry.pubkey)) {
            continue;
        }
        const placeholderSigner = NDKPrivateKeySigner.generate();
        const metadataPath = scope.metadataPath;
        const placeholder: AgentInstance = {
            name: entry.name,
            pubkey: entry.pubkey,
            // Placeholder signer — never used because placeholder agents are
            // never the executing agent (the executing agent always arrives
            // via execute.agent with its real signer).
            signer: placeholderSigner,
            role: entry.role ?? entry.slug,
            slug: entry.slug,
            isPM: entry.isPM,
            llmConfig: DEFAULT_AGENT_LLM_CONFIG,
            tools: [],
            mcpAccess: [],
            createMetadataStore: (conversationId: string) =>
                new AgentMetadataStore(conversationId, entry.slug, metadataPath),
            createLLMService: () => {
                throw new Error(
                    `placeholder agent ${entry.slug} has no LLM service; only the executing agent should run an LLM`
                );
            },
            sign: async () => {
                throw new Error(
                    `placeholder agent ${entry.slug} cannot sign events; only the executing agent has a real signer`
                );
            },
        };
        scope.agentRegistry.addAgent(placeholder);
    }
}
