import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm } from "fs/promises";

mock.module("@/prompts/fragments/06-agent-todos", () => ({
    agentTodosFragment: {
        template: async () => "",
    },
}));

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async () => "User",
    }),
}));

import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import type { AgentInstance } from "@/agents/types";
import {
    initializeReminderProviders,
    updateReminderData,
    resetSystemReminders,
} from "../system-reminders";

describe("Current-cycle supervision reminder injection", () => {
    const TEST_DIR = "/tmp/tenex-current-cycle-reminder-test";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-current-cycle-test";
    const AGENT_PUBKEY = "agent-pubkey-123";
    const respondingToPrincipal = {
        id: "nostr:user-pubkey-456",
        transport: "nostr" as const,
        linkedPubkey: "user-pubkey-456",
        kind: "human" as const,
    };

    let store: ConversationStore;
    let agent: AgentInstance;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
        resetSystemReminders();
        initializeReminderProviders();

        agent = {
            name: "TestAgent",
            slug: "test-agent",
            pubkey: AGENT_PUBKEY,
            llmConfig: "default",
            tools: [],
        } as AgentInstance;
    });

    afterEach(async () => {
        resetSystemReminders();
        await rm(TEST_DIR, { recursive: true, force: true });
        mock.restore();
    });

    it("delivers a current-cycle correction once without persisting it to conversation history", async () => {
        store.addMessage({
            pubkey: "user-pubkey-456",
            content: "Please continue",
            messageType: "text",
        });

        const ctx = getSystemReminderContext();

        ctx.queue({
            type: "supervision-correction",
            content: "Fix the previous tool call before continuing.",
        });

        updateReminderData({
            agent,
            conversation: store,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
        });

        const firstReminders = await ctx.collect();

        expect(
            firstReminders.find((r) => r.type === "supervision-correction")?.content
        ).toBe("Fix the previous tool call before continuing.");

        // Second collect should not have the queued reminder (it was consumed)
        updateReminderData({
            agent,
            conversation: store,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
        });

        const secondReminders = await ctx.collect();

        expect(
            secondReminders.some((r) => r.type === "supervision-correction")
        ).toBe(false);

        const messages = await store.buildMessagesForRal(AGENT_PUBKEY, 1);
        expect(
            messages.some(
                (message) =>
                    typeof message.content === "string" &&
                    message.content.includes("Fix the previous tool call")
            )
        ).toBe(false);
    });

    it("does not deliver a queued reminder after clear", async () => {
        const ctx = getSystemReminderContext();

        ctx.queue({
            type: "supervision-correction",
            content: "Current-cycle only",
        });

        // Clear simulates a new execution context
        resetSystemReminders();

        updateReminderData({
            agent,
            conversation: store,
            respondingToPrincipal,
            pendingDelegations: [],
            completedDelegations: [],
        });

        const reminders = await ctx.collect();

        expect(
            reminders.some((r) => r.type === "supervision-correction")
        ).toBe(false);
    });
});
