import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { ConversationRecord } from "@/conversations/types";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { buildLegacyEventSnapshot } from "@/events/runtime/legacy-event-snapshot";
import { LocalInboundAdapter } from "@/events/runtime/LocalInboundAdapter";
import {
    RuntimePublishCollector,
    createRecordingRuntimePublisherFactory,
    type PublishedRuntimeRecord,
} from "@/events/runtime/RecordingRuntimePublisher";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";
import { AgentMetadataStore } from "@/services/agents/AgentMetadataStore";
import { config } from "@/services/ConfigService";
import { RuntimeIngressService } from "@/services/ingress/RuntimeIngressService";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RAGService } from "@/services/rag/RAGService";
import { RALRegistry } from "@/services/ral";
import type { AISdkTool } from "@/tools/types";
import { initializeGitRepository } from "@/utils/git";
import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

type ChatTransport = "local" | "nostr";
type LocalPrincipalMode = "linked" | "transport-only";

const SESSION_STATE_VERSION = 1;
const SESSION_STATE_FILENAME = "transport-chat-session.json";

interface TransportChatSessionState {
    version: typeof SESSION_STATE_VERSION;
    transport: ChatTransport;
    principalMode?: LocalPrincipalMode;
    useMockLLM: boolean;
    sessionRoot: string;
    projectPath: string;
    metadataPath: string;
    artifactsPath: string;
    tenexBasePath?: string;
    projectDTag: string;
    projectTitle: string;
    agentSlug: string;
    agentNsec: string;
    userNsec: string;
    turnCount: number;
    lastInboundMessageId?: string;
    conversationId?: string;
}

interface TransportChatArtifact {
    transport: ChatTransport;
    principalMode?: LocalPrincipalMode;
    useMockLLM: boolean;
    sessionRoot: string;
    statePath: string;
    artifactPath: string;
    projectPath: string;
    metadataPath: string;
    turnNumber: number;
    conversationId: string;
    canonicalEnvelope: InboundEnvelope;
    legacyEvent: {
        id: string;
        pubkey: string;
        content: string;
        tags: string[][];
    };
    response: {
        content: string;
        completionRecord?: PublishedRuntimeRecord;
    };
    conversationMessages: Array<{
        role?: string;
        messageType: string;
        pubkey: string;
        content: string;
        eventId?: string;
        senderPrincipalId?: string;
        senderLinkedPubkey?: string;
        targetedPrincipalIds?: string[];
        targetedLinkedPubkeys?: string[];
    }>;
    publishedRecords: PublishedRuntimeRecord[];
    validations: {
        conversationResolved: boolean;
        replyCaptured: boolean;
        completionIntentRecorded: boolean;
        completionRecipientPrincipalMatchesEnvelope: boolean;
        completionRecipientPubkeyMatchesPrincipalIdentity: boolean;
        followupLinkedToPreviousInbound: boolean;
    };
}

interface PreparedHarness {
    state: TransportChatSessionState;
    runtimeIngressService: RuntimeIngressService;
    nostrInboundAdapter: NostrInboundAdapter;
    localInboundAdapter: LocalInboundAdapter;
    projectContext: ProjectContext;
    agentPubkey: string;
    userPubkey: string;
}

function sessionStatePath(sessionRoot: string): string {
    return join(sessionRoot, SESSION_STATE_FILENAME);
}

function readSessionState(sessionRoot: string): TransportChatSessionState | undefined {
    const statePath = sessionStatePath(sessionRoot);
    if (!existsSync(statePath)) {
        return undefined;
    }

    return JSON.parse(readFileSync(statePath, "utf8")) as TransportChatSessionState;
}

function writeSessionState(state: TransportChatSessionState): void {
    writeFileSync(
        sessionStatePath(state.sessionRoot),
        `${JSON.stringify(state, null, 2)}\n`
    );
}

function ensureMockConfig(basePath: string): void {
    mkdirSync(basePath, { recursive: true });
    writeFileSync(
        join(basePath, "config.json"),
        `${JSON.stringify({
            whitelistedPubkeys: [],
            logging: { level: "error" },
            telemetry: { enabled: false },
        }, null, 2)}\n`
    );
    writeFileSync(
        join(basePath, "providers.json"),
        `${JSON.stringify({ providers: {} }, null, 2)}\n`
    );
    writeFileSync(
        join(basePath, "llms.json"),
        `${JSON.stringify({ configurations: {} }, null, 2)}\n`
    );
}

