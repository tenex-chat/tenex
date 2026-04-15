import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstance } from "@/agents/types";
import { MessageCompiler } from "@/agents/execution/MessageCompiler";
import { buildPromptHistoryMessages } from "@/agents/execution/prompt-history";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import {
    prepareTenexReminderRequest,
} from "./reminder-test-utils";

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "SYSTEM_PROMPT" } },
]);

const getIdentityService = () => ({
    getName: async (pubkey: string) => {
        const names: Record<string, string> = {
            "user-pubkey": "User",
            "delegated-pubkey": "DelegatedAgent",
        };
        return names[pubkey] ?? "Unknown";
    },
    getNameSync: (pubkey: string) => {
        const names: Record<string, string> = {
            "user-pubkey": "User",
            "delegated-pubkey": "DelegatedAgent",
        };
        return names[pubkey] ?? "Unknown";
    },
    getDisplayName: async (opts: { linkedPubkey?: string; principalId?: string }) =>
        opts.linkedPubkey === "user-pubkey" || opts.principalId?.includes("user-pubkey")
            ? "User"
            : "Unknown",
    getDisplayNameSync: (opts: { linkedPubkey?: string; principalId?: string }) =>
        opts.linkedPubkey === "user-pubkey" || opts.principalId?.includes("user-pubkey")
            ? "User"
            : "Unknown",
});

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages,
}));

mock.module("@/services/identity", () => ({
    getIdentityService,
}));

