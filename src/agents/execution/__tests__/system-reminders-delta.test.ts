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
            loadedSkills: [],
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
        // Reminders are injected into the last user message
        for (let i = result.length - 1; i >= 0; i--) {
            const m = result[i];
            if (m.role !== "user") continue;
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            const match = text.match(/<system-reminders>[\s\S]*<\/system-reminders>/);
            if (match) return match[0];
        }
        return "";
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

    it("never mutates source messages — injects into last user message via shallow copy", async () => {
        // Turn 1: reminders injected into the last (only) user message
        updateReminderData(makeData());
        const turn1Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-1" },
        ];
        const turn1Result = await collectAndInjectSystemReminders(turn1Messages, undefined);
        // Source message not mutated
        expect(turn1Messages[1].content).toBe("hello");
        // Result has same length — no extra message appended
        expect(turn1Result).toHaveLength(2);
        // Last user message in result has reminders injected
        const resultMsg1 = turn1Result[1].content as string;
        expect(resultMsg1).toContain("hello");
        expect(resultMsg1).toContain("<system-reminders>");

        // Turn 2: change delegations so delta providers emit something
        updateReminderData(makeData({
            pendingDelegations: [{
                delegationConversationId: "del-1",
                recipientPubkey: "delegated-pk-1",
                senderPubkey: agentPubkey,
                prompt: "do task",
                ralNumber: 1,
            }],
        }));
        const turn2Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-1" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "hi there" }] },
            { role: "user" as const, content: "follow up", id: "msg-2" },
        ];
        const turn2Result = await collectAndInjectSystemReminders(turn2Messages, undefined);

        // Source messages not mutated
        expect(turn2Messages[1].content).toBe("hello");
        expect(turn2Messages[3].content).toBe("follow up");
        // Same length — no extra message
        expect(turn2Result).toHaveLength(4);
        // Historical msg-1 untouched in result (cache-stable prefix)
        expect(turn2Result[1].content).toBe("hello");
        // Last user msg-2 has delegations injected
        const resultMsg2 = turn2Result[3].content as string;
        expect(resultMsg2).toContain("follow up");
        expect(resultMsg2).toContain("<delegations>");
    });

    it("reproduces trace 2b1e9086: source messages never mutated, reminders in last user msg", async () => {
        // Exact reproduction of Jaeger trace 2b1e9086328aca1b9000000000000000.
        //
        // The bug: messages are recompiled from scratch by MessageCompiler on each step.
        // With the old decoratedMessages mutation approach, step 2's todo-list injection
        // was lost on step 3.
        //
        // With the shallow-copy approach, each step injects reminders into a NEW object
        // for the last user message. Source arrays are never mutated, preserving cache
        // stability for everything before the last user message. The
        // PendingTodosHeuristic supervision-correction carries the full todo data, so the
        // model still sees todo items on step 3.

        // Snapshot source messages to detect mutation by reference
        function snapshotContents(msgs: { role: string; content: unknown }[]) {
            return msgs.map((m) => {
                if (typeof m.content === "string") return m.content;
                if (Array.isArray(m.content)) return JSON.stringify(m.content);
                return String(m.content);
            });
        }

        // --- Execution 1 (RAL 2): "hello" — full reminders ---
        updateReminderData(makeData());
        const exec1Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-hello" },
        ];
        const exec1Snapshot = snapshotContents(exec1Messages);
        const exec1Result = await collectAndInjectSystemReminders(exec1Messages, undefined);

        // Source not mutated
        expect(snapshotContents(exec1Messages)).toEqual(exec1Snapshot);
        // Same length — reminders injected into last user message, not appended
        expect(exec1Result).toHaveLength(2);
        const exec1UserContent = exec1Result[1].content as string;
        expect(exec1UserContent).toContain("hello");
        expect(exec1UserContent).toContain("<datetime>");
        expect(exec1UserContent).toContain("<response-routing>");

        // --- Execution 2, Step 1: "start a todo list with 3 items" ---
        // All delta providers skip (nothing changed since exec 1).
        updateReminderData(makeData());
        const step1Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-hello" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello!" }] },
            { role: "user" as const, content: "start a todo list with 3 items", id: "msg-todo" },
        ];
        const step1Snapshot = snapshotContents(step1Messages);
        const step1Result = await collectAndInjectSystemReminders(step1Messages, undefined);

        expect(snapshotContents(step1Messages)).toEqual(step1Snapshot);
        // No reminders emitted → returned as-is
        expect(step1Result).toHaveLength(4);

        // --- Agent calls todo_write → 3 todos created ---
        conversationStore.setTodos(agentPubkey, [
            { id: "t1", title: "Define project objectives and scope", description: "Clarify goals", status: "pending" },
            { id: "t2", title: "Research and gather requirements", description: "Collect info", status: "pending" },
            { id: "t3", title: "Execute implementation plan", description: "Implement", status: "pending" },
        ]);

        // --- Execution 2, Step 2: rebuild after tool call ---
        // MessageCompiler recompiles from scratch — step 1's state is NOT carried forward.
        updateReminderData(makeData());
        const step2Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-hello" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello!" }] },
            { role: "user" as const, content: "start a todo list with 3 items", id: "msg-todo" },
            { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "tc1", toolName: "todo_write", args: {} }] },
            { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "tc1", result: "done" }] },
        ];
        const step2Snapshot = snapshotContents(step2Messages);
        const step2Result = await collectAndInjectSystemReminders(step2Messages, undefined);

        // Source not mutated
        expect(snapshotContents(step2Messages)).toEqual(step2Snapshot);
        // Same length — injected into last user message (msg-todo at index 3)
        expect(step2Result).toHaveLength(6);
        // Historical msg-hello untouched in result
        expect(step2Result[1].content).toBe("hello");
        // Last user message has todo-list delta injected
        const step2TodoContent = step2Result[3].content as string;
        expect(step2TodoContent).toContain("start a todo list with 3 items");
        expect(step2TodoContent).toContain("<todo-list>");
        expect(step2TodoContent).toContain("Define project objectives");
        expect(step2TodoContent).toContain("Research and gather requirements");
        expect(step2TodoContent).toContain("Execute implementation plan");

        // --- PendingTodosHeuristic fires → supervision-correction queued ---
        // Real payload from PendingTodosHeuristic.buildCorrectionMessage():
        const supervisionContent = [
            "You have incomplete items in your todo list:\n",
            "- [pending] **Define project objectives and scope** (id: t1): Clarify goals",
            "- [pending] **Research and gather requirements** (id: t2): Collect info",
            "- [pending] **Execute implementation plan** (id: t3): Implement",
            "\nWould you like to address these before finishing your turn?",
            "\nYou can use `todo_write` to update item statuses if needed.",
        ].join("\n");

        const ctx = getSystemReminderContext();
        ctx.queue({
            type: "supervision-correction",
            content: supervisionContent,
        });

        // --- Execution 2, Step 3: rebuild after agent response ---
        // MessageCompiler recompiles from scratch again. Step 2's todo-list injection is NOT
        // carried forward — messages are clean. But supervision-correction carries the todo data.
        updateReminderData(makeData());
        const step3Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-hello" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello!" }] },
            { role: "user" as const, content: "start a todo list with 3 items", id: "msg-todo" },
            { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "tc1", toolName: "todo_write", args: {} }] },
            { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "tc1", result: "done" }] },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "I created 3 items." }] },
        ];
        const step3Snapshot = snapshotContents(step3Messages);
        const step3Result = await collectAndInjectSystemReminders(step3Messages, undefined);

        // Source not mutated
        expect(snapshotContents(step3Messages)).toEqual(step3Snapshot);
        // Same length
        expect(step3Result).toHaveLength(7);
        // Historical msg-hello untouched
        expect(step3Result[1].content).toBe("hello");
        // Last user message (msg-todo) has supervision-correction injected
        const step3TodoContent = step3Result[3].content as string;
        expect(step3TodoContent).toContain("start a todo list with 3 items");
        expect(step3TodoContent).toContain("<supervision-correction>");
        // The supervision-correction carries the full todo data from PendingTodosHeuristic,
        // so the model still sees the todo items even though <todo-list> delta was skipped.
        expect(step3TodoContent).toContain("Define project objectives and scope");
        expect(step3TodoContent).toContain("Research and gather requirements");
        expect(step3TodoContent).toContain("Execute implementation plan");

        // Verify NO source message was mutated across any step
        for (const msgs of [exec1Messages, step1Messages, step2Messages, step3Messages]) {
            for (const m of msgs) {
                if ((m as { id?: string }).id === "msg-hello") {
                    expect(m.content).toBe("hello");
                }
                if ((m as { id?: string }).id === "msg-todo") {
                    expect(m.content).toBe("start a todo list with 3 items");
                }
            }
        }
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

    it("sends loaded-skills on first turn when skills are present", async () => {
        const result = await collectReminders(
            makeData({
                loadedSkills: [
                    {
                        identifier: "test-skill",
                        content: "Do something special",
                        installedFiles: [],
                    },
                ],
            })
        );
        const xml = extractRemindersXml(result);
        expect(xml).toContain("<loaded-skills>");
        expect(xml).toContain("Do something special");
    });

    it("skips loaded-skills when unchanged", async () => {
        const skills = [
            {
                identifier: "test-skill",
                content: "Do something special",
                installedFiles: [] as { eventId: string; relativePath: string; absolutePath: string; success: boolean; error?: string }[],
            },
        ];

        // First turn
        await collectReminders(makeData({ loadedSkills: skills }));

        // Second turn — same skills
        const result = await collectReminders(makeData({ loadedSkills: skills }));
        const xml = extractRemindersXml(result);
        expect(xml).not.toContain("<loaded-skills>");
    });

    it("re-sends loaded-skills when skills change", async () => {
        // First turn
        await collectReminders(
            makeData({
                loadedSkills: [
                    { identifier: "skill-a", content: "A content", installedFiles: [] },
                ],
            })
        );

        // Second turn — different skill
        const result = await collectReminders(
            makeData({
                loadedSkills: [
                    { identifier: "skill-b", content: "B content", installedFiles: [] },
                ],
            })
        );
        const xml = extractRemindersXml(result);
        expect(xml).toContain("<loaded-skills>");
        expect(xml).toContain("B content");
    });

    it("does not emit loaded-skills when no skills are present", async () => {
        const result = await collectReminders(makeData({ loadedSkills: [] }));
        const xml = extractRemindersXml(result);
        expect(xml).not.toContain("<loaded-skills>");
    });
});
