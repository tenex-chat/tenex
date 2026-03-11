import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "SYSTEM_PROMPT" } },
]);

const todoTemplate = mock(async () => "## Current Todos\n- [ ] Task 1\n- [x] Task 2");

const getName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pubkey": "DelegatedAgent",
    };
    return names[pubkey] ?? "Unknown";
});

const mockStatefulProvider = {
    id: "mock-stateful",
    metadata: {
        id: "mock-stateful",
        capabilities: {
            sessionResumption: true,
        },
    },
};

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages,
}));

mock.module("@/prompts/fragments/06-agent-todos", () => ({
    agentTodosFragment: {
        template: todoTemplate,
    },
}));

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName,
    }),
}));

mock.module("@/llm/providers", () => ({
    providerRegistry: {
        getProvider: (id: string) => {
            if (id === "mock-stateful") {
                return mockStatefulProvider;
            }
            return undefined;
        },
        getRegisteredProviders: () => [mockStatefulProvider.metadata],
    },
}));

import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";
import { MessageCompiler } from "@/agents/execution/MessageCompiler";
import { SessionManager } from "@/agents/execution/SessionManager";
import {
    initializeReminderProviders,
    updateReminderData,
    resetSystemReminders,
} from "@/agents/execution/system-reminders";
import { createTenexSystemRemindersMiddleware } from "../system-reminders";

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

    let testDir: string;
    let metadataPath: string;
    let conversationStore: ConversationStore;
    let agent: AgentInstance;
    let sessionManager: SessionManager;
    let project: NDKProject;

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

        sessionManager = new SessionManager(agent, conversationId, workingDirectory);
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

    it("applies separate computed and current-cycle queued reminders to the latest user message", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const ctx = getSystemReminderContext();

        // Queue an ephemeral heuristic reminder
        ctx.queue({
            type: "heuristic",
            content: "Update your todo list before using more tools.",
        });

        const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
        const compiled = await compiler.compile({
            agent,
            project,
            conversation: conversationStore,
            projectBasePath: "/tmp/project",
            workingDirectory,
            currentBranch: "main",
            availableAgents: [agent],
            agentLessons: new Map(),
            mcpManager: undefined,
            nudgeContent: "",
            respondingToPubkey: userPubkey,
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
            ralNumber,
        });

        // Set reminder data (providers run lazily at collect time)
        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPubkey: userPubkey,
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

        // The middleware collects from context automatically via transformParams
        const middleware = createTenexSystemRemindersMiddleware();
        const result = await middleware.transformParams?.({
            params: {
                prompt: toProviderPrompt(compiled.messages as Array<{ role: string; content: unknown }>),
            } as any,
            type: "generate-text" as any,
            model: { provider: "test", modelId: "model" } as any,
        });

        const userPrompt = result?.prompt.find((message) => message.role === "user");
        const textPart = userPrompt?.content[0];
        expect(textPart?.type).toBe("text");
        expect(textPart?.text).toContain("Hello, can you help me?");
        expect(textPart?.text).toContain('<system-reminder type="todo-list">');
        expect(textPart?.text).toContain('<system-reminder type="response-routing">');
        expect(textPart?.text).toContain('<system-reminder type="delegations">');
        expect(textPart?.text).toContain('<system-reminder type="heuristic">');
    });

    it("delivers deferred reminders after advance() while still injecting fresh persistent reminders", async () => {
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
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Follow-up question",
            messageType: "text",
        });

        const ctx = getSystemReminderContext();

        // Queue a supervision message (available at the next collect() call)
        ctx.queue({
            type: "supervision-message",
            content: "Task Tracking Suggestion: create a todo before continuing.",
        });

        sessionManager.saveSession("session-1", "event-1", 1);

        const compiler = new MessageCompiler("mock-stateful", sessionManager, conversationStore);
        const compiled = await compiler.compile({
            agent,
            project,
            conversation: conversationStore,
            projectBasePath: "/tmp/project",
            workingDirectory,
            currentBranch: "main",
            availableAgents: [agent],
            agentLessons: new Map(),
            mcpManager: undefined,
            nudgeContent: "",
            respondingToPubkey: userPubkey,
            pendingDelegations: [],
            completedDelegations: [],
            ralNumber,
        });

        // Set reminder data (providers run lazily at collect time)
        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPubkey: userPubkey,
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

        const userPrompt = result?.prompt.find((message) => message.role === "user");
        const textPart = userPrompt?.content[0];
        expect(compiled.mode).toBe("delta");
        expect(textPart?.type).toBe("text");
        expect(textPart?.text).toContain("Follow-up question");
        expect(textPart?.text).toContain('<system-reminder type="todo-list">');
        expect(textPart?.text).toContain('<system-reminder type="response-routing">');
        expect(textPart?.text).toContain('<system-reminder type="supervision-message">');
    });
});