function createSessionState(
    sessionRoot: string,
    transport: ChatTransport,
    principalMode: LocalPrincipalMode,
    useMockLLM: boolean
): TransportChatSessionState {
    const agentSigner = NDKPrivateKeySigner.generate();
    const userSigner = NDKPrivateKeySigner.generate();

    if (!agentSigner.nsec || !userSigner.nsec) {
        throw new Error("Failed to generate signer identities for transport chat session");
    }

    const state: TransportChatSessionState = {
        version: SESSION_STATE_VERSION,
        transport,
        principalMode: transport === "local" ? principalMode : undefined,
        useMockLLM,
        sessionRoot,
        projectPath: join(sessionRoot, "project"),
        metadataPath: join(sessionRoot, "metadata"),
        artifactsPath: join(sessionRoot, "artifacts"),
        tenexBasePath: useMockLLM ? join(sessionRoot, "tenex-home") : undefined,
        projectDTag: "transport-chat-project",
        projectTitle: "Transport Chat Project",
        agentSlug: "transport-chat-agent",
        agentNsec: agentSigner.nsec,
        userNsec: userSigner.nsec,
        turnCount: 0,
    };

    mkdirSync(state.projectPath, { recursive: true });
    mkdirSync(join(state.metadataPath, "conversations"), { recursive: true });
    mkdirSync(state.artifactsPath, { recursive: true });

    if (state.tenexBasePath) {
        ensureMockConfig(state.tenexBasePath);
    }

    writeSessionState(state);
    return state;
}

function assertSessionCompatibility(
    state: TransportChatSessionState,
    transport: ChatTransport,
    principalMode: LocalPrincipalMode,
    useMockLLM: boolean
): void {
    if (state.version !== SESSION_STATE_VERSION) {
        throw new Error(
            `Session format mismatch (found ${state.version}, expected ${SESSION_STATE_VERSION}). Re-run with --reset.`
        );
    }

    if (state.transport !== transport) {
        throw new Error(
            `Session transport mismatch (state=${state.transport}, requested=${transport}). Re-run with --reset or use a different --session-root.`
        );
    }

    if ((state.principalMode ?? "linked") !== principalMode && transport === "local") {
        throw new Error(
            `Session principal mode mismatch (state=${state.principalMode ?? "linked"}, requested=${principalMode}). Re-run with --reset or use a different --session-root.`
        );
    }

    if (state.useMockLLM !== useMockLLM) {
        throw new Error(
            `Session LLM mode mismatch (state=${state.useMockLLM ? "mock" : "real"}, requested=${useMockLLM ? "mock" : "real"}). Re-run with --reset or use a different --session-root.`
        );
    }
}

async function loadOrCreateSessionState(params: {
    sessionRoot: string;
    transport: ChatTransport;
    principalMode: LocalPrincipalMode;
    useMockLLM: boolean;
    reset: boolean;
}): Promise<{ state: TransportChatSessionState; created: boolean }> {
    const { sessionRoot, transport, principalMode, useMockLLM, reset } = params;

    if (reset && existsSync(sessionRoot)) {
        rmSync(sessionRoot, { recursive: true, force: true });
    }

    mkdirSync(sessionRoot, { recursive: true });

    const existingState = readSessionState(sessionRoot);
    if (existingState) {
        assertSessionCompatibility(existingState, transport, principalMode, useMockLLM);
        mkdirSync(existingState.projectPath, { recursive: true });
        mkdirSync(join(existingState.metadataPath, "conversations"), { recursive: true });
        mkdirSync(existingState.artifactsPath, { recursive: true });
        if (existingState.tenexBasePath) {
            ensureMockConfig(existingState.tenexBasePath);
        }
        await initializeGitRepository(existingState.projectPath);
        return { state: existingState, created: false };
    }

    const state = createSessionState(sessionRoot, transport, principalMode, useMockLLM);
    await initializeGitRepository(state.projectPath);
    return { state, created: true };
}

