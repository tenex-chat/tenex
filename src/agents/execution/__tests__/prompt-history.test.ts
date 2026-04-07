import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstance } from "@/agents/types";
import { MessageCompiler } from "@/agents/execution/MessageCompiler";
import { buildPromptHistoryMessages } from "@/agents/execution/prompt-history";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentMetadataStore } from "@/services/agents";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { collectTenexReminderOverlay } from "./reminder-test-utils";

const buildSystemPromptMessages = mock(async () => [
    { message: { role: "system", content: "SYSTEM_PROMPT" } },
]);

const getIdentityService = () => ({
    getName: async (pubkey: string) => {
        const names: Record<string, string> = {
            "user-pubkey": "User",
            "agent-a": "AgentA",
            "agent-b": "AgentB",
        };
        return names[pubkey] ?? "Unknown";
    },
    getNameSync: (pubkey: string) => {
        const names: Record<string, string> = {
            "user-pubkey": "User",
            "agent-a": "AgentA",
            "agent-b": "AgentB",
        };
        return names[pubkey] ?? "Unknown";
    },
    getDisplayName: async (opts: { linkedPubkey?: string; principalId?: string }) => {
        const linkedPubkey = opts.linkedPubkey;
        if (linkedPubkey === "user-pubkey" || opts.principalId?.includes("user-pubkey")) {
            return "User";
        }
        if (linkedPubkey === "agent-a") return "AgentA";
        if (linkedPubkey === "agent-b") return "AgentB";
        return "Unknown";
    },
    getDisplayNameSync: (opts: { linkedPubkey?: string; principalId?: string }) => {
        const linkedPubkey = opts.linkedPubkey;
        if (linkedPubkey === "user-pubkey" || opts.principalId?.includes("user-pubkey")) {
            return "User";
        }
        if (linkedPubkey === "agent-a") return "AgentA";
        if (linkedPubkey === "agent-b") return "AgentB";
        return "Unknown";
    },
});

mock.module("@/prompts/utils/systemPromptBuilder", () => ({
    buildSystemPromptMessages,
}));

mock.module("@/services/identity", () => ({
    getIdentityService,
}));

