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

        project = {} as NDKProject;
        resetSystemReminders();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        resetSystemReminders();
        mock.restore();
    });

    it("coalesces reminder overlays into the user turn while keeping canonical user content untouched", async () => {
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

        expect(assembled.messages).toHaveLength(2);
        expect(assembled.messages[1]).toMatchObject({
            role: "user",
        });
        expect(String(assembled.messages[1]?.content)).toContain("Hello, can you help me?");
        expect(String(assembled.messages[1]?.content)).toContain("<system-reminders>");
        expect(String(assembled.messages[1]?.content)).toContain("<delegations>");
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

        expect(assembled.messages).toHaveLength(2);
        expect(history.messages).toHaveLength(2);
        expect(history.messages[0]?.source.kind).toBe("canonical");
        expect(history.messages[1]?.source.kind).toBe("runtime-overlay");
        expect(history.messages[0]?.content).toBe("Follow up on the task");
        expect(history.messages[1]?.content).toContain("<system-reminders>");
        expect(String(assembled.messages[1]?.content)).toContain("Follow up on the task");
        expect(String(assembled.messages[1]?.content)).toContain("<system-reminders>");
    });
});
