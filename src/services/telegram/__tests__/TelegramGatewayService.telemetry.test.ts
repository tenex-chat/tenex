import { afterEach, describe, expect, it, mock } from "bun:test";
import { ConversationStore } from "@/conversations/ConversationStore";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import { projectContextStore } from "@/services/projects";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NDKEvent } from "@nostr-dev-kit/ndk";

interface RecordedSpan {
    name: string;
    attributes: Record<string, unknown>;
    events: Array<{ name: string; attributes: Record<string, unknown> }>;
    status?: Record<string, unknown>;
    ended: boolean;
}

const spans: RecordedSpan[] = [];
let activeSpan: ReturnType<typeof createSpan> | undefined;

function createSpan(name: string, attributes: Record<string, unknown> = {}) {
    const span: RecordedSpan = {
        name,
        attributes: { ...attributes },
        events: [],
        ended: false,
    };
    spans.push(span);

    return {
        addEvent: (eventName: string, eventAttributes: Record<string, unknown>) => {
            span.events.push({ name: eventName, attributes: { ...eventAttributes } });
        },
        setAttributes: (nextAttributes: Record<string, unknown>) => {
            Object.assign(span.attributes, nextAttributes);
        },
        setStatus: (status: Record<string, unknown>) => {
            span.status = status;
        },
        recordException: () => {},
        end: () => {
            span.ended = true;
        },
        spanContext: () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
            traceFlags: 1,
        }),
    };
}

