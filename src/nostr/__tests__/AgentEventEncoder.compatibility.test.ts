import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { NDKKind } from "@/nostr/kinds";
import {
    buildNip01EventFixture,
    createMockInboundEnvelope,
    publicKeyForSecret,
    signNostrTestEvent,
    toUnsignedNostrEvent,
    verifyNostrEventSignature,
} from "@/test-utils";
import * as projectsModule from "@/services/projects";
import { logger } from "@/utils/logger";
import { AgentEventEncoder } from "../AgentEventEncoder";
import * as ndkClientModule from "../ndkClient";
import type { EventContext } from "../types";
import streamTextDeltaFixture from "@/test-utils/fixtures/nostr/stream-text-delta.compat.json";

function bytesFromHex(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
        throw new Error("Hex string length must be even");
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

describe("AgentEventEncoder stream-text-delta NIP-01 vector", () => {
    beforeEach(() => {
        spyOn(ndkClientModule, "getNDK").mockReturnValue({} as any);
        spyOn(projectsModule, "getProjectContext").mockReturnValue({
            project: {
                tagReference: () => ["a", "31933:testpubkey:test-project"],
                pubkey: "testpubkey",
            },
            agentRegistry: {
                getAgentByPubkey: () => null,
            },
        } as any);
        spyOn(logger, "debug").mockImplementation(() => {});
        spyOn(logger, "info").mockImplementation(() => {});
        spyOn(logger, "warn").mockImplementation(() => {});
        spyOn(logger, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        mock.restore();
    });

    it("produces a stable stream-text-delta event whose canonical payload, hash, and signature match the frozen NIP-01 vector", () => {
        const secretKey = bytesFromHex(streamTextDeltaFixture.secretKeyHex);
        const pubkey = publicKeyForSecret(secretKey);
        const createdAt = streamTextDeltaFixture.created_at;
        const encoder = new AgentEventEncoder();
        const triggeringEnvelope = createMockInboundEnvelope({
            principal: {
                id: "trigger-pubkey",
                transport: "nostr",
                linkedPubkey: "trigger-pubkey",
                kind: "human",
            },
            message: {
                id: "trigger-id",
                transport: "nostr",
                nativeId: "trigger-id",
            },
            metadata: {
                branchName: "feature/alpha",
            },
        });

        const context: EventContext = {
            triggeringEnvelope,
            rootEvent: { id: "root-conv-id" },
            conversationId: "conversation-id",
            model: "anthropic:claude-haiku-4-5",
            ralNumber: 7,
        };

        const event = encoder.encodeStreamTextDelta(
            {
                delta: "hello world",
                sequence: 3,
            },
            context
        );

        const unsigned = toUnsignedNostrEvent(event, {
            pubkey,
            created_at: createdAt,
        });
        const fixture = buildNip01EventFixture(unsigned);
        const signed = signNostrTestEvent(
            {
                kind: unsigned.kind,
                tags: unsigned.tags,
                content: unsigned.content,
                created_at: unsigned.created_at,
            },
            secretKey
        );

        expect(pubkey).toBe(streamTextDeltaFixture.pubkey);
        expect(fixture.normalized).toEqual(streamTextDeltaFixture.normalized);
        expect(fixture.canonicalPayload).toBe(streamTextDeltaFixture.canonicalPayload);
        expect(fixture.eventHash).toBe(streamTextDeltaFixture.eventHash);
        expect(signed.id).toBe(fixture.eventHash);
        expect(signed.pubkey).toBe(pubkey);
        expect(signed.kind).toBe(NDKKind.TenexStreamTextDelta);
        expect(verifyNostrEventSignature(signed)).toBe(true);
        expect(streamTextDeltaFixture.signed.id).toBe(streamTextDeltaFixture.eventHash);
        expect(streamTextDeltaFixture.signed.pubkey).toBe(pubkey);
        expect(streamTextDeltaFixture.signed.kind).toBe(NDKKind.TenexStreamTextDelta);
        expect(verifyNostrEventSignature(streamTextDeltaFixture.signed)).toBe(true);
    });
});
