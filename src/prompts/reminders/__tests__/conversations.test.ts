import { describe, expect, test } from "bun:test";
import {
    renderConversationsReminderDelta,
    type ConversationsReminderSnapshot,
} from "@/prompts/reminders/conversations";

describe("conversations reminder deltas", () => {
    test("reports ended active conversations instead of resending the full snapshot", () => {
        const previous: ConversationsReminderSnapshot = {
            active: [
                {
                    conversationId: "conversation-1234567890",
                    title: "Agent 1 Engagement",
                    summary: "Agent 1 introduced itself and offered help.",
                    agentName: "Agent 1",
                    agentPubkey: "agent-1",
                    isStreaming: false,
                    startedAt: 1_700_000_000_000,
                    lastActivityAt: 1_700_000_000_000,
                    messageCount: 2,
                },
            ],
            recent: [],
        };
        const current: ConversationsReminderSnapshot = {
            active: [],
            recent: [],
        };

        const delta = renderConversationsReminderDelta(previous, current);

        expect(delta).toContain("Active conversation ended");
        expect(delta).toContain("Agent 1 Engagement");
        expect(delta).not.toContain("<active>");
        expect(delta).not.toContain("<recent>");
    });
});
