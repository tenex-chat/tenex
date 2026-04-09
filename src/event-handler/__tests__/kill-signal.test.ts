/**
 * Tests for the kill-signal Nostr event handler (kind 24136 / TenexKillSignal).
 *
 * The handler must:
 *  1. Route a valid kill-signal event to RuntimeIngressService with the
 *     correct control-plane envelope metadata (isKillSignal, delegationConversationId).
 *  2. Silently ignore events whose kind is not TenexKillSignal.
 *  3. Never append the control-plane envelope to any conversation store
 *     (verified by checking that ConversationStore.addEnvelope is never called).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { handleKillSignalEvent } from "../kill-signal";
import { RuntimeIngressService } from "@/services/ingress/RuntimeIngressService";
import { ConversationStore } from "@/conversations/ConversationStore";
import { NDKKind } from "@/nostr/kinds";
import type { AgentExecutor } from "@/agents/execution/AgentExecutor";
import type { InboundEnvelope } from "@/events/runtime/InboundEnvelope";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNDKEvent(overrides: {
    kind?: number;
    id?: string;
    pubkey?: string;
    created_at?: number;
    content?: string;
    tags?: string[][];
}): NDKEvent {
    const {
        kind = NDKKind.TenexKillSignal,
        id = "killsignal-event-id-abcdef1234567890",
        pubkey = "sender-pubkey-1234567890abcdef1234567890",
        created_at = Math.floor(Date.now() / 1000),
        content = "Kill signal: delegation aborted",
        tags = [],
    } = overrides;

    return {
        kind,
        id,
        pubkey,
        created_at,
        content,
        tags,
        tagValue: (tagName: string) => {
            const found = tags.find((t) => t[0] === tagName);
            return found?.[1] ?? undefined;
        },
        getMatchingTags: (tagName: string) => tags.filter((t) => t[0] === tagName),
    } as unknown as NDKEvent;
}

const mockAgentExecutor = {} as AgentExecutor;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleKillSignalEvent", () => {
    let capturedEnvelopes: Array<{ envelope: InboundEnvelope; adapter: string }>;
    let originalHandleChatMessage: typeof RuntimeIngressService.prototype.handleChatMessage;
    let originalAddEnvelope: typeof ConversationStore.addEnvelope;

    beforeEach(() => {
        capturedEnvelopes = [];

        originalHandleChatMessage = RuntimeIngressService.prototype.handleChatMessage;
        RuntimeIngressService.prototype.handleChatMessage = mock(async (params) => {
            capturedEnvelopes.push({ envelope: params.envelope, adapter: params.adapter });
        });

        originalAddEnvelope = ConversationStore.addEnvelope;
        ConversationStore.addEnvelope = mock(async () => {});
    });

    afterEach(() => {
        RuntimeIngressService.prototype.handleChatMessage = originalHandleChatMessage;
        ConversationStore.addEnvelope = originalAddEnvelope;
    });

    test("routes a valid kill-signal event to RuntimeIngressService with correct envelope metadata", async () => {
        const delegationConversationId = "delegation-conv-id-abcdef1234567890abcdef1234567890abcdef12";
        const event = makeNDKEvent({
            tags: [["delegation", delegationConversationId]],
        });

        await handleKillSignalEvent(event, mockAgentExecutor);

        expect(capturedEnvelopes).toHaveLength(1);
        const { envelope, adapter } = capturedEnvelopes[0];

        expect(adapter).toBe("kill-signal");
        expect(envelope.metadata.isKillSignal).toBe(true);
        expect(envelope.metadata.killSignalDelegationConversationId).toBe(delegationConversationId);
        expect(envelope.metadata.eventKind).toBe(NDKKind.TenexKillSignal);
    });

    test("silently ignores events with a non-kill-signal kind", async () => {
        const event = makeNDKEvent({
            kind: 1, // regular text note — not a kill-signal
            tags: [["delegation", "some-delegation-conv-id"]],
        });

        await handleKillSignalEvent(event, mockAgentExecutor);

        // Handler should return early without forwarding to ingress
        expect(capturedEnvelopes).toHaveLength(0);
    });

    test("silently ignores kill-signal events that are missing the delegation tag", async () => {
        const event = makeNDKEvent({
            tags: [], // no "delegation" tag
        });

        await handleKillSignalEvent(event, mockAgentExecutor);

        // toKillSignalEnvelope returns null → no ingress call
        expect(capturedEnvelopes).toHaveLength(0);
    });

    test("never appends the control-plane kill-signal envelope to any conversation store", async () => {
        const delegationConversationId = "child-conv-id-1234567890abcdef1234567890abcdef1234567890";
        const event = makeNDKEvent({
            tags: [["delegation", delegationConversationId]],
        });

        await handleKillSignalEvent(event, mockAgentExecutor);

        // The envelope must never touch ConversationStore — it is control-plane only
        expect(ConversationStore.addEnvelope).not.toHaveBeenCalled();
    });
});
