import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";
import { IdentityBindingStore } from "@/services/identity/IdentityBindingStoreService";
import { IdentityService } from "@/services/identity/IdentityService";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { MessageCompiler } from "../MessageCompiler";
import {
    initializeReminderProviders,
    resetSystemReminders,
    updateReminderData,
} from "../system-reminders";

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
            agentLessons: new Map(),
            mcpManager: undefined,
            nudgeContent: "",
            respondingToPubkey: userPubkey,
            pendingDelegations: [],
            completedDelegations: [],
            ralNumber,
        });
    }

    beforeEach(() => {
        IdentityService.resetInstance();
        IdentityBindingStore.resetInstance();
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

        project = {} as NDKProject;

        buildSystemPromptMessages.mockClear();
        todoTemplate.mockClear();
        getName.mockClear();
        todoTemplateCallCount = 0;
        resetSystemReminders();
        initializeReminderProviders();
    });

    afterEach(() => {
        IdentityService.resetInstance();
        IdentityBindingStore.resetInstance();
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        resetSystemReminders();
        mock.restore();
    });

    it("returns only rebuilt messages and counts", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const compiled = await compile(ralNumber);

        expect("providerOptions" in compiled).toBe(false);
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

    it("recomputes reminders and rebuilds the full prompt on every refresh", async () => {
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

        const first = await compile(ralNumber);
        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPubkey: userPubkey,
            pendingDelegations: [],
            completedDelegations: [],
        });
        await getSystemReminderContext().collect();

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

        const second = await compile(ralNumber);
        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPubkey: userPubkey,
            pendingDelegations: [],
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

        expect(buildSystemPromptMessages).toHaveBeenCalledTimes(2);
        expect(first.messages).toHaveLength(3);
        expect(second.messages).toHaveLength(5);
        expect(second.messages.find((message) => message.role === "user" && message.content === "Initial message")).toBeDefined();
        expect(second.messages.find((message) => message.role === "user" && message.content === "Follow-up question")).toBeDefined();
        expect(todoTemplateCallCount).toBe(2);
        expect(reminders.map((reminder) => reminder.type)).toContain("delegations");
    });
});