describe("per-agent prompt history", () => {
    const projectId = "project-history";
    const conversationId = "conv-history";
    const respondingToPrincipal = {
        id: "nostr:user-pubkey",
        transport: "nostr" as const,
        linkedPubkey: "user-pubkey",
        kind: "human" as const,
    };

    let testDir: string;
    let metadataPath: string;
    let conversationStore: ConversationStore;
    let project: NDKProject;
    let agentA: AgentInstance;
    let agentB: AgentInstance;

    function createProjectMock(): NDKProject {
        return {
            dTag: projectId,
            tagValue: (name: string) => (name === "d" ? projectId : undefined),
        } as NDKProject;
    }

    function createAgent(pubkey: string, slug: string): AgentInstance {
        return {
            name: slug,
            slug,
            pubkey,
            tools: [],
            llmConfig: "openrouter:dummy",
            createMetadataStore: (convId: string) =>
                new AgentMetadataStore(convId, slug, metadataPath),
        } as AgentInstance;
    }

    async function compile(agent: AgentInstance, ralNumber: number, availableAgents: AgentInstance[]) {
        const compiler = new MessageCompiler(conversationStore);
        return compiler.compile({
            agent,
            project,
            conversation: conversationStore,
            projectBasePath: "/tmp/project",
            workingDirectory: "/tmp/project",
            currentBranch: "main",
            availableAgents,
            pendingDelegations: [],
            completedDelegations: [],
            ralNumber,
        });
    }

    beforeEach(() => {
        testDir = join(tmpdir(), `tenex-prompt-history-${Date.now()}`);
        metadataPath = join(testDir, "metadata-root");
        mkdirSync(testDir, { recursive: true });
        mkdirSync(metadataPath, { recursive: true });

        conversationStore = new ConversationStore(testDir);
        conversationStore.load(projectId, conversationId);
        project = createProjectMock();
        agentA = createAgent("agent-a", "agent-a");
        agentB = createAgent("agent-b", "agent-b");

        resetSystemReminders();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        resetSystemReminders();
        mock.restore();
    });

    it("seeds once and only appends newly visible canonical messages", async () => {
        conversationStore.addMessage({
            pubkey: "user-pubkey",
            content: "Initial request",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentA.pubkey);

        const firstCompiled = await compile(agentA, ralNumber, [agentA]);
        const first = buildPromptHistoryMessages({
            compiled: firstCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
        });

        expect(first.messages).toHaveLength(2);
        expect(conversationStore.getAgentPromptHistory(agentA.pubkey).messages).toHaveLength(1);

        const second = buildPromptHistoryMessages({
            compiled: firstCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
        });

        expect(second.messages).toHaveLength(2);
        expect(conversationStore.getAgentPromptHistory(agentA.pubkey).messages).toHaveLength(1);

        conversationStore.addMessage({
            pubkey: agentA.pubkey,
            ral: ralNumber,
            content: "First response",
            messageType: "text",
        });
        conversationStore.addMessage({
            pubkey: "user-pubkey",
            content: "Second request",
            messageType: "text",
        });

        const nextCompiled = await compile(agentA, ralNumber, [agentA]);
        const next = buildPromptHistoryMessages({
            compiled: nextCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
        });

        expect(next.messages).toHaveLength(4);
        expect(conversationStore.getAgentPromptHistory(agentA.pubkey).messages).toHaveLength(3);
        expect(conversationStore.getAgentPromptHistory(agentA.pubkey).messages.map((message) => message.content)).toEqual([
            "Initial request",
            "First response",
            "Second request",
        ]);
    });

    it("keeps prompt history isolated per agent view", async () => {
        conversationStore.addMessage({
            pubkey: "user-pubkey",
            content: "Kick off",
            messageType: "text",
        });
        const ralA = conversationStore.createRal(agentA.pubkey);
        conversationStore.addMessage({
            pubkey: agentB.pubkey,
            ral: ralA,
            content: "I already checked that file.",
            messageType: "text",
        });

        const compiledForA = await compile(agentA, ralA, [agentA, agentB]);
        const compiledForB = await compile(agentB, ralA, [agentA, agentB]);

        buildPromptHistoryMessages({
            compiled: compiledForA,
            conversationStore,
            agentPubkey: agentA.pubkey,
        });
        buildPromptHistoryMessages({
            compiled: compiledForB,
            conversationStore,
            agentPubkey: agentB.pubkey,
        });

        const historyA = conversationStore.getAgentPromptHistory(agentA.pubkey).messages;
        const historyB = conversationStore.getAgentPromptHistory(agentB.pubkey).messages;

        expect(historyA).toHaveLength(2);
        expect(historyB).toHaveLength(2);
        expect(historyA[1]?.role).toBe("user");
        expect(historyA[1]?.content).toBe("I already checked that file.");
        expect(historyB[1]?.role).toBe("assistant");
        expect(historyB[1]?.content).toBe("I already checked that file.");
    });

    it("appends runtime overlays instead of rewriting the same historical user message", async () => {
        conversationStore.addMessage({
            pubkey: "user-pubkey",
            content: "Track the todos",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentA.pubkey);

        conversationStore.setTodos(agentA.pubkey, [
            { id: "todo-1", title: "Track work", description: "", status: "pending" },
        ]);

        const firstCompiled = await compile(agentA, ralNumber, [agentA]);
        const firstOverlay = await collectTenexReminderOverlay({
            agent: agentA,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
            loadedSkills: [],
        });
        buildPromptHistoryMessages({
            compiled: firstCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
            runtimeOverlay: firstOverlay,
        });

        conversationStore.setTodos(agentA.pubkey, [
            { id: "todo-1", title: "Track work", description: "", status: "in_progress" },
        ]);

        const secondCompiled = await compile(agentA, ralNumber, [agentA]);
        const secondOverlay = await collectTenexReminderOverlay({
            agent: agentA,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
            loadedSkills: [],
        });
        buildPromptHistoryMessages({
            compiled: secondCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
            runtimeOverlay: secondOverlay,
        });

        const history = conversationStore.getAgentPromptHistory(agentA.pubkey).messages;
        const overlayMessages = history.filter((message) => message.source.kind === "runtime-overlay");

        expect(history[0]?.content).toBe("Track the todos");
        expect(overlayMessages).toHaveLength(2);
        expect(String(overlayMessages[0]?.content)).toContain("<agent-todos>");
        expect(String(overlayMessages[1]?.content)).toContain("pending → in_progress");
        expect(String(history[0]?.content)).not.toContain("<system-reminders>");
    });

    it("appends explicit delegation completion marker records", async () => {
        conversationStore.addMessage({
            pubkey: "user-pubkey",
            content: "Delegate this task",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentA.pubkey);
        conversationStore.addDelegationMarker(
            {
                delegationConversationId: "delegation-1",
                recipientPubkey: agentB.pubkey,
                parentConversationId: conversationId,
                initiatedAt: Math.floor(Date.now() / 1000),
                status: "pending",
            },
            agentA.pubkey,
            ralNumber
        );

        const firstCompiled = await compile(agentA, ralNumber, [agentA, agentB]);
        buildPromptHistoryMessages({
            compiled: firstCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
        });

        conversationStore.updateDelegationMarker("delegation-1", {
            status: "completed",
            completedAt: Math.floor(Date.now() / 1000),
        });

        const secondCompiled = await compile(agentA, ralNumber, [agentA, agentB]);
        buildPromptHistoryMessages({
            compiled: secondCompiled,
            conversationStore,
            agentPubkey: agentA.pubkey,
        });

        const history = conversationStore.getAgentPromptHistory(agentA.pubkey).messages;
        const delegationEntries = history.filter(
            (message) => message.source.sourceMessageId?.includes("record:delegation")
        );

        expect(delegationEntries).toHaveLength(2);
        expect(String(delegationEntries[0]?.content)).toContain("DELEGATION IN PROGRESS");
        expect(delegationEntries[0]?.source.kind).toBe("canonical");
        expect(String(delegationEntries[1]?.content)).toContain("DELEGATION COMPLETED");
        expect(delegationEntries[1]?.source.kind).toBe("canonical");
    });
});