async function prepareHarness(
    state: TransportChatSessionState
): Promise<PreparedHarness> {
    const ndk = new NDK();
    const agentSigner = new NDKPrivateKeySigner(state.agentNsec);
    const userSigner = new NDKPrivateKeySigner(state.userNsec);
    const agentPubkey = (await agentSigner.user()).pubkey;
    const userPubkey = (await userSigner.user()).pubkey;

    const agentRegistry = new AgentRegistry(state.projectPath, state.metadataPath);
    const agent: AgentInstance = {
        name: state.agentSlug,
        slug: state.agentSlug,
        pubkey: agentPubkey,
        role: "Transport chat validation agent",
        llmConfig: state.useMockLLM ? "transport-chat-model" : "default",
        tools: [],
        instructions:
            "Reply briefly and helpfully. Confirm when a follow-up message preserves the same conversation.",
        signer: agentSigner,
        createMetadataStore: (conversationId: string) =>
            new AgentMetadataStore(conversationId, state.agentSlug, state.metadataPath),
        createLLMService: (context) =>
            llmServiceFactory.createService(
                state.useMockLLM
                    ? { provider: "mock", model: "transport-chat-model" }
                    : config.getLLMConfig(),
                {
                    tools: context?.tools as Record<string, AISdkTool> | undefined,
                    agentName: state.agentSlug,
                    workingDirectory: context?.workingDirectory ?? state.projectPath,
                    mcpConfig: context?.mcpConfig,
                    conversationId: context?.conversationId,
                    onStreamStart: context?.onStreamStart,
                }
            ),
        sign: async (event: NDKEvent) => {
            await event.sign(agentSigner, { pTags: false });
        },
    };
    agentRegistry.addAgent(agent);

    const projectEvent = new NDKEvent(ndk);
    projectEvent.kind = 31933;
    projectEvent.pubkey = userPubkey;
    projectEvent.tags = [
        ["d", state.projectDTag],
        ["title", state.projectTitle],
    ];
    projectEvent.content = "";

    ConversationStore.initialize(state.metadataPath, [agentPubkey]);

    return {
        state,
        runtimeIngressService: new RuntimeIngressService(),
        nostrInboundAdapter: new NostrInboundAdapter(),
        localInboundAdapter: new LocalInboundAdapter(),
        projectContext: new ProjectContext(projectEvent as unknown as NDKProject, agentRegistry),
        agentPubkey,
        userPubkey,
    };
}

function nextMessageId(turnNumber: number): string {
    return `transport-chat-${Date.now()}-${String(turnNumber).padStart(3, "0")}`;
}

function unwrapExternalMessageId(messageId: string | undefined): string | undefined {
    if (!messageId) {
        return undefined;
    }

    const separatorIndex = messageId.indexOf(":");
    return separatorIndex === -1
        ? messageId
        : messageId.substring(separatorIndex + 1);
}

function findLatestRecord(
    records: PublishedRuntimeRecord[],
    intent: PublishedRuntimeRecord["intent"]
): PublishedRuntimeRecord | undefined {
    for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.intent === intent) {
            return records[index];
        }
    }

    return undefined;
}

function buildConversationMessages(
    conversationId: string
): TransportChatArtifact["conversationMessages"] {
    const conversation = ConversationStore.get(conversationId);
    return (conversation?.getAllMessages() ?? []).map((message) => ({
        role: message.role,
        messageType: message.messageType,
        pubkey: message.pubkey,
        content: message.content,
        eventId: message.eventId,
        senderPrincipalId: message.senderPrincipal?.id,
        senderLinkedPubkey: message.senderPrincipal?.linkedPubkey,
        targetedPrincipalIds: message.targetedPrincipals?.map((principal) => principal.id),
        targetedLinkedPubkeys: message.targetedPrincipals?.map((principal) => principal.linkedPubkey ?? ""),
    }));
}

function extractReplyContent(
    records: PublishedRuntimeRecord[],
    conversationMessages: ConversationRecord[],
    agentPubkey: string
): string {
    const completionRecord = findLatestRecord(records, "complete");
    const completionContent = completionRecord?.payload.content;
    if (typeof completionContent === "string" && completionContent.length > 0) {
        return completionContent;
    }

    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
        const message = conversationMessages[index];
        if (message.pubkey === agentPubkey && message.content.trim().length > 0) {
            return message.content;
        }
    }

    return "";
}

