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
import { AgentMetadataStore } from "@/services/agents";

const getName = mock(async (pubkey: string) => {
    const names: Record<string, string> = {
        "user-pubkey": "User",
        "delegated-pk-1": "Agent1",
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

describe("system reminders prefix cache stability", () => {
    const projectId = "project-cache";
    const conversationId = "conv-cache";
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

    beforeEach(() => {
        testDir = join(tmpdir(), `tenex-cache-test-${Date.now()}`);
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

    it("preserves historical injections across 3 iterations", async () => {
        // --- Iteration 1: [system, user:"hello" id:m1] ---
        // Full reminders emitted into the only user message.
        updateReminderData(makeData());
        const iter1Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "m1" },
        ];
        const output1 = await collectAndInjectSystemReminders(iter1Messages, undefined, conversationId);

        expect(output1[1].content).not.toBe("hello");
        expect(output1[1].content as string).toContain("<system-reminders>");
        const frozenMsg1Content = output1[1].content;

        // --- Iteration 2: [system, user:"hello" id:m1, assistant:"Hi!", user:"2" id:m2] ---
        // All delta providers skip (nothing changed).
        updateReminderData(makeData());
        const iter2Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "m1" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi!" }] },
            { role: "user" as const, content: "2", id: "m2" },
        ];
        const output2 = await collectAndInjectSystemReminders(iter2Messages, undefined, conversationId);

        // m1 must have its historical injection preserved (prefix cache stability)
        expect(output2[1].content).toEqual(frozenMsg1Content);
        // m2 has no new reminders and no stored injection → plain content
        expect(output2[3].content).toBe("2");

        // --- Iteration 3: [system, user:"hello" id:m1, assistant:"Hi!", user:"2" id:m2, assistant:"Sure!", user:"3" id:m3] ---
        // Delegations changed → new delta emitted into the last user message (m3).
        updateReminderData(makeData({
            pendingDelegations: [{
                delegationConversationId: "del-1",
                recipientPubkey: "delegated-pk-1",
                senderPubkey: agentPubkey,
                prompt: "do task",
                ralNumber: 1,
            }],
        }));
        const iter3Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "m1" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi!" }] },
            { role: "user" as const, content: "2", id: "m2" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Sure!" }] },
            { role: "user" as const, content: "3", id: "m3" },
        ];
        const output3 = await collectAndInjectSystemReminders(iter3Messages, undefined, conversationId);

        // m1 still has its historical injection
        expect(output3[1].content).toEqual(frozenMsg1Content);
        // m2 had no injection stored → stays plain
        expect(output3[3].content).toBe("2");
        // m3 gets the new delegations delta
        expect(output3[5].content as string).toContain("<delegations>");
    });

    it("preserves all historical injections when a 4th user message arrives", async () => {
        // Build up to iteration 3 (same as above to get injections on m1 and m3)
        updateReminderData(makeData());
        await collectAndInjectSystemReminders(
            [
                { role: "system" as const, content: "SYSTEM" },
                { role: "user" as const, content: "hello", id: "m1" },
            ],
            undefined,
            conversationId,
        );
        const frozenMsg1Content = (await collectAndInjectSystemReminders(
            [
                { role: "system" as const, content: "SYSTEM" },
                { role: "user" as const, content: "hello", id: "m1" },
            ],
            undefined,
            conversationId,
        ))[1].content;

        // Trigger delegations for m3
        updateReminderData(makeData({
            pendingDelegations: [{
                delegationConversationId: "del-1",
                recipientPubkey: "delegated-pk-1",
                senderPubkey: agentPubkey,
                prompt: "do task",
                ralNumber: 1,
            }],
        }));
        const output3 = await collectAndInjectSystemReminders(
            [
                { role: "system" as const, content: "SYSTEM" },
                { role: "user" as const, content: "hello", id: "m1" },
                { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi!" }] },
                { role: "user" as const, content: "2", id: "m2" },
                { role: "assistant" as const, content: [{ type: "text" as const, text: "Sure!" }] },
                { role: "user" as const, content: "3", id: "m3" },
            ],
            undefined,
            conversationId,
        );
        const frozenMsg3Content = output3[5].content;

        // --- Iteration 4: all deltas skip, m4 arrives ---
        updateReminderData(makeData({
            pendingDelegations: [{
                delegationConversationId: "del-1",
                recipientPubkey: "delegated-pk-1",
                senderPubkey: agentPubkey,
                prompt: "do task",
                ralNumber: 1,
            }],
        }));
        const iter4Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "m1" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hi!" }] },
            { role: "user" as const, content: "2", id: "m2" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Sure!" }] },
            { role: "user" as const, content: "3", id: "m3" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "OK" }] },
            { role: "user" as const, content: "4", id: "m4" },
        ];
        const output4 = await collectAndInjectSystemReminders(iter4Messages, undefined, conversationId);

        // Both m1 and m3 injections preserved
        expect(output4[1].content).toEqual(frozenMsg1Content);
        expect(output4[3].content).toBe("2");
        expect(output4[5].content).toEqual(frozenMsg3Content);
        // m4 has no new reminders
        expect(output4[7].content).toBe("4");
    });

    it("appends new reminders to stored history when same message stays last", async () => {
        // Step 1: msg-todo is last user message, gets todo-list injection
        conversationStore.setTodos(agentPubkey, [
            { id: "t1", title: "Task 1", description: "Do task 1", status: "pending" },
        ]);
        updateReminderData(makeData());
        const step1Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-hello" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello!" }] },
            { role: "user" as const, content: "start todos", id: "msg-todo" },
        ];
        const step1Result = await collectAndInjectSystemReminders(step1Messages, undefined, conversationId);
        const step1Content = step1Result[3].content as string;
        expect(step1Content).toContain("<todo-list>");

        // Step 2: msg-todo stays last, tool messages appended after it.
        // Todos changed status → new delta emitted. Should APPEND to stored XML.
        conversationStore.setTodos(agentPubkey, [
            { id: "t1", title: "Task 1", description: "Do task 1", status: "in_progress" },
        ]);
        updateReminderData(makeData());
        const step2Messages = [
            { role: "system" as const, content: "SYSTEM" },
            { role: "user" as const, content: "hello", id: "msg-hello" },
            { role: "assistant" as const, content: [{ type: "text" as const, text: "Hello!" }] },
            { role: "user" as const, content: "start todos", id: "msg-todo" },
            { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "tc1", toolName: "todo_write", args: {} }] },
            { role: "tool" as const, content: [{ type: "tool-result" as const, toolCallId: "tc1", result: "done" }] },
        ];
        const step2Result = await collectAndInjectSystemReminders(step2Messages, undefined, conversationId);
        const step2Content = step2Result[3].content as string;

        // Should contain BOTH the original todo-list AND the new delta update
        expect(step2Content).toContain("<todo-list>");
        expect(step2Content).toContain("pending → in_progress");
    });
});
