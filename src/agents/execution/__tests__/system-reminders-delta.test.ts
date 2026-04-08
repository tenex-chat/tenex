import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstance } from "@/agents/types";
import type { TenexReminderData } from "@/agents/execution/system-reminders";
import { resetSystemReminders } from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { AgentMetadataStore } from "@/services/agents";
import { SkillService } from "@/services/skill/SkillService";
import { SkillWhitelistService } from "@/services/skill";
import { collectTenexReminderXml } from "./reminder-test-utils";

mock.module("@/services/identity", () => ({
    getIdentityService: () => ({
        getName: async (pubkey: string) => {
            const names: Record<string, string> = {
                "user-pubkey": "User",
                "delegated-pk-1": "Agent1",
                "delegated-pk-2": "Agent2",
            };
            return names[pubkey] ?? "Unknown";
        },
        getNameSync: (pubkey: string) => {
            const names: Record<string, string> = {
                "user-pubkey": "User",
                "delegated-pk-1": "Agent1",
                "delegated-pk-2": "Agent2",
            };
            return names[pubkey] ?? "Unknown";
        },
        getDisplayName: async (opts: { linkedPubkey?: string }) =>
            opts.linkedPubkey === "user-pubkey" ? "User" : "Unknown",
        getDisplayNameSync: (opts: { linkedPubkey?: string }) =>
            opts.linkedPubkey === "user-pubkey" ? "User" : "Unknown",
    }),
}));

describe("delta-based system reminders", () => {
    const projectId = "project-delta";
    const conversationId = "conv-delta";
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
    let listAvailableSkillsSpy: ReturnType<typeof spyOn>;
    let whitelistSpy: ReturnType<typeof spyOn>;

    function makeData(
        overrides: Partial<TenexReminderData> = {}
    ): TenexReminderData {
        return {
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
            loadedSkills: [],
            ...overrides,
        };
    }

    async function collectReminderXml(data: TenexReminderData): Promise<string> {
        return await collectTenexReminderXml(data);
    }

    beforeEach(() => {
        testDir = join(tmpdir(), `tenex-delta-test-${Date.now()}`);
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

        listAvailableSkillsSpy = spyOn(SkillService, "getInstance").mockReturnValue({
            listAvailableSkills: async () => [],
        } as never);
        whitelistSpy = spyOn(SkillWhitelistService.getInstance(), "getWhitelistedSkills").mockReturnValue([]);
        SkillWhitelistService.getInstance().setInstalledSkills([]);

        resetSystemReminders();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        listAvailableSkillsSpy?.mockRestore();
        whitelistSpy?.mockRestore();
        resetSystemReminders();
        mock.restore();
    });

    it("sends full state on first turn", async () => {
        const xml = await collectReminderXml(makeData());

        expect(xml).toContain("<datetime>");
        expect(xml).toContain("<response-routing>");
    });

    it("skips unchanged providers on subsequent turns", async () => {
        await collectReminderXml(makeData());

        const xml = await collectReminderXml(makeData());

        expect(xml).not.toContain("<datetime>");
        expect(xml).not.toContain("<response-routing>");
    });

    it("re-sends when delegation state changes", async () => {
        await collectReminderXml(makeData());

        const xml = await collectReminderXml(
            makeData({
                pendingDelegations: [
                    {
                        delegationConversationId: "del-1",
                        recipientPubkey: "delegated-pk-1",
                        senderPubkey: agentPubkey,
                        prompt: "do task",
                        ralNumber: 1,
                    },
                ],
            })
        );

        expect(xml).toContain("<delegations>");
        expect(xml).not.toContain("<datetime>");
        expect(xml).not.toContain("<response-routing>");
    });

    it("sends todo deltas when items change status", async () => {
        conversationStore.setTodos(agentPubkey, [
            {
                id: "todo-1",
                title: "Build feature",
                description: "Build the feature",
                status: "pending",
            },
        ]);

        await collectReminderXml(makeData());

        conversationStore.setTodos(agentPubkey, [
            {
                id: "todo-1",
                title: "Build feature",
                description: "Build the feature",
                status: "in_progress",
            },
        ]);

        const xml = await collectReminderXml(makeData());

        expect(xml).toContain("<todo-list>");
        expect(xml).toContain("agent-todos-update");
        expect(xml).toContain("pending → in_progress");
        expect(xml).not.toContain("<agent-todos>");
    });

    it("persists reminder delta state across conversation reloads", async () => {
        await collectReminderXml(makeData());
        await conversationStore.save();

        const reloadedStore = new ConversationStore(testDir);
        reloadedStore.load(projectId, conversationId);
        conversationStore = reloadedStore;

        const xml = await collectReminderXml(makeData());

        expect(xml).not.toContain("<datetime>");
        expect(xml).not.toContain("<response-routing>");
        expect(
            reloadedStore.getContextManagementReminderState(agentPubkey)?.providers["datetime"]
        ).toBeDefined();
    });

    it("filters blocked skills from the available-skills reminder snapshot", async () => {
        agent = {
            ...agent,
            blockedSkills: ["local-skill"],
        };
        listAvailableSkillsSpy.mockReturnValue({
            listAvailableSkills: async () => [
                {
                    identifier: "local-skill",
                    eventId: "d".repeat(64),
                    scope: "shared",
                    content: "blocked content",
                    installedFiles: [],
                },
                {
                    identifier: "allowed-skill",
                    eventId: "e".repeat(64),
                    scope: "shared",
                    content: "allowed content",
                    installedFiles: [],
                },
            ],
        } as never);
        whitelistSpy.mockReturnValue([
            {
                eventId: "d".repeat(64),
                identifier: "local-skill",
                shortId: "local-short",
                kind: 4202 as never,
                name: "Local Skill",
                description: "Blocked skill",
                whitelistedBy: ["pubkey"],
            },
            {
                eventId: "e".repeat(64),
                identifier: "allowed-skill",
                shortId: "allowed-short",
                kind: 4202 as never,
                name: "Allowed Skill",
                description: "Allowed skill",
                whitelistedBy: ["pubkey"],
            },
        ] as never);

        const xml = await collectReminderXml(makeData({ agent }));

        expect(xml).toContain("allowed-skill");
        expect(xml).not.toContain("local-skill");
        expect(xml).not.toContain("local-short");
    });
});