function buildArtifact(params: {
    state: TransportChatSessionState;
    statePath: string;
    artifactPath: string;
    turnNumber: number;
    canonicalEnvelope: InboundEnvelope;
    legacyEvent?: NDKEvent;
    collector: RuntimePublishCollector;
    conversationId: string;
    agentPubkey: string;
    previousInboundMessageId?: string;
}): TransportChatArtifact {
    const records = params.collector.list();
    const conversation = ConversationStore.get(params.conversationId);
    const conversationRecords = conversation?.getAllMessages() ?? [];
    const conversationMessages = buildConversationMessages(params.conversationId);
    const completionRecord = findLatestRecord(records, "complete");
    const legacyEvent = buildLegacyEventSnapshot(params.canonicalEnvelope, params.legacyEvent);
    const expectedCompletionRecipientPubkey =
        params.canonicalEnvelope.principal.linkedPubkey;
    const responseContent = extractReplyContent(records, conversationRecords, params.agentPubkey);
    const replyToNativeId = unwrapExternalMessageId(params.canonicalEnvelope.message.replyToId);

    return {
        transport: params.state.transport,
        principalMode: params.state.principalMode,
        useMockLLM: params.state.useMockLLM,
        sessionRoot: params.state.sessionRoot,
        statePath: params.statePath,
        artifactPath: params.artifactPath,
        projectPath: params.state.projectPath,
        metadataPath: params.state.metadataPath,
        turnNumber: params.turnNumber,
        conversationId: params.conversationId,
        canonicalEnvelope: params.canonicalEnvelope,
        legacyEvent,
        response: {
            content: responseContent,
            completionRecord,
        },
        conversationMessages,
        publishedRecords: records,
        validations: {
            conversationResolved: Boolean(conversation),
            replyCaptured: responseContent.length > 0,
            completionIntentRecorded: Boolean(completionRecord),
            completionRecipientPrincipalMatchesEnvelope:
                completionRecord?.payload.recipientPrincipalId === params.canonicalEnvelope.principal.id,
            completionRecipientPubkeyMatchesPrincipalIdentity:
                completionRecord?.payload.recipient === expectedCompletionRecipientPubkey,
            followupLinkedToPreviousInbound:
                !params.previousInboundMessageId ||
                replyToNativeId === params.previousInboundMessageId,
        },
    };
}

function assertArtifact(artifact: TransportChatArtifact): void {
    const failedChecks = Object.entries(artifact.validations)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);

    if (failedChecks.length > 0) {
        throw new Error(
            `Transport chat validation failed: ${failedChecks.join(", ")}`
        );
    }
}

async function buildInbound(params: {
    state: TransportChatSessionState;
    transport: ChatTransport;
    message: string;
    turnNumber: number;
    agentPubkey: string;
    userPubkey: string;
    previousInboundMessageId?: string;
    nostrInboundAdapter: NostrInboundAdapter;
    localInboundAdapter: LocalInboundAdapter;
}): Promise<{ canonicalEnvelope: InboundEnvelope; legacyEvent?: NDKEvent }> {
    const messageId = nextMessageId(params.turnNumber);
    const projectBinding = `31933:${params.userPubkey}:${params.state.projectDTag}`;

    if (params.transport === "nostr") {
        const inboundEvent = new NDKEvent(new NDK());
        inboundEvent.kind = 1;
        inboundEvent.pubkey = params.userPubkey;
        inboundEvent.content = params.message;
        inboundEvent.tags = [
            ["p", params.agentPubkey],
            ["a", projectBinding],
        ];
        if (params.previousInboundMessageId) {
            inboundEvent.tags.push(["e", params.previousInboundMessageId]);
        }
        inboundEvent.created_at = Math.floor(Date.now() / 1000);
        inboundEvent.id = messageId;

        return {
            canonicalEnvelope: params.nostrInboundAdapter.toEnvelope(inboundEvent),
            legacyEvent: inboundEvent,
        };
    }

    return {
        canonicalEnvelope: params.localInboundAdapter.toEnvelope({
            principal: {
                id: "local:user:transport-chat",
                linkedPubkey:
                    params.state.principalMode === "linked" ? params.userPubkey : undefined,
                displayName: "Transport Chat User",
                kind: "human",
            },
            channel: {
                id: "local:project:transport-chat-project",
                kind: "project",
                projectBinding,
            },
            message: {
                id: messageId,
                replyToId: params.previousInboundMessageId,
            },
            recipients: [
                {
                    id: `nostr:${params.agentPubkey}`,
                    linkedPubkey: params.agentPubkey,
                    displayName: params.state.agentSlug,
                    kind: "agent",
                },
            ],
            content: params.message,
        }),
    };
}

