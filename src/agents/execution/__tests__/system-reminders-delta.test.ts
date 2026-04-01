import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInstance } from "@/agents/types";
import {
    initializeReminderProviders,
    resetSystemReminders,
    updateReminderData,
    collectAndInjectSystemReminders,
    type TenexReminderData,
} from "@/agents/execution/system-reminders";
import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { AgentMetadataStore } from "@/services/agents";

const getName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pk-1": "Agent1",
        "delegated-pk-2": "Agent2",
    };
    return names[pubkey] ?? "Unknown";
});

const getDisplayName = mock(
    async (opts: { principalId: string; linkedPubkey?: string }) => {
        const names: Record<string, string> = {
            "user-pubkey": "User",
        };
        return names[opts.linkedPubkey ?? ""] ?? "Unknown";
    }
);

mock.module("@/services/identity", () => ({
    getIdentityService: () => ({
        getName,
        getDisplayName,
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

    function makeData(
        overrides: Partial<TenexReminderData> = {}
    ): TenexReminderData {
        return {
            agent,
            conversation: conversationStore,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
            ...overrides,
        };
    }

    async function collectReminders(data: TenexReminderData) {
        updateReminderData(data);
        const messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello" },
        ];
        return collectAndInjectSystemReminders(messages, undefined);
    }

    function extractRemindersXml(result: { role: string; content: unknown }[]): string {
        const userMsg = result.find((m) => m.role === "user");
        const content = userMsg?.content;
        if (typeof content !== "string") return "";
        const match = content.match(/<system-reminders>[\s\S]*<\/system-reminders>/);
        return match?.[0] ?? "";
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

        resetSystemReminders();
        initializeReminderProviders();
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
        resetSystemReminders();
        mock.restore();
    });

    it("sends full state on first turn", async () => {
        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        expect(xml).toContain("<datetime>");
        expect(xml).toContain("<response-routing>");
    });

    it("skips unchanged providers on subsequent turns", async () => {
        // First turn — full state
        await collectReminders(makeData());

        // Second turn — same data, should skip datetime and response-routing
        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        // Datetime and response-routing should be skipped since nothing changed
        expect(xml).not.toContain("<datetime>");
        expect(xml).not.toContain("<response-routing>");
    });

    it("re-sends when data changes", async () => {
        // First turn
        await collectReminders(makeData());

        // Second turn with different delegations
        const result = await collectReminders(
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
        const xml = extractRemindersXml(result);

        // Delegations changed, should be re-sent
        expect(xml).toContain("<delegations>");
        // Datetime and response-routing unchanged, should be skipped
        expect(xml).not.toContain("<datetime>");
        expect(xml).not.toContain("<response-routing>");
    });

    it("sends todo delta when items change status", async () => {
        // Add a todo
        conversationStore.setTodos(agentPubkey, [
            {
                id: "todo-1",
                title: "Build feature",
                description: "Build the feature",
                status: "pending",
            },
        ]);

        // First turn
        await collectReminders(makeData());

        // Change todo status
        conversationStore.setTodos(agentPubkey, [
            {
                id: "todo-1",
                title: "Build feature",
                description: "Build the feature",
                status: "in_progress",
            },
        ]);

        // Second turn
        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        // Should send a delta update, not full todo list
        expect(xml).toContain("<todo-list>");
        expect(xml).toContain("agent-todos-update");
        expect(xml).toContain("pending → in_progress");
        // Should NOT contain full todo formatting
        expect(xml).not.toContain("<agent-todos>");
    });

    it("sends full todo list when new todo is added", async () => {
        // First turn — no todos
        await collectReminders(makeData());

        // Add a todo
        conversationStore.setTodos(agentPubkey, [
            {
                id: "todo-1",
                title: "Build feature",
                description: "Build the feature",
                status: "pending",
            },
        ]);

        // Second turn
        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        // New todo added — should send delta with "New:" prefix
        expect(xml).toContain("<todo-list>");
        expect(xml).toContain("New:");
        expect(xml).toContain("Build feature");
    });

    it("skips todos when nothing changed", async () => {
        conversationStore.setTodos(agentPubkey, [
            {
                id: "todo-1",
                title: "Build feature",
                description: "Build the feature",
                status: "pending",
            },
        ]);

        // First turn
        await collectReminders(makeData());

        // Second turn — same todos
        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        // Nothing changed — no todo-list reminder at all
        expect(xml).not.toContain("<todo-list>");
    });

    it("passes through queued one-shot reminders regardless of delta state", async () => {
        // First turn
        await collectReminders(makeData());

        // Second turn — queue a one-shot reminder
        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "heuristic",
            content: "Check your todos",
        });

        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        // One-shot should pass through
        expect(xml).toContain("<heuristic>");
        // Delta providers with no changes should be skipped
        expect(xml).not.toContain("<datetime>");
    });

    it("forces full refresh after fullInterval turns", async () => {
        // First turn
        await collectReminders(makeData());

        // Simulate many turns with unchanged data
        // datetime has fullInterval=15, but response-routing has fullInterval=12
        // and conversations has fullInterval=5
        for (let i = 0; i < 4; i++) {
            await collectReminders(makeData());
        }

        // After 5 total turns (1 full + 4 skips), conversations should get a full refresh
        // (but there's no conversationsContent, so it will be null anyway)
        // Let's test with something that has content — response-routing always has content
        // response-routing has fullInterval=12, so after 12 skips it forces full

        // We've done 5 turns already (1 full + 4 skips). Need 8 more for 13 total
        // (turn 1 sets turnsSinceFullState=0, turns 2-13 increment to 12, turn 14 triggers full)
        for (let i = 0; i < 8; i++) {
            await collectReminders(makeData());
        }

        // 13th turn — response-routing should have turnsSinceFullState=12, triggering full
        const result = await collectReminders(makeData());
        const xml = extractRemindersXml(result);

        expect(xml).toContain("<response-routing>");
    });

    it("tracks delta state per conversation", async () => {
        // First conversation
        await collectReminders(makeData());

        // Create a different conversation store
        const testDir2 = join(tmpdir(), `tenex-delta-test2-${Date.now()}`);
        mkdirSync(testDir2, { recursive: true });
        const otherConversation = new ConversationStore(testDir2);
        otherConversation.load(projectId, "conv-other");

        try {
            // First turn on different conversation — should get full state
            const result = await collectReminders(
                makeData({ conversation: otherConversation })
            );
            const xml = extractRemindersXml(result);
            expect(xml).toContain("<datetime>");
            expect(xml).toContain("<response-routing>");
        } finally {
            rmSync(testDir2, { recursive: true, force: true });
        }
    });

    it("handles conversations content appearing and disappearing", async () => {
        // First turn — no conversations content
        await collectReminders(makeData());

        // Second turn — conversations appear
        const result1 = await collectReminders(
            makeData({ conversationsContent: "Agent @foo is working on X" })
        );
        const xml1 = extractRemindersXml(result1);
        expect(xml1).toContain("<conversations>");

        // Third turn — same conversations
        const result2 = await collectReminders(
            makeData({ conversationsContent: "Agent @foo is working on X" })
        );
        const xml2 = extractRemindersXml(result2);
        expect(xml2).not.toContain("<conversations>");

        // Fourth turn — conversations change
        const result3 = await collectReminders(
            makeData({ conversationsContent: "Agent @bar is working on Y" })
        );
        const xml3 = extractRemindersXml(result3);
        expect(xml3).toContain("<conversations>");
    });

    it("resets delta state on resetSystemReminders", async () => {
        // First turn
        await collectReminders(makeData());

        // Second turn — should skip unchanged
        const result1 = await collectReminders(makeData());
        expect(extractRemindersXml(result1)).not.toContain("<datetime>");

        // Reset
        resetSystemReminders();
        initializeReminderProviders();

        // Next turn — should send full again
        const result2 = await collectReminders(makeData());
        expect(extractRemindersXml(result2)).toContain("<datetime>");
    });
});
