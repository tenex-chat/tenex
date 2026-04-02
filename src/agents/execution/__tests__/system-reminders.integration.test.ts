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

    it("injects reminders into the last user message, not system messages", async () => {
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

        // Source compiled messages are untouched
        const sourceUserMsg = compiled.messages.find((m) => m.role === "user");
        expect(typeof sourceUserMsg?.content === "string" ? sourceUserMsg.content : "").toBe("Hello, can you help me?");

        // Reminders injected into the last user message (new object)
        const lastUserMsg = result.findLast((m) => m.role === "user");
        expect(lastUserMsg).toBeDefined();
        const userContent = typeof lastUserMsg?.content === "string"
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg?.content);
        expect(userContent).toContain("<response-routing>");
        expect(userContent).toContain("<delegations>");
        expect(userContent).toContain("<heuristic>");

        // System message should be untouched
        const systemMsg = result.findLast((m) => m.role === "system");
        expect(systemMsg).toBeDefined();
        expect(String(systemMsg?.content)).not.toContain("<system-reminders>");
    });

    it("keeps deferred reminders across turns, injected into last user message", async () => {
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
        // Same length — no extra message appended
        expect(result).toHaveLength(4);

        // Reminders injected into last user message
        const lastUser = result.findLast((m) => m.role === "user");
        const lastUserContent = typeof lastUser?.content === "string"
            ? lastUser.content
            : JSON.stringify(lastUser?.content);
        expect(lastUserContent).toContain("Follow-up question");
        expect(lastUserContent).toContain("<response-routing>");
        expect(lastUserContent).toContain("<supervision-message>");

        // System message untouched
        const systemMsg = result.findLast((m) => m.role === "system");
        expect(String(systemMsg?.content)).not.toContain("<system-reminders>");
    });

    it("injects into user message with array content parts", async () => {
        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "heuristic",
            content: "Some reminder",
        });

        const messagesWithNoSystem = [
            { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
        ];

        const result = await collectAndInjectSystemReminders(messagesWithNoSystem, undefined);

        // Same length — injected into existing user message
        expect(result).toHaveLength(1);
        expect(result[0]?.role).toBe("user");
        // Source not mutated
        const sourceContent = messagesWithNoSystem[0].content;
        expect(sourceContent[0].text).toBe("Hello");

        // Result has reminder injected into the text part
        const resultContent = result[0]?.content;
        expect(Array.isArray(resultContent)).toBe(true);
        if (Array.isArray(resultContent)) {
            const textPart = resultContent.find((p: { type: string }) => p.type === "text");
            expect(textPart?.text).toContain("Hello");
            expect(textPart?.text).toContain("<heuristic>");
        }
    });
});