export const transportChatCommand = new Command("transport-chat")
    .description("Run a reusable transport-neutral chat session through TENEX")
    .option("--session-root <path>", "Persist or reuse a transport chat session root")
    .option("--transport <transport>", "Inbound transport to simulate (local or nostr)", "local")
    .option(
        "--principal-mode <mode>",
        "For local transport, simulate a linked or transport-only user principal",
        "linked"
    )
    .option("--message <text>", "User message to inject into the runtime", "Hello from transport chat.")
    .option("--real-llm", "Use configured providers instead of the bundled mock LLM harness")
    .option("--reset", "Reset the session root before sending this message")
    .action(async (options) => {
        const originalUseMock = process.env.USE_MOCK_LLM;
        const originalTenexBaseDir = process.env.TENEX_BASE_DIR;
        const transport: ChatTransport = options.transport === "nostr" ? "nostr" : "local";
        const principalMode: LocalPrincipalMode = options.principalMode === "transport-only"
            ? "transport-only"
            : "linked";
        const useMockLLM = !options.realLlm;
        const sessionRoot = options.sessionRoot
            ? String(options.sessionRoot)
            : mkdtempSync(join(tmpdir(), "tenex-transport-chat-"));

        try {
            const { state: sessionState, created } = await loadOrCreateSessionState({
                sessionRoot,
                transport,
                principalMode,
                useMockLLM,
                reset: Boolean(options.reset),
            });

            if (sessionState.tenexBasePath) {
                process.env.TENEX_BASE_DIR = sessionState.tenexBasePath;
            } else {
                process.env.TENEX_BASE_DIR = originalTenexBaseDir;
            }
            process.env.USE_MOCK_LLM = useMockLLM ? "true" : "false";

            llmServiceFactory.reset();
            await config.loadConfig();

            const harness = await prepareHarness(sessionState);
            const collector = new RuntimePublishCollector();
            const agentExecutor = new AgentExecutor({
                publisherFactory: createRecordingRuntimePublisherFactory(collector),
            });
            const turnNumber = sessionState.turnCount + 1;
            const previousInboundMessageId = sessionState.lastInboundMessageId;

            if (sessionState.conversationId) {
                ConversationStore.getOrLoad(sessionState.conversationId);
            }

            const { canonicalEnvelope, legacyEvent } = await buildInbound({
                state: sessionState,
                transport,
                message: String(options.message),
                turnNumber,
                agentPubkey: harness.agentPubkey,
                userPubkey: harness.userPubkey,
                previousInboundMessageId,
                nostrInboundAdapter: harness.nostrInboundAdapter,
                localInboundAdapter: harness.localInboundAdapter,
            });

            await projectContextStore.run(
                harness.projectContext,
                async () =>
                    harness.runtimeIngressService.handleChatMessage({
                        envelope: canonicalEnvelope,
                        agentExecutor,
                        adapter: legacyEvent
                            ? harness.nostrInboundAdapter.constructor.name
                            : harness.localInboundAdapter.constructor.name,
                    })
            );

            const conversation = ConversationStore.findByEventId(canonicalEnvelope.message.nativeId);
            if (!conversation) {
                throw new Error("Transport chat run did not resolve a conversation");
            }

            sessionState.turnCount = turnNumber;
            sessionState.lastInboundMessageId = canonicalEnvelope.message.nativeId;
            sessionState.conversationId = conversation.id;
            writeSessionState(sessionState);

            const artifactPath = join(
                sessionState.artifactsPath,
                `turn-${String(turnNumber).padStart(3, "0")}.json`
            );
            const artifact = buildArtifact({
                state: sessionState,
                statePath: sessionStatePath(sessionState.sessionRoot),
                artifactPath,
                turnNumber,
                canonicalEnvelope,
                legacyEvent,
                collector,
                conversationId: conversation.id,
                agentPubkey: harness.agentPubkey,
                previousInboundMessageId,
            });
            assertArtifact(artifact);
            writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

            console.log(chalk.green(created ? "Transport chat session created" : "Transport chat turn completed"));
            console.log(chalk.gray(`Session root: ${sessionState.sessionRoot}`));
            console.log(chalk.gray(`Transport: ${sessionState.transport}`));
            if (sessionState.principalMode) {
                console.log(chalk.gray(`Principal mode: ${sessionState.principalMode}`));
            }
            console.log(chalk.gray(`LLM mode: ${sessionState.useMockLLM ? "mock" : "configured"}`));
            console.log(chalk.gray(`Turn: ${artifact.turnNumber}`));
            console.log(chalk.gray(`Conversation: ${artifact.conversationId}`));
            console.log(chalk.gray("Reply:"));
            console.log(artifact.response.content);
            console.log(chalk.gray(`Artifact: ${artifactPath}`));
            console.log(chalk.gray(`State: ${sessionStatePath(sessionState.sessionRoot)}`));
        } finally {
            await RAGService.closeInstance();
            ConversationStore.reset();
            RALRegistry.getInstance().clearAll();
            llmServiceFactory.reset();
            process.env.USE_MOCK_LLM = originalUseMock;
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;
        }
    });
