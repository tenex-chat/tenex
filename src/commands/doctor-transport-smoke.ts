import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import {
    buildLegacyEventSnapshot,
    getLegacyTagValue,
} from "@/events/runtime/legacy-event-snapshot";
import { LocalInboundAdapter } from "@/events/runtime/LocalInboundAdapter";
import {
    RuntimePublishCollector,
    createRecordingRuntimePublisherFactory,
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

type SmokeTransport = "nostr" | "local";
type LocalPrincipalMode = "linked" | "transport-only";

interface TransportSmokeArtifact {
    transport: SmokeTransport;
    principalMode?: LocalPrincipalMode;
    tempRoot: string;
    projectPath: string;
    metadataPath: string;
    conversationId: string;
    canonicalEnvelope: InboundEnvelope;
    legacyEvent: {
        id: string;
        pubkey: string;
        content: string;
        tags: string[][];
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
    publishedRecords: ReturnType<RuntimePublishCollector["list"]>;
    validations: {
        legacyEventIdMatchesNativeMessageId: boolean;
        legacyEventPrincipalMatchesEnvelope: boolean;
        legacyEventRecipientMatchesEnvelope: boolean;
        inboundMessagePrincipalPersisted: boolean;
        inboundMessageRecipientPersisted: boolean;
        completionIntentRecorded: boolean;
        completionRecipientPrincipalMatchesEnvelope: boolean;
        completionRecipientPubkeyMatchesPrincipalIdentity: boolean;
    };
}

function buildArtifact(
    params: {
        transport: SmokeTransport;
        principalMode?: LocalPrincipalMode;
        tempRoot: string;
        projectPath: string;
        metadataPath: string;
        conversationId: string;
        legacyEvent?: NDKEvent;
        canonicalEnvelope: InboundEnvelope;
        collector: RuntimePublishCollector;
    }
): TransportSmokeArtifact {
    const legacyEvent = buildLegacyEventSnapshot(params.canonicalEnvelope, params.legacyEvent);
    const conversation = ConversationStore.get(params.conversationId);
    const conversationMessages = (conversation?.getAllMessages() ?? []).map((message) => ({
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
    const inboundMessage = conversationMessages.find(
        (message) => message.eventId === params.canonicalEnvelope.message.nativeId
    );
    const completionRecord = params.collector
        .list()
        .find((record) => record.intent === "complete");
    const expectedLegacyPrincipalPubkey =
        params.canonicalEnvelope.principal.linkedPubkey ?? legacyEvent.pubkey;
    const expectedCompletionRecipientPubkey =
        params.canonicalEnvelope.principal.linkedPubkey;

    return {
        transport: params.transport,
        principalMode: params.principalMode,
        tempRoot: params.tempRoot,
        projectPath: params.projectPath,
        metadataPath: params.metadataPath,
        conversationId: params.conversationId,
        canonicalEnvelope: params.canonicalEnvelope,
        legacyEvent,
        conversationMessages,
        publishedRecords: params.collector.list(),
        validations: {
            legacyEventIdMatchesNativeMessageId:
                legacyEvent.id === params.canonicalEnvelope.message.nativeId,
            legacyEventPrincipalMatchesEnvelope:
                legacyEvent.pubkey === expectedLegacyPrincipalPubkey,
            legacyEventRecipientMatchesEnvelope:
                params.canonicalEnvelope.recipients[0]?.linkedPubkey === getLegacyTagValue(legacyEvent, "p"),
            inboundMessagePrincipalPersisted:
                inboundMessage?.senderPrincipalId === params.canonicalEnvelope.principal.id,
            inboundMessageRecipientPersisted:
                inboundMessage?.targetedPrincipalIds?.[0] === params.canonicalEnvelope.recipients[0]?.id,
            completionIntentRecorded: Boolean(completionRecord),
            completionRecipientPrincipalMatchesEnvelope:
                completionRecord?.payload.recipientPrincipalId === params.canonicalEnvelope.principal.id,
            completionRecipientPubkeyMatchesPrincipalIdentity:
                completionRecord?.payload.recipient === expectedCompletionRecipientPubkey,
        },
    };
}

function assertSmokeArtifact(artifact: TransportSmokeArtifact): void {
    const failedChecks = Object.entries(artifact.validations)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);

    if (artifact.conversationMessages.length < 2) {
        failedChecks.push("conversationMessageCount");
    }

    if (!artifact.publishedRecords.some((record) => record.intent === "streamTextDelta")) {
        failedChecks.push("streamTextDeltaRecorded");
    }

    if (failedChecks.length > 0) {
        throw new Error(
            `Transport smoke validation failed: ${failedChecks.join(", ")}`
        );
    }
}

export const transportSmokeCommand = new Command("transport-smoke")
    .description("Run the transport-neutral ingress + publisher smoke test locally")
    .option("--transport <transport>", "Inbound transport to simulate (nostr or local)", "nostr")
    .option(
        "--principal-mode <mode>",
        "For local transport, simulate a linked or transport-only user principal",
        "linked"
    )
    .option(
        "--message <text>",
        "User message to inject into the runtime",
        "Explain what changed in the transport-neutral ingress refactor."
    )
    .option("--output <path>", "Write the smoke artifact JSON to this path")
    .option("--keep-temp", "Keep the temporary project and metadata directories")
    .action(async (options) => {
        const originalUseMock = process.env.USE_MOCK_LLM;
        const originalTenexBaseDir = process.env.TENEX_BASE_DIR;
        const tempRoot = mkdtempSync(join(tmpdir(), "tenex-transport-smoke-"));
        const projectPath = join(tempRoot, "project");
        const metadataPath = join(tempRoot, "metadata");
        const tenexBasePath = join(tempRoot, "tenex-home");
        const artifactPath = options.output || join(tempRoot, "transport-smoke-artifact.json");
        const transport = options.transport === "local" ? "local" : "nostr";
        const principalMode = options.principalMode === "transport-only"
            ? "transport-only"
            : "linked";

        mkdirSync(projectPath, { recursive: true });
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        mkdirSync(tenexBasePath, { recursive: true });

        try {
            process.env.USE_MOCK_LLM = "true";
            process.env.TENEX_BASE_DIR = tenexBasePath;
            writeFileSync(
                join(tenexBasePath, "config.json"),
                `${JSON.stringify({
                    whitelistedPubkeys: [],
                    logging: { level: "error" },
                    telemetry: { enabled: false },
                }, null, 2)}\n`
            );
            writeFileSync(
                join(tenexBasePath, "providers.json"),
                `${JSON.stringify({ providers: {} }, null, 2)}\n`
            );
            writeFileSync(
                join(tenexBasePath, "llms.json"),
                `${JSON.stringify({ configurations: {} }, null, 2)}\n`
            );

            llmServiceFactory.reset();
            await config.loadConfig();

            await initializeGitRepository(projectPath);

            const ndk = new NDK();
            const agentSigner = NDKPrivateKeySigner.generate();
            const userSigner = NDKPrivateKeySigner.generate();
            const agentPubkey = (await agentSigner.user()).pubkey;
            const userPubkey = (await userSigner.user()).pubkey;

            const agentRegistry = new AgentRegistry(projectPath, metadataPath);
            const agent: AgentInstance = {
                name: "transport-smoke-agent",
                slug: "transport-smoke-agent",
                pubkey: agentPubkey,
                role: "Transport smoke validation agent",
                llmConfig: "transport-smoke-model",
                tools: [],
                instructions:
                    "Reply briefly and confirm that the message reached the runtime.",
                signer: agentSigner,
                createMetadataStore: (conversationId: string) =>
                    new AgentMetadataStore(conversationId, "transport-smoke-agent", metadataPath),
                createLLMService: (context) =>
                    llmServiceFactory.createService(
                        { provider: "mock", model: "transport-smoke-model" },
                        {
                            tools: context?.tools as Record<string, AISdkTool> | undefined,
                            agentName: "transport-smoke-agent",
                            workingDirectory: context?.workingDirectory ?? projectPath,
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
                ["d", "transport-smoke-project"],
                ["title", "Transport Smoke Project"],
            ];
            projectEvent.content = "";

            ConversationStore.initialize(metadataPath, [agentPubkey]);

            const projectContext = new ProjectContext(projectEvent as unknown as NDKProject, agentRegistry);
            const collector = new RuntimePublishCollector();
            const agentExecutor = new AgentExecutor({
                publisherFactory: createRecordingRuntimePublisherFactory(collector),
            });
            const runtimeIngressService = new RuntimeIngressService();
            const nostrInboundAdapter = new NostrInboundAdapter();
            const localInboundAdapter = new LocalInboundAdapter();

            let canonicalEnvelope: InboundEnvelope;
            let legacyEvent: NDKEvent | undefined;
            const inboundMessageId = `transport-smoke-${Date.now()}`;

            if (transport === "nostr") {
                const inboundEvent = new NDKEvent(ndk);
                inboundEvent.kind = 1;
                inboundEvent.pubkey = userPubkey;
                inboundEvent.content = options.message;
                inboundEvent.tags = [
                    ["p", agentPubkey],
                    ["a", `31933:${userPubkey}:transport-smoke-project`],
                ];
                inboundEvent.created_at = Math.floor(Date.now() / 1000);
                inboundEvent.id = inboundMessageId;
                canonicalEnvelope = nostrInboundAdapter.toEnvelope(inboundEvent);
                legacyEvent = inboundEvent;

                await projectContextStore.run(projectContext, async () =>
                    runtimeIngressService.handleChatMessage({
                        envelope: canonicalEnvelope,
                        agentExecutor,
                        adapter: nostrInboundAdapter.constructor.name,
                    })
                );
            } else {
                canonicalEnvelope = localInboundAdapter.toEnvelope({
                    principal: {
                        id: "local:user:transport-smoke",
                        linkedPubkey: principalMode === "linked" ? userPubkey : undefined,
                        displayName: "Transport Smoke User",
                        kind: "human",
                    },
                    channel: {
                        id: "local:project:transport-smoke-project",
                        kind: "project",
                        projectBinding: `31933:${userPubkey}:transport-smoke-project`,
                    },
                    message: {
                        id: inboundMessageId,
                    },
                    recipients: [
                        {
                            id: `nostr:${agentPubkey}`,
                            linkedPubkey: agentPubkey,
                            displayName: "transport-smoke-agent",
                            kind: "agent",
                        },
                    ],
                    content: options.message,
                });

                await projectContextStore.run(projectContext, async () =>
                    runtimeIngressService.handleChatMessage({
                        envelope: canonicalEnvelope,
                        agentExecutor,
                        adapter: localInboundAdapter.constructor.name,
                    })
                );
            }

            const conversation = ConversationStore.findByEventId(canonicalEnvelope.message.nativeId);
            if (!conversation) {
                throw new Error("Transport smoke run did not resolve a conversation");
            }

            const artifact = buildArtifact({
                transport,
                principalMode: transport === "local" ? principalMode : undefined,
                tempRoot,
                projectPath,
                metadataPath,
                conversationId: conversation.id,
                legacyEvent,
                canonicalEnvelope,
                collector,
            });
            assertSmokeArtifact(artifact);

            writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

            const completionRecord = artifact.publishedRecords.find(
                (record) => record.intent === "complete"
            );

            console.log(chalk.green("Transport smoke passed"));
            console.log(chalk.gray(`Transport: ${artifact.transport}`));
            if (artifact.principalMode) {
                console.log(chalk.gray(`Principal mode: ${artifact.principalMode}`));
            }
            console.log(chalk.gray(`Conversation: ${artifact.conversationId}`));
            console.log(chalk.gray(`Messages captured: ${artifact.conversationMessages.length}`));
            console.log(chalk.gray(`Published intents: ${artifact.publishedRecords.length}`));
            console.log(chalk.gray(`Validation checks: ${Object.keys(artifact.validations).length}`));
            if (completionRecord) {
                console.log(
                    chalk.gray(
                        `Completion recipient: ${String(completionRecord.payload.recipient ?? "n/a")}`
                    )
                );
            }
            console.log(chalk.gray(`Artifact: ${artifactPath}`));
            if (options.keepTemp) {
                console.log(chalk.gray(`Temp root: ${tempRoot}`));
            }
        } finally {
            await RAGService.closeInstance();
            ConversationStore.reset();
            RALRegistry.getInstance().clearAll();
            llmServiceFactory.reset();
            process.env.USE_MOCK_LLM = originalUseMock;
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;

            if (!options.keepTemp && existsSync(tempRoot)) {
                rmSync(tempRoot, { recursive: true, force: true });
            }
        }
    });
