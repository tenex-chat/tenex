/**
 * Integration tests for MessageCompiler's system-reminder provider option output.
 *
 * These tests verify that:
 * 1. Dynamic reminder content is emitted as providerOptions instead of compile-time prompt mutation
 * 2. Full and delta modes still compute fresh dynamic context
 * 3. Ephemeral reminder content is preserved for middleware-time injection
 * 4. Message counts remain based on actual compiled messages
 */

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
import { AgentMetadataStore } from "@/services/agents";
import { MessageCompiler } from "../MessageCompiler";
import { SessionManager } from "../SessionManager";

function extractSystemReminderRequest(providerOptions: unknown): {
    tags: string[];
    metadata?: Record<string, unknown>;
} {
    const request = (providerOptions as { systemReminders?: { tags?: string[]; metadata?: Record<string, unknown> } })
        .systemReminders;

    if (!request || !Array.isArray(request.tags)) {
        throw new Error("Expected systemReminders provider options");
    }

    return {
        tags: request.tags,
        metadata: request.metadata,
    };
}

describe("MessageCompiler System Reminder Provider Options", () => {
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
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        mock.restore();
    });

    it("emits dynamic context as provider options in full mode", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
        const { messages, providerOptions, mode } = await compiler.compile({
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
        expect(messages.find((message) => message.role === "user")?.content).toBe("Hello, can you help me?");

        const request = extractSystemReminderRequest(providerOptions);
        expect(request.tags).toEqual(["dynamic-context"]);
        expect(request.metadata?.dynamicContext).toContain("Current Todos");
        expect(request.metadata?.dynamicContext).toContain("Your response will be sent to @User");
    });

    it("does not add dynamic context as separate messages", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Test message",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
        const { counts } = await compiler.compile({
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

        expect(counts.dynamicContext).toBe(0);
        expect(counts.systemPrompt).toBe(1);
        expect(counts.conversation).toBe(1);
        expect(counts.total).toBe(2);
    });

    it("preserves ephemeral reminder content for middleware-time combination", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "User query",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);

        const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
        const { providerOptions } = await compiler.compile({
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
            ephemeralMessages: [
                { role: "system", content: "Heuristic warning: Check your todos!" },
                { role: "system", content: "<system-reminder>\nAlready wrapped content\n</system-reminder>" },
            ],
        });

        const request = extractSystemReminderRequest(providerOptions);
        expect(request.tags).toEqual(["dynamic-context", "ephemeral"]);
        expect(request.metadata?.ephemeralContents).toEqual([
            "Heuristic warning: Check your todos!",
            "<system-reminder>\nAlready wrapped content\n</system-reminder>",
        ]);
    });

    it("includes fresh dynamic context in delta mode", async () => {
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
        const { messages, providerOptions, mode } = await compiler.compile({
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

        expect(mode).toBe("delta");
        expect(messages).toHaveLength(2);
        expect(messages.find((message) => message.role === "user")?.content).toBe("Follow-up question");

        const request = extractSystemReminderRequest(providerOptions);
        expect(request.tags).toEqual(["dynamic-context"]);
        expect(request.metadata?.dynamicContext).toContain("Current Todos");
        expect(request.metadata?.dynamicContext).toContain("Your response will be sent to @User");
    });

    it("regenerates dynamic context on every compile", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "First message",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "First response",
            messageType: "text",
        });
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Second message",
            messageType: "text",
        });

        sessionManager.saveSession("session-1", "event-1", 1);

        const compiler = new MessageCompiler("mock-stateful", sessionManager, conversationStore);

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

        const previousCallCount = todoTemplateCallCount;

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

        expect(todoTemplateCallCount).toBeGreaterThan(previousCallCount);
    });
});
