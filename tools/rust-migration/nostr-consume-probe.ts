import { NDKEvent } from "@nostr-dev-kit/ndk";
import { getEventHash, verifyEvent, type Event as NostrEvent } from "nostr-tools";
import { classifyForDaemon } from "@/nostr/AgentEventDecoder";
import { NostrInboundAdapter } from "@/nostr/NostrInboundAdapter";

interface ProbeResult {
    id: string;
    classification: string;
    envelopeMessageId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readStdinJson(): Promise<unknown> {
    let input = "";

    for await (const chunk of process.stdin as AsyncIterable<Uint8Array | string>) {
        input += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    }

    if (input.trim().length === 0) {
        throw new Error("nostr consume probe expected JSON events on stdin");
    }

    return JSON.parse(input);
}

function parseEvents(value: unknown): NostrEvent[] {
    const events = Array.isArray(value) ? value : isRecord(value) ? value.events : undefined;
    if (!Array.isArray(events)) {
        throw new Error("nostr consume probe input must be an event array or { events }");
    }

    return events.map((event, index) => parseEvent(event, index));
}

function parseEvent(value: unknown, index: number): NostrEvent {
    if (!isRecord(value)) {
        throw new Error(`event ${index} must be an object`);
    }

    if (
        typeof value.id !== "string" ||
        typeof value.pubkey !== "string" ||
        typeof value.created_at !== "number" ||
        typeof value.kind !== "number" ||
        !Array.isArray(value.tags) ||
        typeof value.content !== "string" ||
        typeof value.sig !== "string"
    ) {
        throw new Error(`event ${index} is missing required NIP-01 fields`);
    }

    if (
        !value.tags.every(
            (tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string")
        )
    ) {
        throw new Error(`event ${index} has non-string tags`);
    }

    return {
        id: value.id,
        pubkey: value.pubkey,
        created_at: value.created_at,
        kind: value.kind,
        tags: value.tags as string[][],
        content: value.content,
        sig: value.sig,
    };
}

function toNdkEvent(event: NostrEvent): NDKEvent {
    const ndkEvent = new NDKEvent();
    ndkEvent.id = event.id;
    ndkEvent.pubkey = event.pubkey;
    ndkEvent.created_at = event.created_at;
    ndkEvent.kind = event.kind;
    ndkEvent.tags = event.tags;
    ndkEvent.content = event.content;
    ndkEvent.sig = event.sig;
    return ndkEvent;
}

function consumeEvent(event: NostrEvent): ProbeResult {
    const hash = getEventHash(event);
    if (hash !== event.id) {
        throw new Error(`event ${event.id} has mismatched NIP-01 hash ${hash}`);
    }

    if (!verifyEvent(event)) {
        throw new Error(`event ${event.id} has invalid signature`);
    }

    const ndkEvent = toNdkEvent(event);
    const classification = classifyForDaemon(ndkEvent);
    const envelope = new NostrInboundAdapter().toEnvelope(ndkEvent);

    if (classification !== "conversation") {
        throw new Error(`event ${event.id} classified as ${classification}, expected conversation`);
    }
    if (envelope.message.nativeId !== event.id) {
        throw new Error(`event ${event.id} produced envelope native id ${envelope.message.nativeId}`);
    }
    if (envelope.content !== event.content) {
        throw new Error(`event ${event.id} content changed during envelope conversion`);
    }
    if (envelope.metadata.eventKind !== event.kind) {
        throw new Error(`event ${event.id} kind changed during envelope conversion`);
    }
    if (envelope.metadata.eventTagCount !== event.tags.length) {
        throw new Error(`event ${event.id} tag count changed during envelope conversion`);
    }

    return {
        id: event.id,
        classification,
        envelopeMessageId: envelope.message.id,
    };
}

async function main(): Promise<void> {
    const events = parseEvents(await readStdinJson());
    if (events.length === 0) {
        throw new Error("nostr consume probe expected at least one event");
    }

    const results = events.map(consumeEvent);
    process.stdout.write(`${JSON.stringify({ ok: true, events: results })}\n`);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
