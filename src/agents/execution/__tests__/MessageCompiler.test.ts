import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AgentInstance } from "@/agents/types";
import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentMetadataStore } from "@/services/agents";
import { teamService } from "@/services/teams";
import type { NDKProject } from "@nostr-dev-kit/ndk";
import { join } from "node:path";
import { MessageCompiler } from "../MessageCompiler";
import { resetSystemReminders } from "../system-reminders";
import { collectTenexReminderXml } from "./reminder-test-utils";

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

        const reminderXml = await collectTenexReminderXml({
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
        expect(reminderXml).toContain("Your response will be sent to @User.");
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

    it("adds the teams-context summary after the other system fragments", async () => {
        project = {
            dTag: projectId,
            tagValue: (tag: string) => (tag === "d" ? projectId : undefined),
        } as NDKProject;

        const computeTeamContextSpy = spyOn(teamService, "computeTeamContext").mockResolvedValue(undefined);
        const getTeamsForAgentSpy = spyOn(teamService, "getTeamsForAgent").mockResolvedValue([
            {
                name: "design",
                description: "Design team",
                teamLead: "lead-design",
                members: ["lead-design", "agent-slug"],
            },
        ] as never);

        const ralNumber = conversationStore.createRal(agentPubkey);
        const { messages, systemPrompt, counts } = await compile(ralNumber);

        const systemContents = messages
            .filter((message) => message.role === "system")
            .map((message) => message.content);

        expect(computeTeamContextSpy).toHaveBeenCalledTimes(1);
        expect(getTeamsForAgentSpy).toHaveBeenCalledWith("agent-slug", projectId);
        expect(systemContents[2]).toContain("<teams-context>");
        expect(systemContents[2]).toContain("You belong to teams: design");
        expect(systemPrompt).toContain("You belong to teams: design");
        expect(counts.systemPrompt).toBe(3);
        expect(counts.total).toBe(3);
    });
});
