import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry, type ProjectAgentInfo } from "@/agents/AgentRegistry";
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
import { initNDK } from "@/nostr/ndkClient";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RALRegistry } from "@/services/ral";
import { DelegationJournalReader } from "@/services/ral/DelegationJournalReader";
import { createProjectDTag, type ProjectDTag } from "@/types/project-ids";
import { NDKPrivateKeySigner, NDKProject, type NDKEvent } from "@nostr-dev-kit/ndk";
import {
    createWorkerProtocolPublisherFactory,
    PublishResultCoordinator,
    type WorkerProtocolPublisherExecutionState,
} from "./publisher-bridge";
import type { AgentWorkerProtocolEmit } from "./protocol-emitter";

type ExecuteMessage = Extract<AgentWorkerProtocolMessage, { type: "execute" }>;
type AgentWorkerExecutor = Pick<AgentExecutor, "execute">;

const placeholderAgents = new WeakSet<AgentInstance>();
const activeMaterializedAgentPubkeys = new WeakMap<AgentRegistry, Map<string, number>>();

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
    await initNDK();
    await fs.mkdir(config.getConfigPath("daemon"), { recursive: true });
    await fs.mkdir(path.join(message.metadataPath, "conversations"), { recursive: true });
    await fs.mkdir(path.join(message.metadataPath, "logs"), { recursive: true });

    const projectAgentPubkeys = message.projectAgentInventory
        ? message.projectAgentInventory.map((entry) => entry.pubkey)
        : [message.agentPubkey];
    const project = buildWorkerProjectFromInventory(message, projectAgentPubkeys);
    const agentRegistry = new AgentRegistry(message.projectBasePath, message.metadataPath);
    // Project context is built from the inventory only — no agent storage
    // disk reads. The executing AgentInstance is materialized in
    // runOneExecution from the `agent` payload; placeholder
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
    publishResultCoordinator: PublishResultCoordinator,
    dependencies: AgentWorkerBootstrapDependencies = {}
): Promise<AgentWorkerExecutionResult> {
    if (!message.agent) {
        throw new AgentWorkerExecutionFailure(
            "missing_agent",
            "execute message did not include an `agent` payload; the daemon must populate it",
            false
        );
    }
    const agent = materializeAgent(message.agent, scope, scope.projectDTag);
    const releaseActiveAgent = markMaterializedAgentActive(scope.agentRegistry, agent.pubkey);
    upsertRegistryAgent(scope.agentRegistry, agent);

    try {
        // Reconcile project agent inventory if the daemon supplied one.
        // This makes ProjectContext.agents reflect the daemon's authoritative
        // view at dispatch time without requiring the worker to read agent
        // storage from disk.
        if (message.projectAgentInventory && message.projectAgentInventory.length > 0) {
            reconcileProjectAgentInventory(scope, message.projectAgentInventory);
        }

        return await runMaterializedExecution(
            message,
            scope,
            agent,
            emit,
            publishResultCoordinator,
            dependencies
        );
    } finally {
        releaseActiveAgent();
    }
}

async function runMaterializedExecution(
    message: ExecuteMessage,
    scope: ProjectScope,
    agent: AgentInstance,
    emit: AgentWorkerProtocolEmit,
    publishResultCoordinator: PublishResultCoordinator,
    dependencies: AgentWorkerBootstrapDependencies
): Promise<AgentWorkerExecutionResult> {
    const publisherExecutionState: WorkerProtocolPublisherExecutionState = {
        silentCompletionRequested: false,
    };
    const executorOptions: ConstructorParameters<typeof AgentExecutor>[0] = {
        publisherFactory: createWorkerProtocolPublisherFactory({
            emit,
            execution: message,
            executionState: publisherExecutionState,
            projectContext: scope.projectContext,
            publishResultCoordinator,
        }),
    };
    const executor =
        dependencies.createExecutor?.(executorOptions) ?? new AgentExecutor(executorOptions);

    return await projectContextStore.run(scope.projectContext, async () => {
        await ensureTriggeringEnvelopeStored(message);
        const workerRalClaim = seedWorkerRalBridge(message);
        seedDelegationSnapshotOverlay(message);

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
        // delegationSnapshot is loaded at worker-admission time, so it reflects completions
        // that arrived between dispatch creation and startup. pendingDelegationIds in the flags
        // is stale (set at dispatch-creation time); using it as a fallback when the snapshot
        // is present would keep the worker in waiting_for_delegation for already-completed delegations.
        const pendingDelegations =
            registryPendingDelegations.length > 0
                ? registryPendingDelegations
                : message.delegationSnapshot
                  ? []
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
            keepWorkerWarm: true,
        };
    });
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

