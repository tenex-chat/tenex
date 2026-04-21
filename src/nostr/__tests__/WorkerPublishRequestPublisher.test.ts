import { describe, expect, it } from "bun:test";
import {
    parseWorkerProtocolNostrPublishEvent,
    publishWorkerProtocolNostrEvent,
} from "../WorkerPublishRequestPublisher";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

const OTHER_PUBKEY = "b".repeat(64);

describe("WorkerPublishRequestPublisher", () => {
    it("parses strict worker publish events", () => {
        const signedEvent = signedPublishEvent();

        expect(parseWorkerProtocolNostrPublishEvent(signedEvent)).toEqual({
            id: signedEvent.id,
            pubkey: signedEvent.pubkey,
            kind: signedEvent.kind,
            content: "delegate this",
            tags: [["p", OTHER_PUBKEY]],
            created_at: signedEvent.created_at,
            sig: signedEvent.sig,
        });
    });

    it("rejects missing deterministic event identity fields", () => {
        const signedEvent = signedPublishEvent();

        expect(() =>
            parseWorkerProtocolNostrPublishEvent({
                ...signedEvent,
                id: undefined,
            })
        ).toThrow("event.id must be a string");

        expect(() =>
            parseWorkerProtocolNostrPublishEvent({
                ...signedEvent,
                pubkey: signedEvent.pubkey.toUpperCase(),
            })
        ).toThrow("event.pubkey must be 64 lowercase hex chars");
    });

    it("rejects mutated signed events", () => {
        const signedEvent = signedPublishEvent();

        expect(() =>
            parseWorkerProtocolNostrPublishEvent({
                ...signedEvent,
                content: "mutated after signing",
            })
        ).toThrow("id mismatch");

        expect(() =>
            parseWorkerProtocolNostrPublishEvent({
                ...signedEvent,
                id: "c".repeat(64),
            })
        ).toThrow("id mismatch");
    });

    it("rejects publish requests for a different target agent before publishing", async () => {
        const signedEvent = signedPublishEvent();

        await expect(
            publishWorkerProtocolNostrEvent(signedEvent, { pubkey: OTHER_PUBKEY })
        ).rejects.toThrow("pubkey does not match target agent");
    });
});

function signedPublishEvent(): ReturnType<typeof finalizeEvent> {
    return finalizeEvent(
        {
            kind: 1111,
            content: "delegate this",
            tags: [["p", OTHER_PUBKEY]],
            created_at: 1710000800,
        },
        generateSecretKey()
    );
}
