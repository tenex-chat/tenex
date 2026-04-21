import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getNDK } from "@/nostr/ndkClient";
import { getEventHash, verifyEvent, type Event as NostrEvent } from "nostr-tools";

export interface WorkerProtocolNostrPublishEvent {
    id: string;
    pubkey: string;
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
    sig: string;
}

export async function publishWorkerProtocolNostrEvent(
    rawEvent: unknown,
    agent: { pubkey: string }
): Promise<string[]> {
    const publishEvent = parseWorkerProtocolNostrPublishEvent(rawEvent);

    if (publishEvent.pubkey !== agent.pubkey) {
        throw new Error("Worker publish request pubkey does not match target agent");
    }

    const event = new NDKEvent(getNDK(), publishEvent);

    const relaySet = await event.publish();
    if (relaySet.size === 0) {
        throw new Error("Worker publish request was accepted by 0 relays");
    }

    return [event.id];
}

export function parseWorkerProtocolNostrPublishEvent(
    value: unknown
): WorkerProtocolNostrPublishEvent {
    if (!value || typeof value !== "object") {
        throw new Error("Worker publish request event must be an object");
    }

    const event = value as Record<string, unknown>;
    const id = requireHexString(event, "id", 64);
    const pubkey = requireHexString(event, "pubkey", 64);
    const kind = requireNonNegativeInteger(event, "kind");
    const content = requireString(event, "content");
    const tags = requireTags(event, "tags");
    const createdAt = requireNonNegativeInteger(event, "created_at");
    const sig = requireHexString(event, "sig", 128);

    const publishEvent = {
        id,
        pubkey,
        kind,
        content,
        tags,
        created_at: createdAt,
        sig,
    } satisfies WorkerProtocolNostrPublishEvent;

    const expectedId = getEventHash(publishEvent);
    if (expectedId !== publishEvent.id) {
        throw new Error(
            `Worker publish request id mismatch: expected ${expectedId}, got ${publishEvent.id}`
        );
    }

    const verificationEvent: NostrEvent = {
        ...publishEvent,
        tags: publishEvent.tags.map((tag) => [...tag]),
    };

    if (!verifyEvent(verificationEvent)) {
        throw new Error("Worker publish request signature failed verification");
    }

    return publishEvent;
}

function requireString(object: Record<string, unknown>, key: string): string {
    const value = object[key];
    if (typeof value !== "string") {
        throw new Error(`Worker publish request event.${key} must be a string`);
    }
    return value;
}

function requireHexString(
    object: Record<string, unknown>,
    key: string,
    length: number
): string {
    const value = requireString(object, key);
    if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
        throw new Error(`Worker publish request event.${key} must be ${length} lowercase hex chars`);
    }
    return value;
}

function requireNonNegativeInteger(object: Record<string, unknown>, key: string): number {
    const value = object[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error(`Worker publish request event.${key} must be a non-negative integer`);
    }
    return value;
}

function requireTags(object: Record<string, unknown>, key: string): string[][] {
    const value = object[key];
    if (!Array.isArray(value)) {
        throw new Error(`Worker publish request event.${key} must be an array`);
    }

    return value.map((tag) => {
        if (!Array.isArray(tag) || tag.some((item) => typeof item !== "string")) {
            throw new Error(`Worker publish request event.${key} must contain string arrays`);
        }
        return [...tag] as string[];
    });
}
