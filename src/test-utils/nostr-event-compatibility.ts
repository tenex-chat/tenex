import type { NDKEvent } from "@nostr-dev-kit/ndk";
import {
    finalizeEvent,
    getEventHash,
    getPublicKey,
    serializeEvent,
    verifyEvent,
    type Event,
    type EventTemplate,
    type UnsignedEvent,
    type VerifiedEvent,
} from "nostr-tools";

export interface NormalizedNostrEvent {
    kind: number;
    content: string;
    tags: string[][];
    pubkey?: string;
    created_at?: number;
}

export interface CompatibilityEventFixture {
    normalized: NormalizedNostrEvent;
    canonicalPayload: string;
    eventHash: string;
}

export function normalizeNostrEvent(
    event: NDKEvent | Event | UnsignedEvent | NormalizedNostrEvent
): NormalizedNostrEvent {
    const kind = event.kind;
    const content = event.content;
    const tags = event.tags;

    if (kind === undefined) {
        throw new Error("Cannot normalize Nostr event without kind");
    }
    if (content === undefined) {
        throw new Error("Cannot normalize Nostr event without content");
    }
    if (!tags) {
        throw new Error("Cannot normalize Nostr event without tags");
    }

    return {
        kind,
        content,
        tags: tags.map((tag) => [...tag]),
        pubkey: "pubkey" in event ? event.pubkey : undefined,
        created_at: event.created_at,
    };
}

export function toUnsignedNostrEvent(
    event: NDKEvent | NormalizedNostrEvent,
    overrides: {
        pubkey: string;
        created_at: number;
    }
): UnsignedEvent {
    const normalized = normalizeNostrEvent(event);

    return {
        kind: normalized.kind,
        content: normalized.content,
        tags: normalized.tags,
        pubkey: overrides.pubkey,
        created_at: overrides.created_at,
    };
}

export function canonicalNostrPayload(event: UnsignedEvent): string {
    return serializeEvent(event);
}

export function createCompatibilityFixture(event: UnsignedEvent): CompatibilityEventFixture {
    return {
        normalized: normalizeNostrEvent(event),
        canonicalPayload: canonicalNostrPayload(event),
        eventHash: getEventHash(event),
    };
}

export function signCompatibilityEvent(
    template: EventTemplate,
    secretKey: Uint8Array
): VerifiedEvent {
    return finalizeEvent(template, secretKey);
}

export function verifyCompatibilityEvent(event: Event): boolean {
    return verifyEvent(event);
}

export function publicKeyForSecret(secretKey: Uint8Array): string {
    return getPublicKey(secretKey);
}
