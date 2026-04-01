import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstance } from "@/agents/types";
import { MessageCompiler } from "@/agents/execution/MessageCompiler";
import {
    initializeReminderProviders,
    resetSystemReminders,
    updateReminderData,
    collectAndInjectSystemReminders,
} from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";
import type { NDKProject } from "@nostr-dev-kit/ndk";

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

describe("system reminder injection integration", () => {
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

        const result = await collectAndInjectSystemReminders(compiled.messages, undefined);

        // Reminders should be in the system message
        const systemMsg = result.findLast((m) => m.role === "system");
        expect(systemMsg).toBeDefined();
        expect(systemMsg?.content).toContain("<response-routing>");
        expect(systemMsg?.content).toContain("<delegations>");
        expect(systemMsg?.content).toContain("<heuristic>");

        // User message should be untouched — no XML injected
        const userMsg = result.find((m) => m.role === "user");
        expect(JSON.stringify(userMsg?.content)).not.toContain("<system-reminders>");
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

        const result = await collectAndInjectSystemReminders(compiled.messages, undefined);

        expect(compiled.messages).toHaveLength(4);

        // Reminders in system message
        const systemMsg = result.findLast((m) => m.role === "system");
        expect(systemMsg?.content).toContain("<response-routing>");
        expect(systemMsg?.content).toContain("<supervision-message>");

        // Last user message untouched
        const lastUser = result.findLast((m) => m.role === "user");
        expect(JSON.stringify(lastUser?.content)).not.toContain("<system-reminders>");
    });

    it("prepends a system message when prompt has none", async () => {
        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "heuristic",
            content: "Some reminder",
        });

        const messagesWithNoSystem = [
            { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
        ];

        const result = await collectAndInjectSystemReminders(messagesWithNoSystem, undefined);

        expect(result[0]?.role).toBe("system");
        expect(result[0]?.content).toContain("<heuristic>");
        // User message should still be there and untouched
        expect(result[1]?.role).toBe("user");
    });
});
