/**
 * Integration tests for MessageCompiler's system-reminder unification.
 *
 * These tests verify that:
 * 1. System reminders are appended to the last user message (not added as separate messages)
 * 2. Both full and delta modes include dynamic context (todo state, response context)
 * 3. Multimodal messages are handled correctly
 * 4. Already-wrapped system-reminder content is properly extracted and recombined
 * 5. Message counts are accurate (dynamicContext doesn't inflate message count)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AgentInstance } from "@/agents/types";
import type { NDKProject } from "@nostr-dev-kit/ndk";

// Track mock call counts for verification
let todoTemplateCallCount = 0;
let getNameCallCount = 0;

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "SYSTEM_PROMPT" } },
]);

const todoTemplate = mock(async () => {
    todoTemplateCallCount++;
    return "## Current Todos\n- [ ] Task 1\n- [x] Task 2";
});

const getName = mock(async (pubkey: string) => {
    getNameCallCount++;
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pubkey": "DelegatedAgent",
    };
    return names[pubkey] ?? "Unknown";
});

// Mock a stateful provider for delta mode tests
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

// Mock provider registry to return our mock stateful provider
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

describe("MessageCompiler System Reminder Unification", () => {
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

        // Reset mocks
        buildSystemPromptMessages.mockClear();
        todoTemplate.mockClear();
        getName.mockClear();
        todoTemplateCallCount = 0;
        getNameCallCount = 0;
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        mock.restore();
    });

    describe("Full Mode - System Reminder Injection", () => {
        it("appends dynamic context to last user message as system-reminder", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "Hello, can you help me?",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);

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
                pendingDelegations: [],
                completedDelegations: [],
                ralNumber,
            });

            expect(mode).toBe("full");

            // Find the user message
            const userMessages = messages.filter((m) => m.role === "user");
            expect(userMessages.length).toBe(1);

            const userContent = userMessages[0].content as string;

            // User message should contain original content
            expect(userContent).toContain("Hello, can you help me?");

            // User message should contain system-reminder with dynamic context
            expect(userContent).toContain("<system-reminder>");
            expect(userContent).toContain("</system-reminder>");
            expect(userContent).toContain("Current Todos");
            expect(userContent).toContain("Your response will be sent to @User");
        });

        it("does not add dynamic context as separate messages", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "Test message",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);

            const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
            const { messages, counts } = await compiler.compile({
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

            // Dynamic context count should be 0 (appended to existing message)
            expect(counts.dynamicContext).toBe(0);

            // Total should be system prompt + conversation messages
            // System: 1, Conversation: 1 user message
            expect(counts.systemPrompt).toBe(1);
            expect(counts.conversation).toBe(1);
            expect(counts.total).toBe(2);
        });

        it("combines ephemeral messages into single system-reminder block", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "User query",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);

            const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
            const { messages } = await compiler.compile({
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

            const userMessage = messages.find((m) => m.role === "user");
            const userContent = userMessage?.content as string;

            // Should have only one system-reminder block (combined)
            const reminderMatches = userContent.match(/<system-reminder>/g);
            expect(reminderMatches?.length).toBe(1);

            // Should contain all content
            expect(userContent).toContain("Heuristic warning");
            expect(userContent).toContain("Already wrapped content");
            expect(userContent).toContain("Current Todos");
        });
    });

    describe("Delta Mode - System Reminder Injection", () => {
        it("includes dynamic context in delta mode", async () => {
            // Set up initial conversation exchange
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

            // Add new messages after what will be the cursor position
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

            // Set up session with cursor at position 1 (after first exchange, before new messages)
            // With 4 messages (indices 0,1,2,3), cursor at 1 means we send messages 2 and 3
            sessionManager.saveSession("session-1", "event-1", 1);

            const compiler = new MessageCompiler("mock-stateful", sessionManager, conversationStore);
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

            expect(mode).toBe("delta");

            // Should have 2 messages (user follow-up + agent follow-up response)
            expect(messages.length).toBe(2);

            // Find the user message
            const userMessages = messages.filter((m) => m.role === "user");
            expect(userMessages.length).toBe(1);

            const userContent = userMessages[0].content as string;

            // Should contain the new message
            expect(userContent).toContain("Follow-up question");

            // Should NOT contain old messages
            expect(userContent).not.toContain("Initial message");

            // CRITICAL: Delta mode should still include dynamic context
            expect(userContent).toContain("<system-reminder>");
            expect(userContent).toContain("Current Todos");
            expect(userContent).toContain("Your response will be sent to @User");
        });

        it("regenerates dynamic context fresh (not from stale snapshot)", async () => {
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

            // First compile in delta mode
            todoTemplateCallCount = 0;
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

            // todoTemplate should have been called to generate fresh state
            expect(todoTemplateCallCount).toBeGreaterThan(0);

            // Second compile - should call template again (fresh, not cached)
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

            // Should have called template again (regenerated, not from snapshot)
            expect(todoTemplateCallCount).toBeGreaterThan(previousCallCount);
        });
    });

    describe("Multimodal Message Handling", () => {
        it("appends system-reminder to text part of multimodal user message", async () => {
            // Add a user message with an image URL - the MessageBuilder will
            // convert this to multimodal format (TextPart + ImagePart array)
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "Look at this image https://example.com/image.png",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);

            const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
            const { messages } = await compiler.compile({
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

            const userMessage = messages.find((m) => m.role === "user");
            expect(userMessage).toBeDefined();

            // Content should be multimodal array (converted by MessageBuilder)
            expect(Array.isArray(userMessage?.content)).toBe(true);

            const contentArray = userMessage?.content as Array<{ type: string; text?: string }>;

            // Find the text part
            const textPart = contentArray.find((p) => p.type === "text");
            expect(textPart).toBeDefined();

            // Text part should have system-reminder appended
            expect(textPart?.text).toContain("Look at this image");
            expect(textPart?.text).toContain("<system-reminder>");
            expect(textPart?.text).toContain("Current Todos");

            // Image part should still exist
            const imagePart = contentArray.find((p) => p.type === "image");
            expect(imagePart).toBeDefined();
        });
    });

    describe("Already-Wrapped Content Handling", () => {
        it("extracts and recombines multiple system-reminder blocks", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "Test query",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);

            const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
            const { messages } = await compiler.compile({
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
                    {
                        role: "system",
                        content: "<system-reminder>\nBlock A\n</system-reminder>\n<system-reminder>\nBlock B\n</system-reminder>",
                    },
                ],
            });

            const userMessage = messages.find((m) => m.role === "user");
            const userContent = userMessage?.content as string;

            // Should have exactly one system-reminder block (all combined)
            const openTags = (userContent.match(/<system-reminder>/g) || []).length;
            const closeTags = (userContent.match(/<\/system-reminder>/g) || []).length;
            expect(openTags).toBe(1);
            expect(closeTags).toBe(1);

            // Should contain all inner content
            expect(userContent).toContain("Block A");
            expect(userContent).toContain("Block B");
            expect(userContent).toContain("Current Todos");
        });

        it("handles trailing text after system-reminder blocks", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "Query",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);

            const compiler = new MessageCompiler("openrouter", sessionManager, conversationStore);
            const { messages } = await compiler.compile({
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
                    {
                        role: "system",
                        content: "<system-reminder>\nWrapped\n</system-reminder>\nTrailing text here",
                    },
                ],
            });

            const userMessage = messages.find((m) => m.role === "user");
            const userContent = userMessage?.content as string;

            // Should contain both wrapped and trailing content
            expect(userContent).toContain("Wrapped");
            expect(userContent).toContain("Trailing text here");
        });
    });

    describe("Message Count Accuracy", () => {
        it("does not inflate conversation count with ephemeral injections", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "User message 1",
                messageType: "text",
            });
            const ralNumber = conversationStore.createRal(agentPubkey);
            conversationStore.addMessage({
                pubkey: agentPubkey,
                ral: ralNumber,
                content: "Agent response",
                messageType: "text",
            });
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "User message 2",
                messageType: "text",
            });

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
                ephemeralMessages: [
                    { role: "system", content: "Ephemeral 1" },
                    { role: "system", content: "Ephemeral 2" },
                    { role: "system", content: "Ephemeral 3" },
                ],
            });

            // Conversation count should reflect actual messages, not ephemeral injections
            expect(counts.conversation).toBe(3); // 2 user + 1 agent
            expect(counts.dynamicContext).toBe(0); // Ephemeral content is appended, not added
            expect(counts.total).toBe(4); // 1 system + 3 conversation
        });

        it("conversation count never goes negative", async () => {
            conversationStore.addMessage({
                pubkey: userPubkey,
                content: "Single message",
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
                ephemeralMessages: [
                    { role: "system", content: "Many" },
                    { role: "system", content: "Ephemeral" },
                    { role: "system", content: "Messages" },
                    { role: "system", content: "Here" },
                ],
            });

            // Even with many ephemeral messages, count should be correct
            expect(counts.conversation).toBe(1);
            expect(counts.conversation).toBeGreaterThanOrEqual(0);
            expect(counts.dynamicContext).toBe(0);
        });
    });
});