/**
 * Push the daemon-supplied delegationSnapshot into the in-process
 * DelegationJournalReader overlay so the system reminder builder sees
 * pending and completed delegations for the resuming agent. Without this,
 * a parent agent that resumes after a delegation completes has empty
 * delegation state — the `<delegations>` system reminder never fires —
 * and the agent re-runs its initial logic instead of producing a final
 * answer.
 *
 * The Rust daemon ships the authoritative snapshot in every execute
 * message; the worker journal reader consumes it as a session-local
 * overlay (it is not persisted to the file-backed journal because the
 * daemon already owns that).
 */
function seedDelegationSnapshotOverlay(message: ExecuteMessage): void {
    const snapshot = message.delegationSnapshot;
    if (!snapshot) {
        return;
    }
    const reader = DelegationJournalReader.getInstance();
    const projectId = message.projectId;
    const agentPubkey = message.agentPubkey;
    const conversationId = message.conversationId;
    const ralNumber = message.ralNumber;

    for (const pending of snapshot.pendingDelegations ?? []) {
        reader.appendOverlay({
            event: "delegation_registered",
            projectId,
            agentPubkey,
            conversationId,
            ralNumber,
            pendingDelegation: pending,
        });
    }
    for (const completed of snapshot.completedDelegations ?? []) {
        reader.appendOverlay({
            event: "delegation_completed",
            projectId,
            agentPubkey,
            conversationId,
            ralNumber,
            completion: completed,
        });
    }
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

type AgentExecuteFields = NonNullable<ExecuteMessage["agent"]>;
type ProjectAgentInventoryEntry = NonNullable<ExecuteMessage["projectAgentInventory"]>[number];

/**
 * Materialize an executing AgentInstance from the agent payload that the
 * Rust daemon ships on `execute`. Bypasses the disk-backed AgentRegistry
 * load path so the worker stays stateless w.r.t. agent config.
 */
function materializeAgent(
    agentFields: AgentExecuteFields,
    scope: ProjectScope,
    projectDTag: string | undefined
): AgentInstance {
    const signer = new NDKPrivateKeySigner(agentFields.signingPrivateKey);
    const pubkey = signer.pubkey;
    const resolvedCategory = resolveCategory(agentFields.category) ?? resolveCategory(agentFields.inferredCategory);
    const tools = processAgentTools(agentFields.tools ?? [], resolvedCategory);
    const llmConfigName = agentFields.llmConfig ?? DEFAULT_AGENT_LLM_CONFIG;
    const metadataPath = scope.metadataPath;
    const projectBasePath = scope.projectBasePath;

    // Skill blocking: filter alwaysSkills against blockedSkills. The disk
    // path uses SkillService.listAvailableSkills + buildSkillAliasMap to
    // expand aliases (e.g. recall@1.2.3 against recall). The worker path
    // can't do alias-aware blocking without a disk read, so we do
    // exact-match blocking here. The daemon ships agent.default.skills
    // pre-filtered against agent.default.blockedSkills in agent storage,
    // but a misconfigured agent may still have an overlap and we don't
    // want to surface a blocked skill at runtime.
    const blockedSkillSet = new Set(agentFields.blockedSkills ?? []);
    const alwaysSkillsCandidates = (agentFields.alwaysSkills ?? []).filter(
        (skill) => !blockedSkillSet.has(skill)
    );
    const alwaysSkills =
        alwaysSkillsCandidates.length > 0 ? alwaysSkillsCandidates : undefined;

    const agent: AgentInstance = {
        name: agentFields.name,
        pubkey,
        signer,
        role: agentFields.role,
        category: resolvedCategory,
        description: agentFields.description,
        instructions: agentFields.instructions,
        customInstructions: agentFields.customInstructions,
        useCriteria: agentFields.useCriteria,
        llmConfig: llmConfigName,
        tools,
        eventId: agentFields.eventId,
        slug: agentFields.slug,
        useAISDKAgent: agentFields.useAISDKAgent,
        mcpServers: agentFields.mcpServers as AgentInstance["mcpServers"],
        pmOverrides: agentFields.pmOverrides,
        isPM: agentFields.isPM,
        telegram: agentFields.telegram as AgentInstance["telegram"],
        alwaysSkills,
        blockedSkills: agentFields.blockedSkills,
        mcpAccess: agentFields.mcpAccess ?? [],
        createMetadataStore: (conversationId: string) =>
            new AgentMetadataStore(conversationId, agentFields.slug, metadataPath),
        createLLMService: (options) =>
            config.createLLMService(options?.resolvedConfigName ?? llmConfigName, {
                tools: options?.tools ?? {},
                agentName: agentFields.name,
                agentSlug: agentFields.slug,
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
 * Reconcile ProjectContext.agents against the daemon's authoritative inventory.
 * Inventory entries that do not have a materialized runtime instance are held as
 * discovery-only placeholders. Active materialized agents are never replaced by
 * placeholders, and stale inactive entries are removed from the in-memory
 * project registry.
 */
function reconcileProjectAgentInventory(
    scope: ProjectScope,
    inventory: readonly ProjectAgentInventoryEntry[]
): void {
    syncProjectTagsFromInventory(scope, inventory);

    const inventoryPubkeys = new Set(inventory.map((entry) => entry.pubkey));
    for (const agent of scope.agentRegistry.getAllAgents()) {
        if (inventoryPubkeys.has(agent.pubkey)) {
            continue;
        }
        if (isActiveMaterializedAgent(scope.agentRegistry, agent.pubkey)) {
            continue;
        }
        removeRegistryAgent(scope.agentRegistry, agent);
    }

    for (const entry of inventory) {
        const existing = scope.agentRegistry.getAgentByPubkey(entry.pubkey);
        if (existing && !placeholderAgents.has(existing)) {
            updateProjectAgentInfo(scope.agentRegistry, entry);
            continue;
        }
        upsertRegistryAgent(
            scope.agentRegistry,
            createPlaceholderAgent(entry, scope.metadataPath)
        );
    }
}

function createPlaceholderAgent(
    entry: ProjectAgentInventoryEntry,
    metadataPath: string
): AgentInstance {
    const placeholderSigner = NDKPrivateKeySigner.generate();
    const placeholder: AgentInstance = {
        name: entry.name,
        pubkey: entry.pubkey,
        // Placeholder signer — never used because placeholder agents are
        // never the executing agent (the executing agent always arrives
        // via execute.agent with its real signer).
        signer: placeholderSigner,
        role: entry.role ?? entry.slug,
        category: resolveCategory(entry.category),
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
    placeholderAgents.add(placeholder);
    return placeholder;
}

function syncProjectTagsFromInventory(
    scope: ProjectScope,
    inventory: readonly ProjectAgentInventoryEntry[]
): void {
    scope.projectContext.project.tags = [
        ["d", scope.projectId],
        ["title", scope.projectId],
        ...inventory.map((entry) => [
            "p",
            entry.pubkey,
            entry.isPM ? "pm" : "agent",
        ]),
    ];
}

function upsertRegistryAgent(registry: AgentRegistry, agent: AgentInstance): void {
    registry.upsertAgent(agent);
}

function removeRegistryAgent(registry: AgentRegistry, agent: AgentInstance): void {
    registry.removeAgentFromMemory(agent.pubkey);
}

function updateProjectAgentInfo(
    registry: AgentRegistry,
    entry: ProjectAgentInventoryEntry
): void {
    registry.setProjectAgentInfo(projectAgentInfoFromEntry(entry));
}

function projectAgentInfoFromEntry(entry: ProjectAgentInventoryEntry): ProjectAgentInfo {
    return {
        pubkey: entry.pubkey,
        slug: entry.slug,
        name: entry.name,
        role: entry.role ?? entry.slug,
        category: resolveCategory(entry.category),
    };
}

function markMaterializedAgentActive(registry: AgentRegistry, pubkey: string): () => void {
    let counts = activeMaterializedAgentPubkeys.get(registry);
    if (!counts) {
        counts = new Map();
        activeMaterializedAgentPubkeys.set(registry, counts);
    }
    counts.set(pubkey, (counts.get(pubkey) ?? 0) + 1);

    return () => {
        const current = counts.get(pubkey) ?? 0;
        if (current <= 1) {
            counts.delete(pubkey);
            return;
        }
        counts.set(pubkey, current - 1);
    };
}

function isActiveMaterializedAgent(registry: AgentRegistry, pubkey: string): boolean {
    return (activeMaterializedAgentPubkeys.get(registry)?.get(pubkey) ?? 0) > 0;
}
