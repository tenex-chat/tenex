import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { join } from "node:path";
import { MessageCompiler } from "../MessageCompiler";
import {
    initializeReminderProviders,
    resetSystemReminders,
    updateReminderData,
} from "../system-reminders";

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "STATIC_SYSTEM_A" } },
    { message: { role: "system", content: "STATIC_SYSTEM_B" } },
]);

const getName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pubkey": "Delegated",
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

describe("MessageCompiler", () => {
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

    async function compile(ralNumber: number, extra: Partial<Parameters<MessageCompiler["compile"]>[0]> = {}) {
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
            ...extra,
        });
    }

    beforeEach(() => {
        testDir = join(tmpdir(), `message-compiler-${Date.now()}`);
        metadataPath = join(testDir, "metadata-root");
        mkdirSync(testDir, { recursive: true });
        mkdirSync(metadataPath, { recursive: true });

        conversationStore = new ConversationStore(testDir);
        conversationStore.load(projectId, conversationId);

        agent = {
            name: "Agent",
            slug: "agent-slug",
            pubkey: agentPubkey,
            tools: [],
            llmConfig: "openrouter:dummy",
            createMetadataStore: (convId: string) =>
                new AgentMetadataStore(convId, "agent-slug", metadataPath),
        } as AgentInstance;

        project = {} as NDKProject;

        buildSystemPromptMessages.mockClear();
        getName.mockClear();
        resetSystemReminders();
        initializeReminderProviders();
    });

    afterEach(() => {
        resetSystemReminders();
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("builds the full prompt with system and conversation messages", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "hello",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "hi",
            messageType: "text",
        });

        const { messages, counts } = await compile(ralNumber, {
            pendingDelegations: [
                {
                    delegationConversationId: "delegation-1",
                    recipientPubkey: "delegated-pubkey",
                    senderPubkey: agentPubkey,
                    prompt: "help",
                    ralNumber,
                },
            ],
        });

        const contents = messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );

        expect(buildSystemPromptMessages).toHaveBeenCalledTimes(1);
        expect(contents[0]).toBe("STATIC_SYSTEM_A");
        expect(contents[1]).toBe("STATIC_SYSTEM_B");
        expect(contents[2]).toContain("hello");
        expect(contents[3]).toContain("hi");
        expect(counts.systemPrompt).toBe(2);
        expect(counts.conversation).toBe(2);
        expect(counts.total).toBe(4);

        updateReminderData({
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [
                {
                    delegationConversationId: "delegation-1",
                    recipientPubkey: "delegated-pubkey",
                    senderPubkey: agentPubkey,
                    prompt: "help",
                    ralNumber,
                },
            ],
            completedDelegations: [],
        });
        const reminders = await getSystemReminderContext().collect();
        const reminderContent = JSON.stringify(reminders);
        expect(reminderContent).toContain("Your response will be sent to @User.");
    });

    it("rebuilds the full prompt on every compile", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "old user",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "old agent",
            messageType: "text",
        });

        const first = await compile(ralNumber);
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "new user",
            messageType: "text",
        });
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "new agent",
            messageType: "text",
        });
        const second = await compile(ralNumber);

        const firstContents = first.messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );
        const secondContents = second.messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );

        expect(buildSystemPromptMessages).toHaveBeenCalledTimes(2);
        expect(firstContents.join(" ")).toContain("old user");
        expect(firstContents.join(" ")).not.toContain("new user");
        expect(secondContents.join(" ")).toContain("STATIC_SYSTEM_A");
        expect(secondContents.join(" ")).toContain("old user");
        expect(secondContents.join(" ")).toContain("old agent");
        expect(secondContents.join(" ")).toContain("new user");
        expect(secondContents.join(" ")).toContain("new agent");
        expect(second.counts.systemPrompt).toBe(2);
        expect(second.counts.conversation).toBe(4);
    });

    it("can skip MCP resource discovery for prompt rebuilds", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "hello",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        await compile(ralNumber, {
            includeMcpResources: false,
        });

        expect(buildSystemPromptMessages).toHaveBeenCalledTimes(1);
        expect(buildSystemPromptMessages.mock.calls[0]?.[0]).toMatchObject({
            includeMcpResources: false,
        });
    });

    it("includes meta-model and variant prompts in the rebuilt system prompt", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "hello",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const { messages, counts } = await compile(ralNumber, {
            metaModelSystemPrompt: "META_PROMPT",
            variantSystemPrompt: "VARIANT_PROMPT",
        });

        const systemContents = messages
            .filter((message) => message.role === "system")
            .map((message) => message.content);

        expect(systemContents).toContain("STATIC_SYSTEM_A");
        expect(systemContents).toContain("STATIC_SYSTEM_B");
        expect(systemContents).toContain("META_PROMPT");
        expect(systemContents).toContain("VARIANT_PROMPT");
        expect(counts.systemPrompt).toBe(4);
        expect(counts.conversation).toBe(1);
    });
});
