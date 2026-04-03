import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm } from "node:fs/promises";

mock.module("@/services/PubkeyService", () => ({
    getPubkeyService: () => ({
        getName: async () => "User",
    }),
}));

import { ConversationStore } from "@/conversations/ConversationStore";
import { getSystemReminderContext } from "@/llm/system-reminder-context";
import { resetSystemReminders } from "../system-reminders";

describe("Current-cycle supervision reminder injection", () => {
    const TEST_DIR = "/tmp/tenex-current-cycle-reminder-test";
    const PROJECT_ID = "test-project";
    const CONVERSATION_ID = "conv-current-cycle-test";
    const AGENT_PUBKEY = "agent-pubkey-123";

    let store: ConversationStore;

    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
        store = new ConversationStore(TEST_DIR);
        store.load(PROJECT_ID, CONVERSATION_ID);
        resetSystemReminders();
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

        const firstReminders = await ctx.collect();

        expect(
            firstReminders.find((r) => r.type === "supervision-correction")?.content
        ).toBe("Fix the previous tool call before continuing.");

        // Second collect should not have the queued reminder (it was consumed)
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

        const reminders = await ctx.collect();

        expect(
            reminders.some((r) => r.type === "supervision-correction")
        ).toBe(false);
    });
});
