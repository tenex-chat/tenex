import { AgentStorage, createStoredAgent } from "@/agents/AgentStorage";
import { AgentRegistry } from "@/agents/AgentRegistry";
import type { AgentInstance } from "@/agents/types";
import { AgentExecutor } from "@/agents/execution/AgentExecutor";
import { ConversationStore } from "@/conversations/ConversationStore";
import {
    RecordingRuntimePublisher,
    RuntimePublishCollector,
    type PublishedRuntimeRecord,
} from "@/events/runtime/RecordingRuntimePublisher";
import type {
    AgentRuntimePublisher,
    PublishedMessageRef,
} from "@/events/runtime/AgentRuntimePublisher";
import type { RuntimePublishAgent } from "@/events/runtime/RuntimeAgent";
import { llmServiceFactory } from "@/llm/LLMServiceFactory";
import type {
    AskConfig,
    CompletionIntent,
    ConversationIntent,
    DelegateConfig,
    DelegationMarkerIntent,
    ErrorIntent,
    EventContext,
    LessonIntent,
    StreamTextDeltaIntent,
    ToolUseIntent,
} from "@/nostr/types";
import { AgentMetadataStore } from "@/services/agents/AgentMetadataStore";
import { config } from "@/services/ConfigService";
import { ChannelSessionStore } from "@/services/ingress/ChannelSessionStoreService";
import { IdentityBindingStore } from "@/services/identity/IdentityBindingStoreService";
import { ProjectContext, projectContextStore } from "@/services/projects";
import { RAGService } from "@/services/rag/RAGService";
import { RALRegistry } from "@/services/ral";
import {
    TelegramDeliveryService,
    TelegramChannelBindingStore,
    TelegramChatContextStore,
    TelegramGatewayCoordinator,
    TelegramPendingBindingStore,
    getTelegramGatewayCoordinator,
    createTelegramChannelId,
    type TelegramSendMessageParams,
    type TelegramUpdate,
} from "@/services/telegram";
import type { AISdkTool } from "@/tools/types";
import { initializeGitRepository } from "@/utils/git";
import { Command } from "commander";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import NDK, { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import chalk from "chalk";

interface MockTelegramSentMessage {
    token: string;
    payload: TelegramSendMessageParams & {
        rawText: string;
        parseMode?: "HTML" | "MarkdownV2";
    };
}

interface MockTelegramChatAction {
    token: string;
    payload: {
        chatId: string;
        action: "typing";
        messageThreadId?: string;
    };
}

interface TelegramSmokeArtifact {
    tempRoot: string;
    projectPaths: string[];
    metadataPath: string;
    tenexBasePath: string;
    telegramApiBaseUrl: string;
    sentMessages: MockTelegramSentMessage[];
    chatActions: MockTelegramChatAction[];
    dynamicBindings: Array<{
        channelId: string;
        projectId: string;
    }>;
    storedProjectTelegramBindings: Array<{
        projectId: string;
        chatBindings: Array<{ chatId: string; topicId?: string; title?: string }>;
    }>;
    chatContexts: Array<{
        projectId: string;
        channelId: string;
        chatTitle?: string;
        memberCount?: number;
        administratorIds: string[];
        seenParticipantIds: string[];
    }>;
    pendingBindings: Array<{
        channelId: string;
        projectIds: string[];
    }>;
    channelSessions: Array<{
        projectId: string;
        channelId: string;
        conversationId?: string;
        lastMessageId?: string;
    }>;
    conversations: Array<{
        projectId: string;
        conversationId: string;
        messageCount: number;
        messages: Array<{
            pubkey: string;
            content: string;
            eventId?: string;
            senderPrincipalId?: string;
            targetedPrincipalIds?: string[];
        }>;
    }>;
    publishedRecords: PublishedRuntimeRecord[];
    validations: {
        dmSelectionPromptSent: boolean;
        dmBindingAckSent: boolean;
        dmTypingSent: boolean;
        dmReplyRendered: boolean;
        dmSessionStored: boolean;
        dmConversationCaptured: boolean;
        dmBindingStored: boolean;
        dmCompletionRecorded: boolean;
        groupSelectionPromptSent: boolean;
        groupBindingAckSent: boolean;
        groupTypingSent: boolean;
        groupReplyRendered: boolean;
        groupSessionStored: boolean;
        groupConversationCaptured: boolean;
        groupBindingStored: boolean;
        groupBindingPersistedToAgentConfig: boolean;
        groupChatContextStored: boolean;
        groupCompletionRecorded: boolean;
    };
}

function ensureMockConfig(basePath: string): void {
    mkdirSync(basePath, { recursive: true });
    writeFileSync(
        join(basePath, "config.json"),
        `${JSON.stringify({
            whitelistedPubkeys: [],
            whitelistedIdentities: ["telegram:user:42"],
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

function collectConversationMessages(conversationId: string): Array<{
    pubkey: string;
    content: string;
    eventId: string | undefined;
    senderPrincipalId: string | undefined;
    targetedPrincipalIds: string[] | undefined;
}> {
    const conversation = ConversationStore.get(conversationId);
    return (conversation?.getAllMessages() ?? []).map((message) => ({
        pubkey: message.pubkey,
        content: message.content,
        eventId: message.eventId,
        senderPrincipalId: message.senderPrincipal?.id,
        targetedPrincipalIds: message.targetedPrincipals?.map((principal) => principal.id),
    }));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, payload: unknown): void {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
}

class MockTelegramServer {
    private readonly updates = new Map<string, TelegramUpdate[]>();
    private readonly sentMessages: MockTelegramSentMessage[] = [];
    private readonly chatActions: MockTelegramChatAction[] = [];
    private readonly botIdentityIds = new Map<string, number>();
    private readonly messageCounters = new Map<string, number>();
    private server = createServer(this.handleRequest.bind(this));
    private port = 0;

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(0, "127.0.0.1", () => {
                this.server.off("error", reject);
                const address = this.server.address();
                if (!address || typeof address === "string") {
                    reject(new Error("Failed to resolve mock Telegram server address"));
                    return;
                }
                this.port = address.port;
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.server.listening) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    get baseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    enqueueUpdate(token: string, update: TelegramUpdate): void {
        const queue = this.updates.get(token) ?? [];
        queue.push(update);
        queue.sort((left, right) => left.update_id - right.update_id);
        this.updates.set(token, queue);
    }

    async waitForSentMessages(count: number, timeoutMs: number): Promise<MockTelegramSentMessage[]> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (this.sentMessages.length >= count) {
                return [...this.sentMessages];
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        throw new Error(
            `Timed out waiting for ${count} Telegram replies (received ${this.sentMessages.length})`
        );
    }

    listSentMessages(): MockTelegramSentMessage[] {
        return [...this.sentMessages];
    }

    listChatActions(): MockTelegramChatAction[] {
        return [...this.chatActions];
    }

    private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const match = url.pathname.match(/^\/bot([^/]+)\/([^/]+)$/);
        if (!match) {
            res.statusCode = 404;
            res.end("not found");
            return;
        }

        const [, token, method] = match;
        if (method === "getMe") {
            sendJson(res, {
                ok: true,
                result: {
                    id: this.getBotIdentityId(token),
                    is_bot: true,
                    first_name: `${token} bot`,
                    username: `${token.replace(/[^a-z0-9_]/gi, "_")}_bot`,
                },
            });
            return;
        }

        if (method === "getUpdates") {
            const offsetValue = url.searchParams.get("offset");
            const limitValue = url.searchParams.get("limit");
            const offset = offsetValue ? Number(offsetValue) : undefined;
            const limit = limitValue ? Number(limitValue) : 100;

            const queue = this.updates.get(token) ?? [];
            if (offset !== undefined) {
                while (queue.length > 0) {
                    const firstUpdate = queue[0];
                    if (!firstUpdate || firstUpdate.update_id >= offset) {
                        break;
                    }
                    queue.shift();
                }
            }

            sendJson(res, {
                ok: true,
                result: queue
                    .filter((update) => offset === undefined || update.update_id >= offset)
                    .slice(0, limit),
            });
            return;
        }

        if (method === "getChat") {
            const chatId = Number(url.searchParams.get("chat_id"));
            if (chatId === -2001) {
                sendJson(res, {
                    ok: true,
                    result: {
                        id: -2001,
                        type: "supergroup",
                        title: "Telegram Smoke Group",
                        username: "telegram_smoke_group",
                    },
                });
                return;
            }

            sendJson(res, {
                ok: true,
                result: {
                    id: chatId,
                    type: "private",
                    first_name: "DM User",
                },
            });
            return;
        }

        if (method === "getChatAdministrators") {
            const chatId = Number(url.searchParams.get("chat_id"));
            if (chatId === -2001) {
                sendJson(res, {
                    ok: true,
                    result: [{
                        status: "administrator",
                        user: {
                            id: 7001,
                            is_bot: false,
                            first_name: "Group",
                            last_name: "Admin",
                            username: "group_admin",
                        },
                        custom_title: "Owner",
                    }],
                });
                return;
            }

            sendJson(res, {
                ok: true,
                result: [],
            });
            return;
        }

        if (method === "getChatMemberCount") {
            const chatId = Number(url.searchParams.get("chat_id"));
            sendJson(res, {
                ok: true,
                result: chatId === -2001 ? 14 : 2,
            });
            return;
        }

        if (method === "sendMessage") {
            const rawBody = await readRequestBody(req);
            const parsed = JSON.parse(rawBody) as Record<string, string | number>;
            const payload: MockTelegramSentMessage = {
                token,
                payload: {
                    chatId: String(parsed.chat_id),
                    text: String(parsed.text),
                    rawText: String(parsed.text),
                    parseMode: parsed.parse_mode === "HTML" || parsed.parse_mode === "MarkdownV2"
                        ? parsed.parse_mode
                        : undefined,
                    replyToMessageId: parsed.reply_to_message_id
                        ? String(parsed.reply_to_message_id)
                        : undefined,
                    messageThreadId: parsed.message_thread_id
                        ? String(parsed.message_thread_id)
                        : undefined,
                },
            };
            this.sentMessages.push(payload);

            sendJson(res, {
                ok: true,
                result: {
                    message_id: this.nextMessageId(token),
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: Number(parsed.chat_id),
                        type: parsed.message_thread_id ? "supergroup" : "private",
                    },
                    text: parsed.text,
                },
            });
            return;
        }

        if (method === "sendChatAction") {
            const rawBody = await readRequestBody(req);
            const parsed = JSON.parse(rawBody) as Record<string, string | number>;
            this.chatActions.push({
                token,
                payload: {
                    chatId: String(parsed.chat_id),
                    action: "typing",
                    messageThreadId: parsed.message_thread_id
                        ? String(parsed.message_thread_id)
                        : undefined,
                },
            });

            sendJson(res, {
                ok: true,
                result: true,
            });
            return;
        }

        res.statusCode = 404;
        res.end("unsupported method");
    }

    private getBotIdentityId(token: string): number {
        const existing = this.botIdentityIds.get(token);
        if (existing) {
            return existing;
        }

        const next = 10_000 + this.botIdentityIds.size;
        this.botIdentityIds.set(token, next);
        return next;
    }

    private nextMessageId(token: string): number {
        const next = (this.messageCounters.get(token) ?? 0) + 1;
        this.messageCounters.set(token, next);
        return next;
    }
}

class SmokeTelegramRuntimePublisher implements AgentRuntimePublisher {
    private readonly recordingPublisher: RecordingRuntimePublisher;

    constructor(
        private readonly agent: RuntimePublishAgent,
        collector: RuntimePublishCollector,
        private readonly telegramDeliveryService: TelegramDeliveryService
    ) {
        this.recordingPublisher = new RecordingRuntimePublisher(agent, collector);
    }

    async complete(intent: CompletionIntent, context: EventContext): Promise<PublishedMessageRef | undefined> {
        const event = await this.recordingPublisher.complete(intent, context);
        if (this.telegramDeliveryService.canHandle(this.agent, context)) {
            await this.telegramDeliveryService.sendReply(this.agent, context, intent.content);
        }
        return event;
    }

    async conversation(intent: ConversationIntent, context: EventContext): Promise<PublishedMessageRef> {
        return this.recordingPublisher.conversation(intent, context);
    }

    async delegate(config: DelegateConfig, context: EventContext): Promise<string> {
        return this.recordingPublisher.delegate(config, context);
    }

    async ask(config: AskConfig, context: EventContext): Promise<PublishedMessageRef> {
        const event = await this.recordingPublisher.ask(config, context);
        if (this.telegramDeliveryService.canHandle(this.agent, context)) {
            await this.telegramDeliveryService.sendReply(
                this.agent,
                context,
                `${config.title}\n\n${config.context}`
            );
        }
        return event;
    }

    async delegateFollowup(
        params: {
            recipient: string;
            content: string;
            delegationEventId: string;
            replyToEventId?: string;
        },
        context: EventContext
    ): Promise<string> {
        return this.recordingPublisher.delegateFollowup(params, context);
    }

    async error(intent: ErrorIntent, context: EventContext): Promise<PublishedMessageRef> {
        const event = await this.recordingPublisher.error(intent, context);
        if (this.telegramDeliveryService.canHandle(this.agent, context)) {
            await this.telegramDeliveryService.sendReply(this.agent, context, intent.message);
        }
        return event;
    }

    async lesson(intent: LessonIntent, context: EventContext): Promise<PublishedMessageRef> {
        return this.recordingPublisher.lesson(intent, context);
    }

    async toolUse(intent: ToolUseIntent, context: EventContext): Promise<PublishedMessageRef> {
        return this.recordingPublisher.toolUse(intent, context);
    }

    async streamTextDelta(intent: StreamTextDeltaIntent, context: EventContext): Promise<void> {
        return this.recordingPublisher.streamTextDelta(intent, context);
    }

    async delegationMarker(intent: DelegationMarkerIntent): Promise<PublishedMessageRef> {
        return this.recordingPublisher.delegationMarker(intent);
    }
}

function buildAgent(params: {
    slug: string;
    projectPath: string;
    metadataPath: string;
    botToken: string;
    apiBaseUrl: string;
    signer?: NDKPrivateKeySigner;
    allowDMs?: boolean;
    chatBindings?: Array<{ chatId: string; topicId?: string; title?: string }>;
}): AgentInstance {
    const signer = params.signer ?? NDKPrivateKeySigner.generate();
    if (!signer.nsec) {
        throw new Error(`Failed to generate signer for ${params.slug}`);
    }

    return {
        name: params.slug,
        slug: params.slug,
        pubkey: signer.pubkey,
        role: "Telegram smoke validation agent",
        llmConfig: "telegram-smoke-model",
        tools: [],
        instructions: "Reply briefly and confirm the Telegram message reached TENEX.",
        signer,
        telegram: {
            botToken: params.botToken,
            apiBaseUrl: params.apiBaseUrl,
            allowDMs: params.allowDMs,
            chatBindings: params.chatBindings,
        },
        createMetadataStore: (conversationId: string) =>
            new AgentMetadataStore(conversationId, params.slug, params.metadataPath),
        createLLMService: (context) =>
            llmServiceFactory.createService(
                { provider: "mock", model: "telegram-smoke-model" },
                {
                    tools: context?.tools as Record<string, AISdkTool> | undefined,
                    agentName: params.slug,
                    workingDirectory: context?.workingDirectory ?? params.projectPath,
                    mcpConfig: context?.mcpConfig,
                    conversationId: context?.conversationId,
                    onStreamStart: context?.onStreamStart,
                }
            ),
        sign: async (event: NDKEvent) => {
            await event.sign(signer, { pTags: false });
        },
    };
}

function createProjectEvent(
    ndk: NDK,
    ownerPubkey: string,
    dTag: string,
    title: string
): NDKProject {
    const projectEvent = new NDKEvent(ndk);
    projectEvent.kind = 31933;
    projectEvent.pubkey = ownerPubkey;
    projectEvent.tags = [
        ["d", dTag],
        ["title", title],
    ];
    projectEvent.content = "";
    return projectEvent as unknown as NDKProject;
}

export const telegramSmokeCommand = new Command("telegram-smoke")
    .description("Run a Telegram transport smoke test against a mock Bot API server")
    .option("--output <path>", "Write the smoke artifact JSON to this path")
    .option("--keep-temp", "Keep the temporary project and metadata directories")
    .action(async (options) => {
        const originalUseMock = process.env.USE_MOCK_LLM;
        const originalTenexBaseDir = process.env.TENEX_BASE_DIR;
        const tempRoot = mkdtempSync(join(tmpdir(), "tenex-telegram-smoke-"));
        const projectAlphaPath = join(tempRoot, "project-alpha");
        const projectBetaPath = join(tempRoot, "project-beta");
        const metadataPath = join(tempRoot, "metadata");
        const tenexBasePath = join(tempRoot, "tenex-home");
        const artifactPath = options.output || join(tempRoot, "telegram-smoke-artifact.json");

        mkdirSync(projectAlphaPath, { recursive: true });
        mkdirSync(projectBetaPath, { recursive: true });
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        mkdirSync(tenexBasePath, { recursive: true });

        let mockServer: MockTelegramServer | undefined;
        let coordinator: TelegramGatewayCoordinator | undefined;

        try {
            process.env.USE_MOCK_LLM = "true";
            process.env.TENEX_BASE_DIR = tenexBasePath;
            ensureMockConfig(tenexBasePath);

            llmServiceFactory.reset();
            await config.loadConfig();
            await initializeGitRepository(projectAlphaPath);
            await initializeGitRepository(projectBetaPath);

            mockServer = new MockTelegramServer();
            await mockServer.start();

            const sharedSigner = NDKPrivateKeySigner.generate();
            if (!sharedSigner.nsec) {
                throw new Error("Failed to generate shared signer for Telegram smoke agent");
            }
            const persistedAgentStorage = new AgentStorage();
            await persistedAgentStorage.initialize();
            await persistedAgentStorage.saveAgent(createStoredAgent({
                nsec: sharedSigner.nsec,
                slug: "telegram-shared-agent",
                name: "telegram-shared-agent",
                role: "Telegram smoke validation agent",
                instructions: "Reply briefly and confirm the Telegram message reached TENEX.",
                defaultConfig: {
                    model: "telegram-smoke-model",
                    tools: [],
                    telegram: {
                        botToken: "shared-token",
                        apiBaseUrl: mockServer.baseUrl,
                        allowDMs: true,
                    },
                },
            }));
            await persistedAgentStorage.addAgentToProject(sharedSigner.pubkey, "telegram-alpha-project");
            await persistedAgentStorage.addAgentToProject(sharedSigner.pubkey, "telegram-beta-project");
            const alphaAgent = buildAgent({
                slug: "telegram-shared-agent",
                projectPath: projectAlphaPath,
                metadataPath,
                signer: sharedSigner,
                botToken: "shared-token",
                apiBaseUrl: mockServer.baseUrl,
                allowDMs: true,
            });
            const betaAgent = buildAgent({
                slug: "telegram-shared-agent",
                projectPath: projectBetaPath,
                metadataPath,
                signer: sharedSigner,
                botToken: "shared-token",
                apiBaseUrl: mockServer.baseUrl,
                allowDMs: true,
            });

            const alphaRegistry = new AgentRegistry(projectAlphaPath, metadataPath);
            alphaRegistry.addAgent(alphaAgent);
            const betaRegistry = new AgentRegistry(projectBetaPath, metadataPath);
            betaRegistry.addAgent(betaAgent);

            const ndk = new NDK();
            const ownerSigner = NDKPrivateKeySigner.generate();
            const ownerPubkey = (await ownerSigner.user()).pubkey;
            const alphaProject = createProjectEvent(
                ndk,
                ownerPubkey,
                "telegram-alpha-project",
                "Telegram Alpha Project"
            );
            const betaProject = createProjectEvent(
                ndk,
                ownerPubkey,
                "telegram-beta-project",
                "Telegram Beta Project"
            );

            ConversationStore.initialize(metadataPath, [alphaAgent.pubkey]);
            const alphaProjectContext = new ProjectContext(alphaProject, alphaRegistry);
            const betaProjectContext = new ProjectContext(betaProject, betaRegistry);
            const collector = new RuntimePublishCollector();
            const telegramDeliveryService = new TelegramDeliveryService();
            const agentExecutor = new AgentExecutor({
                publisherFactory: (agent) =>
                    agent.telegram?.botToken
                        ? new SmokeTelegramRuntimePublisher(agent, collector, telegramDeliveryService)
                        : new RecordingRuntimePublisher(agent, collector),
            });

            coordinator = getTelegramGatewayCoordinator();
            await coordinator.registerRuntime({
                projectId: "telegram-alpha-project",
                projectTitle: alphaProjectContext.project.tagValue("title") ?? "telegram-alpha-project",
                projectBinding: alphaProjectContext.project.tagReference()[1] ?? "",
                agents: alphaProjectContext.agents.values(),
                runInProjectContext: async <T>(operation: () => Promise<T>) =>
                    await projectContextStore.run(alphaProjectContext, operation),
                agentExecutor,
            });
            await coordinator.registerRuntime({
                projectId: "telegram-beta-project",
                projectTitle: betaProjectContext.project.tagValue("title") ?? "telegram-beta-project",
                projectBinding: betaProjectContext.project.tagReference()[1] ?? "",
                agents: betaProjectContext.agents.values(),
                runInProjectContext: async <T>(operation: () => Promise<T>) =>
                    await projectContextStore.run(betaProjectContext, operation),
                agentExecutor,
            });

            mockServer.enqueueUpdate("shared-token", {
                update_id: 1,
                message: {
                    message_id: 11,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: 1001, type: "private" },
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Alice",
                        username: "alice_tg",
                    },
                    text: "hello from telegram dm",
                },
            });
            mockServer.enqueueUpdate("shared-token", {
                update_id: 2,
                message: {
                    message_id: 12,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: 1001, type: "private" },
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Alice",
                        username: "alice_tg",
                    },
                    text: "2",
                },
            });
            mockServer.enqueueUpdate("shared-token", {
                update_id: 3,
                message: {
                    message_id: 13,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: 1001, type: "private" },
                    from: {
                        id: 42,
                        is_bot: false,
                        first_name: "Alice",
                        username: "alice_tg",
                    },
                    text: "follow-up after selecting beta",
                },
            });
            mockServer.enqueueUpdate("shared-token", {
                update_id: 4,
                message: {
                    message_id: 21,
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: -2001,
                        type: "supergroup",
                        title: "Telegram Smoke Group",
                    },
                    from: {
                        id: 77,
                        is_bot: false,
                        first_name: "Bob",
                        username: "bob_group",
                    },
                    text: "hello from telegram group",
                },
            });
            mockServer.enqueueUpdate("shared-token", {
                update_id: 5,
                message: {
                    message_id: 22,
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: -2001,
                        type: "supergroup",
                        title: "Telegram Smoke Group",
                    },
                    from: {
                        id: 77,
                        is_bot: false,
                        first_name: "Bob",
                        username: "bob_group",
                    },
                    text: "1",
                },
            });
            mockServer.enqueueUpdate("shared-token", {
                update_id: 6,
                message: {
                    message_id: 23,
                    date: Math.floor(Date.now() / 1000),
                    chat: {
                        id: -2001,
                        type: "supergroup",
                        title: "Telegram Smoke Group",
                    },
                    from: {
                        id: 77,
                        is_bot: false,
                        first_name: "Bob",
                        username: "bob_group",
                    },
                    text: "follow-up after selecting alpha",
                },
            });

            const sentMessages = await mockServer.waitForSentMessages(6, 12_000);
            await coordinator.unregisterRuntime("telegram-alpha-project");
            await coordinator.unregisterRuntime("telegram-beta-project");
            coordinator = undefined;

            const channelSessionStore = new ChannelSessionStore(
                join(tenexBasePath, "data", "channel-sessions.json")
            );
            const channelBindingStore = new TelegramChannelBindingStore(
                join(tenexBasePath, "data", "telegram-channel-bindings.json")
            );
            const chatContextStore = new TelegramChatContextStore(
                join(tenexBasePath, "data", "telegram-chat-contexts.json")
            );
            const pendingBindingStore = new TelegramPendingBindingStore(
                join(tenexBasePath, "data", "telegram-pending-bindings.json")
            );
            const dmChannelId = createTelegramChannelId(1001);
            const groupChannelId = createTelegramChannelId(-2001);
            const dmBinding = channelBindingStore.getBinding(alphaAgent.pubkey, dmChannelId);
            const groupBinding = channelBindingStore.getBinding(alphaAgent.pubkey, groupChannelId);
            const dmSession = channelSessionStore.getSession(
                "telegram-beta-project",
                alphaAgent.pubkey,
                dmChannelId
            );
            const groupSession = channelSessionStore.getSession(
                "telegram-alpha-project",
                alphaAgent.pubkey,
                groupChannelId
            );
            const storedAgent = await persistedAgentStorage.loadAgent(alphaAgent.pubkey);
            const storedProjectTelegramBindings = [
                "telegram-alpha-project",
                "telegram-beta-project",
            ].map((projectId) => ({
                projectId,
                chatBindings: storedAgent?.projectOverrides?.[projectId]?.telegram?.chatBindings ?? [],
            }));

            const conversations = [
                dmSession
                    ? {
                          projectId: "telegram-beta-project",
                          conversationId: dmSession.conversationId,
                          messageCount: collectConversationMessages(dmSession.conversationId).length,
                          messages: collectConversationMessages(dmSession.conversationId),
                      }
                    : undefined,
                groupSession
                    ? {
                          projectId: "telegram-alpha-project",
                          conversationId: groupSession.conversationId,
                          messageCount: collectConversationMessages(groupSession.conversationId).length,
                          messages: collectConversationMessages(groupSession.conversationId),
                      }
                    : undefined,
            ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

            const publishedRecords = collector.list();
            const chatActions = mockServer.listChatActions();
            const chatContexts = chatContextStore.listContexts().map((context) => ({
                projectId: context.projectId,
                channelId: context.channelId,
                chatTitle: context.chatTitle,
                memberCount: context.memberCount,
                administratorIds: context.administrators.map((administrator) => administrator.userId),
                seenParticipantIds: context.seenParticipants.map((participant) => participant.userId),
            }));
            const artifact: TelegramSmokeArtifact = {
                tempRoot,
                projectPaths: [projectAlphaPath, projectBetaPath],
                metadataPath,
                tenexBasePath,
                telegramApiBaseUrl: mockServer.baseUrl,
                sentMessages,
                chatActions,
                dynamicBindings: channelBindingStore.listBindings().map((binding) => ({
                    channelId: binding.channelId,
                    projectId: binding.projectId,
                })),
                storedProjectTelegramBindings,
                chatContexts,
                pendingBindings: [dmChannelId, groupChannelId]
                    .map((channelId) => pendingBindingStore.getPending(alphaAgent.pubkey, channelId))
                    .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding))
                    .map((binding) => ({
                        channelId: binding.channelId,
                        projectIds: binding.projects.map((project) => project.projectId),
                    })),
                channelSessions: [
                    {
                        projectId: "telegram-beta-project",
                        channelId: dmChannelId,
                        conversationId: dmSession?.conversationId,
                        lastMessageId: dmSession?.lastMessageId,
                    },
                    {
                        projectId: "telegram-alpha-project",
                        channelId: groupChannelId,
                        conversationId: groupSession?.conversationId,
                        lastMessageId: groupSession?.lastMessageId,
                    },
                ],
                conversations,
                publishedRecords,
                validations: {
                    dmSelectionPromptSent: sentMessages.some(
                        (message) =>
                            message.token === "shared-token" &&
                            message.payload.chatId === "1001" &&
                            message.payload.rawText.includes("Reply with one of these numbers:") &&
                            message.payload.rawText.includes("Telegram Alpha Project") &&
                            message.payload.rawText.includes("Telegram Beta Project")
                    ),
                    dmBindingAckSent: sentMessages.some(
                        (message) =>
                            message.token === "shared-token" &&
                            message.payload.chatId === "1001" &&
                            message.payload.rawText.includes('Bound this chat to project "Telegram Beta Project"')
                    ),
                    dmTypingSent: chatActions.some(
                        (action) =>
                            action.token === "shared-token" &&
                            action.payload.chatId === "1001" &&
                            action.payload.action === "typing"
                    ),
                    dmReplyRendered: sentMessages.some(
                        (message) =>
                            message.token === "shared-token" &&
                            message.payload.chatId === "1001" &&
                            message.payload.replyToMessageId === "13" &&
                            message.payload.parseMode === "HTML"
                    ),
                    dmSessionStored: Boolean(dmSession?.conversationId && dmSession.lastMessageId),
                    dmConversationCaptured: Boolean(
                        conversations.find((conversation) => conversation.projectId === "telegram-beta-project")
                            ?.messages.some((message) => message.senderPrincipalId === "telegram:user:42")
                    ),
                    dmBindingStored: dmBinding?.projectId === "telegram-beta-project",
                    dmCompletionRecorded: publishedRecords.some(
                        (record) =>
                            record.agentSlug === alphaAgent.slug &&
                            record.intent === "complete" &&
                            record.payload.recipientPrincipalId === "telegram:user:42"
                    ),
                    groupSelectionPromptSent: sentMessages.some(
                        (message) =>
                            message.token === "shared-token" &&
                            message.payload.chatId === "-2001" &&
                            message.payload.rawText.includes("Reply with one of these numbers:") &&
                            message.payload.rawText.includes("Telegram Alpha Project") &&
                            message.payload.rawText.includes("Telegram Beta Project")
                    ),
                    groupBindingAckSent: sentMessages.some(
                        (message) =>
                            message.token === "shared-token" &&
                            message.payload.chatId === "-2001" &&
                            message.payload.rawText.includes('Bound this chat to project "Telegram Alpha Project"')
                    ),
                    groupTypingSent: chatActions.some(
                        (action) =>
                            action.token === "shared-token" &&
                            action.payload.chatId === "-2001" &&
                            action.payload.action === "typing"
                    ),
                    groupReplyRendered: sentMessages.some(
                        (message) =>
                            message.token === "shared-token" &&
                            message.payload.chatId === "-2001" &&
                            message.payload.replyToMessageId === "23" &&
                            message.payload.parseMode === "HTML"
                    ),
                    groupSessionStored: Boolean(groupSession?.conversationId && groupSession.lastMessageId),
                    groupConversationCaptured: Boolean(
                        conversations.find((conversation) => conversation.projectId === "telegram-alpha-project")
                            ?.messages.some((message) => message.senderPrincipalId === "telegram:user:77")
                    ),
                    groupBindingStored: groupBinding?.projectId === "telegram-alpha-project",
                    groupBindingPersistedToAgentConfig: storedProjectTelegramBindings.some(
                        (entry) =>
                            entry.projectId === "telegram-alpha-project" &&
                            entry.chatBindings.some(
                                (binding) =>
                                    binding.chatId === "-2001" &&
                                    binding.title === "Telegram Smoke Group"
                            )
                    ),
                    groupChatContextStored: chatContexts.some(
                        (context) =>
                            context.projectId === "telegram-alpha-project" &&
                            context.channelId === groupChannelId &&
                            context.chatTitle === "Telegram Smoke Group" &&
                            context.memberCount === 14 &&
                            context.administratorIds.includes("7001") &&
                            context.seenParticipantIds.includes("77")
                    ),
                    groupCompletionRecorded: publishedRecords.some(
                        (record) =>
                            record.agentSlug === alphaAgent.slug &&
                            record.intent === "complete" &&
                            record.payload.recipientPrincipalId === "telegram:user:77"
                    ),
                },
            };

            const failedChecks = Object.entries(artifact.validations)
                .filter(([, passed]) => !passed)
                .map(([name]) => name);
            if (failedChecks.length > 0) {
                throw new Error(`Telegram smoke validation failed: ${failedChecks.join(", ")}`);
            }

            writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

            console.log(chalk.green("Telegram smoke completed"));
            console.log(chalk.gray(`Mock API: ${mockServer.baseUrl}`));
            console.log(chalk.gray(`DM conversation: ${dmSession?.conversationId ?? "missing"}`));
            console.log(chalk.gray(`Group conversation: ${groupSession?.conversationId ?? "missing"}`));
            console.log(chalk.gray(`DM binding: ${dmBinding?.projectId ?? "missing"}`));
            console.log(chalk.gray(`Group binding: ${groupBinding?.projectId ?? "missing"}`));
            console.log(chalk.gray(`Sent Telegram messages: ${sentMessages.length}`));
            console.log(chalk.gray(`Artifact: ${artifactPath}`));

            await mockServer.stop();
            mockServer = undefined;
        } finally {
            if (coordinator) {
                await coordinator.unregisterRuntime("telegram-alpha-project").catch(() => undefined);
                await coordinator.unregisterRuntime("telegram-beta-project").catch(() => undefined);
            }
            if (mockServer) {
                await mockServer.stop();
            }

            await RAGService.closeInstance();
            ConversationStore.reset();
            RALRegistry.getInstance().clearAll();
            TelegramGatewayCoordinator.resetInstance();
            ChannelSessionStore.resetInstance();
            TelegramChannelBindingStore.resetInstance();
            TelegramChatContextStore.resetInstance();
            TelegramPendingBindingStore.resetInstance();
            IdentityBindingStore.resetInstance();
            llmServiceFactory.reset();
            process.env.USE_MOCK_LLM = originalUseMock;
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;

            if (!options.keepTemp && existsSync(tempRoot)) {
                rmSync(tempRoot, { recursive: true, force: true });
            }
        }
    });
