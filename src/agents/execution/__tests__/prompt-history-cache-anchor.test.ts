import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildPromptHistoryMessages,
    syncPreparedPromptHistoryMessages,
    type RuntimePromptOverlay,
} from "@/agents/execution/prompt-history";
import type { CompiledMessages } from "@/agents/execution/MessageCompiler";
import { ConversationStore } from "@/conversations/ConversationStore";

function buildCompiledMessages(): CompiledMessages {
    return {
        messages: [
            { role: "system", content: "SYSTEM_PROMPT" },
            { role: "user", content: "Continue the task", id: "msg-1" },
        ],
        systemPrompt: "SYSTEM_PROMPT",
        counts: {
            systemPrompt: 1,
            conversation: 1,
            dynamicContext: 0,
            total: 2,
        },
    };
}

function buildReminderOverlay(content: string): RuntimePromptOverlay {
    return {
        overlayType: "system-reminders",
        message: {
            role: "user",
            content,
        },
    };
}

describe("prompt-history cache anchoring", () => {
    const projectId = "project-history-cache";
    const conversationId = "conv-history-cache";
    const agentPubkey = "agent-pubkey";

    let testDir: string;
    let conversationStore: ConversationStore;

    beforeEach(() => {
        testDir = join(tmpdir(), `tenex-history-cache-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });

        conversationStore = new ConversationStore(testDir);
        conversationStore.load(projectId, conversationId);
    });

    afterEach(() => {
        if (testDir) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("keeps system reminder overlays out of prompt history before cache is anchored", () => {
        const result = buildPromptHistoryMessages({
            compiled: buildCompiledMessages(),
            conversationStore,
            agentPubkey,
            runtimeOverlays: [buildReminderOverlay("<system-reminders>full</system-reminders>")],
        });

        expect(result.messages).toHaveLength(2);
        expect(String(result.messages[1]?.content)).toBe("Continue the task");

        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        expect(history.cacheAnchored).toBe(false);
        expect(history.messages).toHaveLength(1);
        expect(history.messages[0]?.source.kind).toBe("canonical");
    });

    it("persists system reminder overlays once cache is anchored", () => {
        conversationStore.markAgentPromptHistoryCacheAnchored(agentPubkey);

        const result = buildPromptHistoryMessages({
            compiled: buildCompiledMessages(),
            conversationStore,
            agentPubkey,
            runtimeOverlays: [buildReminderOverlay("<system-reminders>delta</system-reminders>")],
        });

        expect(result.messages).toHaveLength(3);
        expect(String(result.messages[2]?.content)).toContain("<system-reminders>");

        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        expect(history.cacheAnchored).toBe(true);
        expect(history.messages).toHaveLength(2);
        expect(history.messages[1]?.source.kind).toBe("runtime-overlay");
    });

    it("drops legacy persisted reminder overlays while cache is still cold", () => {
        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        history.messages.push({
            id: "prompt:1",
            role: "user",
            content: "Continue the task",
            source: {
                kind: "canonical",
                sourceMessageId: "msg-1",
            },
        });
        history.messages.push({
            id: "prompt:2",
            role: "user",
            content: "<system-reminders>legacy</system-reminders>",
            source: {
                kind: "runtime-overlay",
                overlayType: "system-reminders",
            },
        });
        history.seenMessageIds.push("msg-1");
        history.nextSequence = 2;

        const result = buildPromptHistoryMessages({
            compiled: buildCompiledMessages(),
            conversationStore,
            agentPubkey,
        });

        expect(result.messages).toHaveLength(2);
        expect(String(result.messages[1]?.content)).toBe("Continue the task");
        expect(conversationStore.getAgentPromptHistory(agentPubkey).messages).toHaveLength(1);
    });

    it("restores cold canonical prompt history from the compiled transcript", () => {
        const history = conversationStore.getAgentPromptHistory(agentPubkey);
        history.messages.push({
            id: "prompt:1",
            role: "user",
            content: "Continue the task\n\n<system-reminders>stale</system-reminders>",
            source: {
                kind: "canonical",
                sourceMessageId: "msg-1",
            },
        });
        history.seenMessageIds.push("msg-1");
        history.nextSequence = 1;

        const result = buildPromptHistoryMessages({
            compiled: buildCompiledMessages(),
            conversationStore,
            agentPubkey,
        });

        expect(result.messages).toHaveLength(2);
        expect(String(result.messages[1]?.content)).toBe("Continue the task");
        expect(conversationStore.getAgentPromptHistory(agentPubkey).messages[0]?.content).toBe(
            "Continue the task"
        );
    });

    it("only syncs prepared latest-user-appends once cache is anchored", () => {
        const base = buildPromptHistoryMessages({
            compiled: buildCompiledMessages(),
            conversationStore,
            agentPubkey,
        });

        expect(
            syncPreparedPromptHistoryMessages({
                conversationStore,
                agentPubkey,
                preparedMessages: [
                    base.messages[0]!,
                    {
                        ...base.messages[1]!,
                        content: "Continue the task\n\n<system-reminders>cold</system-reminders>",
                    },
                ],
            })
        ).toBe(false);

        conversationStore.markAgentPromptHistoryCacheAnchored(agentPubkey);

        expect(
            syncPreparedPromptHistoryMessages({
                conversationStore,
                agentPubkey,
                preparedMessages: [
                    base.messages[0]!,
                    {
                        ...base.messages[1]!,
                        content: "Continue the task\n\n<system-reminders>warm</system-reminders>",
                    },
                ],
            })
        ).toBe(true);

        expect(conversationStore.getAgentPromptHistory(agentPubkey).messages[0]?.content).toBe(
            "Continue the task\n\n<system-reminders>warm</system-reminders>"
        );
    });
});
