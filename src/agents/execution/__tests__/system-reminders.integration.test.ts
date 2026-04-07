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
import { collectTenexReminderOverlay, collectTenexReminderOverlays } from "./reminder-test-utils";

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

describe("system reminder overlay integration", () => {
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

    it("keeps reminder overlays as standalone user messages while preserving canonical user content", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Hello, can you help me?",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);

        const overlay = await collectTenexReminderOverlay({
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
        });

        expect(overlay).toBeDefined();
        expect(overlay?.overlayType).toBe("system-reminders");
        expect(overlay?.message.role).toBe("user");
        expect(overlay?.message.content).toContain("<response-routing>");
        expect(overlay?.message.content).toContain("<delegations>");

        const sourceUserMsg = compiled.messages.find((m) => m.role === "user");
        expect(typeof sourceUserMsg?.content === "string" ? sourceUserMsg.content : "").toBe(
            "Hello, can you help me?"
        );

        const assembled = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
            runtimeOverlay: overlay,
        });

        expect(assembled.messages).toHaveLength(3);
        expect(assembled.messages[1]).toMatchObject({
            role: "user",
        });
        expect(String(assembled.messages[1]?.content)).toContain("Hello, can you help me?");
        expect(String(assembled.messages[1]?.content)).not.toContain("<system-reminders>");
        expect(assembled.messages[2]).toMatchObject({
            role: "user",
        });
        expect(String(assembled.messages[2]?.content)).toContain("<system-reminders>");
        expect(String(assembled.messages[2]?.content)).toContain("<delegations>");
    });

    it("persists runtime overlays in prompt history without altering canonical transcript content", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Follow up on the task",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);

        const overlay = await collectTenexReminderOverlay({
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            loadedSkills: [],
            pendingDelegations: [],
            completedDelegations: [],
        });
        const assembled = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
            runtimeOverlay: overlay,
        });

        await conversationStore.save();

        const reloaded = new ConversationStore(testDir);
        reloaded.load(projectId, conversationId);
        const history = reloaded.getAgentPromptHistory(agentPubkey);

        expect(assembled.messages).toHaveLength(3);
        expect(history.messages).toHaveLength(2);
        expect(history.messages[0]?.source.kind).toBe("canonical");
        expect(history.messages[1]?.source.kind).toBe("runtime-overlay");
        expect(history.messages[0]?.content).toBe("Follow up on the task");
        expect(history.messages[1]?.content).toContain("<system-reminders>");
        expect(String(assembled.messages[1]?.content)).toContain("Follow up on the task");
        expect(String(assembled.messages[1]?.content)).not.toContain("<system-reminders>");
        expect(String(assembled.messages[2]?.content)).toContain("<system-reminders>");
    });

    it("does not persist queued current-cycle reminders in prompt history", async () => {
        conversationStore.addMessage({
            pubkey: userPubkey,
            content: "Continue the task",
            messageType: "text",
        });
        const ralNumber = conversationStore.createRal(agentPubkey);
        const compiled = await compile(ralNumber);

        getSystemReminderContext().queue({
            type: "supervision-correction",
            content: "Fix the previous tool call before continuing.",
        });

        const overlays = await collectTenexReminderOverlays({
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            loadedSkills: [],
            pendingDelegations: [],
            completedDelegations: [],
        });
        const overlay = overlays.find((entry) => entry.persistInHistory === false);
        const assembled = buildPromptHistoryMessages({
            compiled,
            conversationStore,
            agentPubkey,
            runtimeOverlays: overlays,
        });

        expect(overlays).toHaveLength(2);
        expect(overlay?.persistInHistory).toBe(false);
        expect(String(overlay?.message.content)).toContain("Fix the previous tool call");
        expect(assembled.messages).toHaveLength(3);
        expect(String(assembled.messages[2]?.content)).toContain("<system-reminders>");
        expect(String(assembled.messages[2]?.content)).not.toContain("Fix the previous tool call");

        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        expect(history.messages).toHaveLength(2);
        expect(history.messages[0]?.source.kind).toBe("canonical");
        expect(history.messages[1]?.source.kind).toBe("runtime-overlay");
        expect(history.messages[0]?.content).toBe("Continue the task");
        expect(String(history.messages[1]?.content)).toContain("<system-reminders>");
        expect(String(history.messages[1]?.content)).not.toContain("Fix the previous tool call");
    });
});