describe("system reminder prompt integration", () => {
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

    function createProjectMock(): NDKProject {
        return {
            dTag: projectId,
            tagValue: (name: string) => (name === "d" ? projectId : undefined),
        } as NDKProject;
    }

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

        project = createProjectMock();
        resetSystemReminders();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        resetSystemReminders();
        mock.restore();
    });

    it("appends reminder blocks to the latest user message in the outgoing request", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        conversationStore.markAgentPromptHistoryCacheAnchored(agentPubkey);
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);

        const prepared = await prepareTenexReminderRequest({
            messages: compiled.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
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
            },
        });

        expect(prepared.runtimeOverlays).toHaveLength(0);

        const sourceUserMsg = compiled.messages.find((m) => m.role === "user");
        expect(typeof sourceUserMsg?.content === "string" ? sourceUserMsg.content : "").toBe(
            "Hello, can you help me?"
        );

        expect(prepared.messages).toHaveLength(2);
        expect(prepared.messages[1]).toMatchObject({
            role: "user",
        });
        expect(String(prepared.messages[1]?.content)).toContain("Hello, can you help me?");
        expect(String(prepared.messages[1]?.content)).toContain("<system-reminders>");
        expect(String(prepared.messages[1]?.content)).toContain("<delegations>");
    });

    it("does not mutate canonical transcript records when latest-user-append reminders are applied", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Follow up on the task",
            messageType: "text",
        });
        conversationStore.markAgentPromptHistoryCacheAnchored(agentPubkey);
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);
        const promptHistoryResult = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
        });

        const prepared = await prepareTenexReminderRequest({
            messages: promptHistoryResult.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
                pendingDelegations: [],
                completedDelegations: [],
            },
        });

        await conversationStore.save();

        const reloaded = new ConversationStore(testDir);
        reloaded.load(projectId, conversationId);
        const history = reloaded.getAgentPromptHistory(agentPubkey);

        expect(prepared.runtimeOverlays).toHaveLength(0);
        expect(prepared.messages).toHaveLength(2);
        expect(history.messages).toHaveLength(1);
        expect(history.messages[0]?.source.kind).toBe("canonical");
        expect(history.messages[0]?.content).toBe("Follow up on the task");
        expect(String(prepared.messages[1]?.content)).toContain("Follow up on the task");
        expect(String(prepared.messages[1]?.content)).toContain("<system-reminders>");
    });

    it("emits reminder blocks as a secondary system message while history is not cache-anchored", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Open grok.com in a browser",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "I opened the page.",
            messageType: "text",
        });
        const compiled = await compile(ralNumber);
        const promptHistoryResult = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
        });

        const prepared = await prepareTenexReminderRequest({
            messages: promptHistoryResult.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
                pendingDelegations: [],
                completedDelegations: [],
            },
        });

        expect(prepared.runtimeOverlays).toHaveLength(0);
        expect(prepared.messages[0]?.role).toBe("system");
        expect(prepared.messages[1]?.role).toBe("system");
        expect(String(prepared.messages[1]?.content)).toContain("<system-reminders>");
        expect(String(prepared.messages[1]?.content)).toContain("<response-routing>");
        expect(
            prepared.messages.some(
                (message) =>
                    message.role === "user"
                    && String(message.content).includes("Open grok.com in a browser")
                    && String(message.content).includes("<system-reminders>")
            )
        ).toBe(false);
        expect(
            prepared.messages.some(
                (message) =>
                    message.role === "user"
                    && String(message.content).includes("Open grok.com in a browser")
            )
        ).toBe(true);
    });

    it("does not repeat delegation reminders when the conversation already has a delegation marker", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Delegate this task",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addDelegationMarker(
            {
                delegationConversationId: "delegation-1",
                recipientPubkey: "delegated-pubkey",
                parentConversationId: conversationId,
                initiatedAt: Math.floor(Date.now() / 1000),
                status: "pending",
            },
            agentPubkey,
            ralNumber
        );
        const compiled = await compile(ralNumber);

        const prepared = await prepareTenexReminderRequest({
            messages: compiled.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
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
            },
        });

        const renderedPrompt = prepared.messages
            .map((message) => String(message.content))
            .join("\n\n");

        expect(renderedPrompt).toContain("DELEGATION IN PROGRESS");
        expect(renderedPrompt).not.toContain("<delegations>");
        expect(renderedPrompt).not.toContain("You have delegations to:");
    });

    it("does not repeat delegation reminders when the latest tool result already shows the delegation", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Delegate this task",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "",
            messageType: "tool-call",
            toolData: [
                {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "delegate",
                    input: {
                        recipient: "delegated-agent",
                        prompt: "Do a task",
                    },
                },
            ],
        });
        conversationStore.addMessage({
            pubkey: agentPubkey,
            ral: ralNumber,
            content: "",
            messageType: "tool-result",
            toolData: [
                {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "delegate",
                    output: {
                        type: "json",
                        value: {
                            success: true,
                            message: "Delegated task. The agent will wake you up when ready with the response.",
                            delegationConversationId: "delegation-1",
                        },
                    },
                },
            ],
        });
        const compiled = await compile(ralNumber);

        const prepared = await prepareTenexReminderRequest({
            messages: compiled.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
                pendingDelegations: [
                    {
                        delegationConversationId: "delegation-1234567890abcdef",
                        recipientPubkey: "delegated-pubkey",
                        senderPubkey: agentPubkey,
                        prompt: "Do a task",
                        ralNumber,
                    },
                ],
                completedDelegations: [],
            },
        });

        const renderedPrompt = prepared.messages
            .map((message) => String(message.content))
            .join("\n\n");

        expect(renderedPrompt).not.toContain("<delegations>");
        expect(renderedPrompt).not.toContain("You have delegations to:");
    });

    it("does not persist queued current-cycle reminders in prompt history", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Continue the task",
            messageType: "text",
        });
        conversationStore.markAgentPromptHistoryCacheAnchored(agentPubkey);
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);
        const promptHistoryResult = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
        });

        getSystemReminderContext().queue({
            type: "supervision-correction",
            content: "Fix the previous tool call before continuing.",
        });

        const prepared = await prepareTenexReminderRequest({
            messages: promptHistoryResult.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
                pendingDelegations: [],
                completedDelegations: [],
            },
        });
        const assembled = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
            runtimeOverlays: prepared.runtimeOverlays,
        });
        const renderedPrompt = prepared.messages
            .map((message) => String(message.content))
            .join("\n\n");

        expect(prepared.runtimeOverlays).toHaveLength(0);
        expect(renderedPrompt).toContain("<system-reminders>");
        expect(renderedPrompt).toContain("Fix the previous tool call");
        expect(assembled.messages).toHaveLength(2);
        expect(String(assembled.messages[1]?.content)).toBe("Continue the task");

        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        expect(history.messages).toHaveLength(1);
        expect(history.messages[0]?.source.kind).toBe("canonical");
        expect(history.messages[0]?.content).toBe("Continue the task");
    });

    it("does not persist durable reminder overlays before cache is anchored", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Continue the task",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);
        const promptHistoryResult = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
        });

        const prepared = await prepareTenexReminderRequest({
            messages: promptHistoryResult.messages,
            data: {
                agent,
                conversation: conversationStore,
                respondingToPrincipal,
                loadedSkills: [],
                pendingDelegations: [],
                completedDelegations: [],
            },
        });
        const assembled = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
            runtimeOverlays: prepared.runtimeOverlays,
        });

        expect(prepared.runtimeOverlays).toHaveLength(0);
        expect(assembled.messages).toHaveLength(2);

        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        expect(history.messages).toHaveLength(1);
        expect(history.messages[0]?.source.kind).toBe("canonical");
        expect(String(history.messages[0]?.content)).not.toContain("<system-reminders>");
    });
});
