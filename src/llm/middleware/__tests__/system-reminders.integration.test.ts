import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { AgentInstance } from "@/agents/types";
import { MessageCompiler } from "@/agents/execution/MessageCompiler";
import {
    initializeReminderProviders,
    resetSystemReminders,
    updateReminderData,
} from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { createTenexSystemRemindersMiddleware } from "../system-reminders";

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "SYSTEM_PROMPT" } },
]);

const getName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pubkey": "DelegatedAgent",
    };
    return names[pubkey] ?? "Unknown";
});

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages,
}));

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName,
    }),
}));

function toProviderPrompt(messages: Array<{ role: string; content: unknown }>): LanguageModelV3Message[] {
    return messages.map((message) => {
        if (message.role === "system") {
            return {
                role: "system",
                content: String(message.content),
            };
        }

        return {
            role: message.role as "user" | "assistant",
            content: [
                {
                    type: "text",
                    text: String(message.content),
                },
            ],
        };
    }) as LanguageModelV3Message[];
}

describe("TENEX system reminder middleware integration", () => {
    const projectId = "project-1";
    const conversationId = "conv-1";
    const workingDirectory = "/tmp/test-project";
    const agentPubkey = "agent-pubkey";
    const userPubkey = "user-pubkey";
    const respondingToPrincipal = {
        id: `nostr:${userPubkey}`,
        transport: "nostr" as const,
        linkedPubkey: userPubkey,
        kind: "human" as const,
    };

    let testDir: string;
    let metadataPath: string;
    let conversationStore: ConversationStore;
    let agent: AgentInstance;
    let project: NDKProject;

    async function compile(ralNumber: number) {
        const compiler = new MessageCompiler(conversationStore);
        return compiler.compile({
            agent,
            project,
            conversation: conversationStore,
            projectBasePath: "/tmp/project",
            workingDirectory,
            currentBranch: "main",
            availableAgents: [agent],
            mcpManager: undefined,
            nudgeContent: "",
            pendingDelegations: [],
            completedDelegations: [],
            ralNumber,
        });
    }

    beforeEach(() => {
        testDir = join(tmpdir(), `tenex-reminder-integration-${Date.now()}`);
        metadataPath = join(testDir, "metadata-root");
        mkdirSync(testDir, { recursive: true });
        mkdirSync(metadataPath, { recursive: true });

        conversationStore = new ConversationStore(testDir);
        conversationStore.load(projectId, conversationId);

        agent = {
            name: "TestAgent",
            slug: "test-agent",
            pubkey: agentPubkey,
            tools: [],
            llmConfig: "openrouter:dummy",
            createMetadataStore: (convId: string) =>
                new AgentMetadataStore(convId, "test-agent", metadataPath),
        } as AgentInstance;

        project = {} as NDKProject;
        resetSystemReminders();
        initializeReminderProviders();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        resetSystemReminders();
        mock.restore();
    });

    it("injects reminders into the last system message, not user messages", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "heuristic",
            content: "Update your todo list before using more tools.",
        });

        const compiled = await compile(ralNumber);

        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [
                {
                    delegationConversationId: "delegation-1",
                    recipientPubkey: "delegated-pubkey",
                    senderPubkey: agentPubkey,
                    prompt: "Do a task",
                    ralNumber,
                },
            ],
            completedDelegations: [],
        });

        const middleware = createTenexSystemRemindersMiddleware();
        const result = await middleware.transformParams?.({
            params: {
                prompt: toProviderPrompt(compiled.messages as Array<{ role: string; content: unknown }>),
            } as any,
            type: "generate-text" as any,
            model: { provider: "test", modelId: "model" } as any,
        });

        // Reminders should be in the system message
        const systemMsg = result?.prompt.findLast((m) => m.role === "system");
        expect(systemMsg).toBeDefined();
        expect(systemMsg?.content).toContain("<response-routing>");
        expect(systemMsg?.content).toContain("<delegations>");
        expect(systemMsg?.content).toContain("<heuristic>");

        // User message should be untouched
        const userMsg = result?.prompt.find((m) => m.role === "user");
        const textPart = userMsg?.content[0];
        expect(textPart?.type).toBe("text");
        expect(textPart?.text).toBe("Hello, can you help me?");
        expect(textPart?.text).not.toContain("<system-reminders>");
    });

    it("keeps deferred reminders across turns while injecting into system message", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Initial message",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "Initial response",
            messageType: "text",
        });

        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "supervision-message",
            content: "Task Tracking Suggestion: create a todo before continuing.",
        });
        ctx.advance();

        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Follow-up question",
            messageType: "text",
        });

        const compiled = await compile(ralNumber);

        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
        });

        const middleware = createTenexSystemRemindersMiddleware();
        const result = await middleware.transformParams?.({
            params: {
                prompt: toProviderPrompt(compiled.messages as Array<{ role: string; content: unknown }>),
            } as any,
            type: "generate-text" as any,
            model: { provider: "test", modelId: "model" } as any,
        });

        expect(compiled.messages).toHaveLength(4);

        // Reminders in system message
        const systemMsg = result?.prompt.findLast((m) => m.role === "system");
        expect(systemMsg?.content).toContain("<response-routing>");
        expect(systemMsg?.content).toContain("<supervision-message>");

        // User messages untouched
        const lastUser = result?.prompt.findLast((m) => m.role === "user");
        expect(lastUser?.content[0]?.text).toBe("Follow-up question");
    });

    it("prepends a system message when prompt has none", async () => {
        const middleware = createTenexSystemRemindersMiddleware();
        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "heuristic",
            content: "Some reminder",
        });

        const promptWithNoSystem: LanguageModelV3Message[] = [
            { role: "user", content: [{ type: "text", text: "Hello" }] },
        ];

        const result = await middleware.transformParams?.({
            params: { prompt: promptWithNoSystem } as any,
            type: "generate-text" as any,
            model: { provider: "test", modelId: "model" } as any,
        });

        expect(result?.prompt[0]?.role).toBe("system");
        expect(result?.prompt[0]?.content).toContain("<heuristic>");
        // User message should still be there and untouched
        expect(result?.prompt[1]?.role).toBe("user");
        expect(result?.prompt[1]?.content[0]?.text).toBe("Hello");
    });
});