mock.module("@/utils/logger", () => ({
    logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

mock.module("@opentelemetry/api", () => ({
    SpanStatusCode: {
        UNSET: 0,
        OK: 1,
        ERROR: 2,
    },
    trace: {
        getActiveSpan: () => activeSpan,
        getTracer: () => ({
            startActiveSpan: async (
                name: string,
                optionsOrFn: unknown,
                maybeFn?: (span: ReturnType<typeof createSpan>) => unknown
            ) => {
                const fn = typeof optionsOrFn === "function"
                    ? optionsOrFn as (span: ReturnType<typeof createSpan>) => unknown
                    : maybeFn!;
                const options = typeof optionsOrFn === "function"
                    ? {}
                    : optionsOrFn as { attributes?: Record<string, unknown> };
                const span = createSpan(name, options.attributes);
                const previousSpan = activeSpan;
                activeSpan = span;
                try {
                    return await fn(span);
                } finally {
                    activeSpan = previousSpan;
                }
            },
            startSpan: (name: string, options?: { attributes?: Record<string, unknown> }) =>
                createSpan(name, options?.attributes),
        }),
        setSpan: () => ({}),
    },
    context: {
        active: () => ({}),
        with: async (_context: unknown, fn: () => unknown) => await fn(),
        bind: <T>(target: T) => target,
    },
    ROOT_CONTEXT: {},
}));

function createProjectContext(agent: any) {
    return {
        agentRegistry: {
            getBasePath: () => "/tmp/project",
        },
        agents: new Map([[agent.slug, agent]]),
        mcpManager: undefined,
        project: {
            id: "project-event",
            tagValue: (name: string) =>
                name === "d" ? "telegram-project" : name === "title" ? "Telegram Project" : undefined,
            tagReference: () => ["a", `31933:${"f".repeat(64)}:telegram-project`],
        },
    } as any;
}

describe("TelegramGatewayService telemetry", () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        ConversationStore.reset();
        spans.length = 0;
        activeSpan = undefined;

        for (const dir of tempDirs.splice(0)) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    it("creates a root Telegram span with routed conversation details", async () => {
        const { TelegramGatewayService } = await import(`../TelegramGatewayService.ts?telemetry-${Date.now()}`);
        const metadataPath = join(tmpdir(), `telegram-gateway-telemetry-${Date.now()}`);
        tempDirs.push(metadataPath);
        mkdirSync(join(metadataPath, "conversations"), { recursive: true });
        ConversationStore.initialize(metadataPath, ["a".repeat(64)]);

        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        };
        const runtimeIngress = {
            handleChatMessage: mock(async ({ envelope }: { envelope: InboundEnvelope }) => {
                const event = new NDKEvent();
                event.id = envelope.message.nativeId;
                event.pubkey = envelope.principal.linkedPubkey ?? "1".repeat(64);
                event.content = envelope.content;
                event.tags = [["p", agent.pubkey]];

                const conversation = ConversationStore.getOrLoad("conversation-telemetry");
                conversation.addMessage({
                    pubkey: event.pubkey,
                    content: event.content,
                    eventId: event.id,
                    messageType: "text",
                    senderPrincipal: envelope.principal,
                    targetedPrincipals: envelope.recipients,
                    timestamp: envelope.occurredAt,
                });
                await conversation.save();
            }),
        };

        const gateway = new TelegramGatewayService({
            runtimeIngressService: runtimeIngress,
            channelSessionStore: {
                getSession: () => undefined,
                findSessionByAgentChannel: () => undefined,
                rememberSession: () => undefined,
                clearSession: () => false,
                clearSessionsByAgentChannel: () => 0,
            } as any,
            channelBindingStore: {
                getBinding: () => undefined,
                rememberBinding: () => undefined,
                clearBinding: () => undefined,
            } as any,
            pendingBindingStore: {
                getPending: () => undefined,
                rememberPending: () => undefined,
                clearPending: () => undefined,
            } as any,
            authorizedIdentityService: {
                isAuthorizedPrincipal: () => true,
            } as any,
        }) as any;
        gateway.registrations.set(agent.telegram.botToken, [{
            projectId: "telegram-project",
            projectTitle: "Telegram Project",
            projectBinding: `31933:${"f".repeat(64)}:telegram-project`,
            runInProjectContext: async <T>(operation: () => Promise<T>) =>
                await projectContextStore.run(createProjectContext(agent), operation),
            agentExecutor: {} as any,
            binding: {
                agent,
                config: agent.telegram,
            },
        }]);

        await gateway.processUpdate({
            token: agent.telegram.botToken,
            agentPubkey: agent.pubkey,
            client: {
                sendMessage: mock(async () => undefined),
                sendChatAction: mock(async () => undefined),
            },
            botIdentity: {
                id: 777,
                is_bot: true,
                first_name: "Test Bot",
                username: "test_bot",
            },
            loopPromise: Promise.resolve(),
        }, {
            update_id: 10,
            message: {
                message_id: 5,
                date: 123,
                chat: { id: 1001, type: "private" },
                from: {
                    id: 42,
                    is_bot: false,
                    first_name: "Alice",
                },
                text: "hello dm",
            },
        });

        const span = spans.find((entry) => entry.name === "tenex.telegram.update");
        expect(span).toBeDefined();
        expect(span?.attributes["project.id"]).toBe("telegram-project");
        expect(span?.attributes["agent.slug"]).toBe("telegram-agent");
        expect(span?.attributes["telegram.update.id"]).toBe(10);
        expect(span?.attributes["telegram.chat.id"]).toBe("1001");
        expect(span?.attributes["telegram.message.id"]).toBe("5");
        expect(span?.attributes["telegram.sender.id"]).toBe("42");
        expect(span?.attributes["telegram.bot.id"]).toBe("777");
        expect(span?.attributes["conversation.id"]).toBe("conversation-telemetry");
        expect(span?.attributes["telegram.update.outcome"]).toBe("routed");
        expect(span?.ended).toBe(true);
    });

    it("records the unified unprocessable-message reason", async () => {
        const { TelegramGatewayService } = await import(`../TelegramGatewayService.ts?telemetry-drop-${Date.now()}`);
        const agent = {
            slug: "telegram-agent",
            name: "Telegram Agent",
            pubkey: "a".repeat(64),
            telegram: {
                botToken: "token",
                allowDMs: true,
            },
        };
        const gateway = new TelegramGatewayService({
            channelSessionStore: {
                getSession: () => undefined,
                findSessionByAgentChannel: () => undefined,
                rememberSession: () => undefined,
                clearSession: () => false,
                clearSessionsByAgentChannel: () => 0,
            } as any,
            channelBindingStore: {
                getBinding: () => undefined,
                rememberBinding: () => undefined,
                clearBinding: () => undefined,
            } as any,
            pendingBindingStore: {
                getPending: () => undefined,
                rememberPending: () => undefined,
                clearPending: () => undefined,
            } as any,
        }) as any;
        gateway.registrations.set(agent.telegram.botToken, [{
            projectId: "telegram-project",
            projectTitle: "Telegram Project",
            projectBinding: `31933:${"f".repeat(64)}:telegram-project`,
            runInProjectContext: async <T>(operation: () => Promise<T>) =>
                await projectContextStore.run(createProjectContext(agent), operation),
            agentExecutor: {} as any,
            binding: {
                agent,
                config: agent.telegram,
            },
        }]);

        await gateway.processUpdate({
            token: agent.telegram.botToken,
            agentPubkey: agent.pubkey,
            client: {
                sendMessage: mock(async () => undefined),
                sendChatAction: mock(async () => undefined),
            },
            botIdentity: {
                id: 777,
                is_bot: true,
                first_name: "Test Bot",
                username: "test_bot",
            },
            loopPromise: Promise.resolve(),
        }, {
            update_id: 11,
            message: {
                message_id: 6,
                date: 124,
                chat: { id: 1001, type: "private" },
                from: {
                    id: 42,
                    is_bot: false,
                    first_name: "Alice",
                },
            },
        });

        const span = spans.find((entry) => entry.name === "tenex.telegram.update");
        expect(span?.attributes["telegram.update.outcome"]).toBe("dropped");
        expect(span?.attributes["telegram.update.reason"]).toBe("unprocessable_message");
    });
});
