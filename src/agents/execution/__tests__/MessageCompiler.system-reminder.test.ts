import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

let todoTemplateCallCount = 0;

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "SYSTEM_PROMPT" } },
]);

const todoTemplate = mock(async () => {
    todoTemplateCallCount++;
    return "## Current Todos\n- [ ] Task 1\n- [x] Task 2";
});

const getName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pubkey": "DelegatedAgent",
        "completed-pubkey": "CompletedAgent",
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
import { MessageCompiler } from "../MessageCompiler";
import { SessionManager } from "../SessionManager";
import {
    initializeReminderProviders,
    updateReminderData,
    resetSystemReminders,
} from "../system-reminders";

describe("MessageCompiler and TENEX system reminders", () => {
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
        testDir = join(tmpdir(), `msg-compiler-reminder-${Date.now()}`);
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

        buildSystemPromptMessages.mockClear();
        todoTemplate.mockClear();
        getName.mockClear();
        todoTemplateCallCount = 0;
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

    it("does not return provider options from compile in full mode", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

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
            pendingDelegations: [],
            completedDelegations: [],
            ralNumber,
        });

        expect("providerOptions" in compiled).toBe(false);
        expect(compiled.mode).toBe("full");
        expect(compiled.messages.find((message) => message.role === "user")?.content).toBe(
            "Hello, can you help me?"
        );
        expect(compiled.counts.dynamicContext).toBe(0);
        expect(compiled.counts.systemPrompt).toBe(1);
        expect(compiled.counts.conversation).toBe(1);
        expect(compiled.counts.total).toBe(2);
    });

    it("collects separate semantic reminders for todo list, routing, and delegations", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "User query",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

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
            completedDelegations: [
                {
                    delegationConversationId: "delegation-2",
                    recipientPubkey: "completed-pubkey",
                    senderPubkey: agentPubkey,
                    transcript: [],
                    completedAt: Date.now(),
                    ralNumber,
                    status: "completed",
                },
            ],
        });

        const reminders = await getSystemReminderContext().collect();
        const types = reminders.map((r) => r.type);

        expect(types).toEqual([
            "todo-list",
            "response-routing",
            "delegations",
        ]);
    });

    it("keeps delta compilation separate from reminder collection and recomputes reminders on each refresh", async () => {
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
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "Follow-up response",
            messageType: "text",
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

        expect(compiled.mode).toBe("delta");
        expect(compiled.messages).toHaveLength(2);
        expect(compiled.messages.find((message) => message.role === "user")?.content).toBe(
            "Follow-up question"
        );

        // First update + collect
        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPubkey: userPubkey,
            pendingDelegations: [],
            completedDelegations: [],
        });
        await getSystemReminderContext().collect();

        const previousCallCount = todoTemplateCallCount;

        // Second update + collect should recompute (providers run each time)
        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPubkey: userPubkey,
            pendingDelegations: [],
            completedDelegations: [],
        });

        const reminders = await getSystemReminderContext().collect();
        const types = reminders.map((r) => r.type);

        expect(types).toEqual([
            "todo-list",
            "response-routing",
        ]);
        expect(todoTemplateCallCount).toBeGreaterThan(previousCallCount);
    });
});
