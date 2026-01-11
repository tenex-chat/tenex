import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "STATIC_SYSTEM_A" } },
    { message: { role: "system", content: "STATIC_SYSTEM_B" } },
]);

const todoTemplate = mock(async () => "TODO LIST");
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

import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentMetadataStore } from "@/services/agents";
import { MessageCompiler } from "../MessageCompiler";
import { SessionManager } from "../SessionManager";

describe("MessageCompiler", () => {
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

        sessionManager = new SessionManager(agent, conversationId, workingDirectory);
        project = {} as NDKProject;

        buildSystemPromptMessages.mockClear();
        todoTemplate.mockClear();
        getName.mockClear();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("builds full context for stateless providers", async () => {
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

        const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);

        const { messages, mode } = await compiler.compile({
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
                    prompt: "help",
                    ralNumber,
                },
            ],
            completedDelegations: [],
            ralNumber,
        });

        const contents = messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );

        expect(mode).toBe("full");
        expect(buildSystemPromptMessages).toHaveBeenCalledTimes(1);
        expect(contents[0]).toBe("STATIC_SYSTEM_A");
        expect(contents[1]).toBe("STATIC_SYSTEM_B");
        expect(contents[2]).toContain("hello");
        expect(contents[3]).toContain("hi");
        expect(contents[4]).toContain("TODO LIST");
        expect(contents[5]).toContain("Your response will be sent to @User.");
    });

    it("builds delta context for session-stateful providers", async () => {
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

        sessionManager.saveSession("session-1", "event-1", 1);

        const compiler = new MessageCompiler("claude-code", sessionManager, conversationStore);
        const { messages, mode } = await compiler.compile({
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

        const contents = messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );

        expect(mode).toBe("delta");
        // In delta mode, only new conversation messages are sent - no system context
        // The session already has full context from initial compilation
        expect(contents.join(" ")).not.toContain("STATIC_SYSTEM_A");
        expect(contents.join(" ")).not.toContain("[System Context]");
        expect(contents.join(" ")).not.toContain("old user");
        expect(contents.join(" ")).not.toContain("old agent");
        expect(contents.join(" ")).toContain("new user");
        expect(contents.join(" ")).toContain("new agent");
        expect(messages.length).toBe(2);
    });

    it("falls back to full context when cursor is invalid", async () => {
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

        sessionManager.saveSession("session-1", "event-1", 99);

        const compiler = new MessageCompiler("claude-code", sessionManager, conversationStore);
        const { mode } = await compiler.compile({
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

        expect(mode).toBe("full");
        expect(buildSystemPromptMessages).toHaveBeenCalledTimes(1);
    });

    it("advances the delta cursor between compiles", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "old user",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "new agent",
            messageType: "text",
        });

        sessionManager.saveSession("session-1", "event-1", 0);

        const compiler = new MessageCompiler("claude-code", sessionManager, conversationStore);
        const first = await compiler.compile({
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

        const firstContents = first.messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );

        expect(first.mode).toBe("delta");
        expect(first.counts.conversation).toBe(1);
        expect(firstContents.join(" ")).toContain("new agent");

        const second = await compiler.compile({
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

        const secondContents = second.messages.map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        );

        expect(second.mode).toBe("delta");
        expect(second.counts.conversation).toBe(0);
        expect(secondContents.join(" ")).not.toContain("new agent");
    });

    it("persists cursor advancement for session-stateful providers", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "hello",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            content: "hi",
            messageType: "text",
            ral: ralNumber,
        });

        const compiler = new MessageCompiler("claude-code", sessionManager, conversationStore);
        await compiler.compile({
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
        compiler.advanceCursor();

        const restartedSessionManager = new SessionManager(agent, conversationId, workingDirectory);
        expect(restartedSessionManager.getSession().lastSentMessageIndex).toBe(1);
    });

    it("does not advance cursor for stateless providers", () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "hello",
            messageType: "text",
        });

        const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
        compiler.advanceCursor();

        const restartedSessionManager = new SessionManager(agent, conversationId, workingDirectory);
        expect(restartedSessionManager.getSession().lastSentMessageIndex).toBeUndefined();
    });
});
