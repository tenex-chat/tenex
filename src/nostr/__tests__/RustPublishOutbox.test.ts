import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { enqueueSignedEventForRustPublish } from "../RustPublishOutbox";

async function createSignedEvent(overrides: Partial<NDKEvent> = {}): Promise<NDKEvent> {
    const signer = NDKPrivateKeySigner.generate();
    const event = new NDKEvent();
    event.kind = overrides.kind ?? 1;
    event.content = overrides.content ?? "signed content";
    event.tags = overrides.tags ?? [["a", "31933:owner:project"], ["e", "conversation-id"]];
    event.created_at = overrides.created_at ?? 1_700_000_000;
    await event.sign(signer);
    return event;
}

describe("RustPublishOutbox", () => {
    let baseDir: string;
    let originalTenexBaseDir: string | undefined;

    beforeEach(async () => {
        originalTenexBaseDir = process.env.TENEX_BASE_DIR;
        baseDir = await mkdtemp(join(tmpdir(), "tenex-rust-publish-outbox-"));
        process.env.TENEX_BASE_DIR = baseDir;
    });

    afterEach(async () => {
        if (originalTenexBaseDir === undefined) {
            delete process.env.TENEX_BASE_DIR;
        } else {
            process.env.TENEX_BASE_DIR = originalTenexBaseDir;
        }
        await rm(baseDir, { recursive: true, force: true });
    });

    it("rejects unsigned events before writing an outbox record", async () => {
        const event = new NDKEvent();
        event.kind = 1;
        event.content = "unsigned";
        event.tags = [];

        await expect(enqueueSignedEventForRustPublish(event)).rejects.toThrow(
            "Cannot enqueue unsigned or incomplete Nostr event"
        );

        await expect(
            readdir(join(baseDir, "daemon", "publish-outbox", "pending"))
        ).rejects.toThrow();
    });

    it("writes a signed immutable event record into the pending outbox", async () => {
        const event = await createSignedEvent();
        const signed = await enqueueSignedEventForRustPublish(event, {
            requestId: "request-1",
            requestSequence: 42,
            requestTimestamp: 1_700_000_123_000,
            correlationId: "agent_completion",
            projectId: "31933:owner:project",
            conversationId: "conversation-id",
            ralNumber: 7,
            timeoutMs: 12_000,
        });

        const recordPath = join(
            baseDir,
            "daemon",
            "publish-outbox",
            "pending",
            `${signed.id}.json`
        );
        const record = JSON.parse(await readFile(recordPath, "utf8"));

        expect(record).toMatchObject({
            schemaVersion: 1,
            status: "accepted",
            request: {
                requestId: "request-1",
                requestSequence: 42,
                requestTimestamp: 1_700_000_123_000,
                correlationId: "agent_completion",
                projectId: "31933:owner:project",
                agentPubkey: signed.pubkey,
                conversationId: "conversation-id",
                ralNumber: 7,
                waitForRelayOk: true,
                timeoutMs: 12_000,
            },
            event: signed,
            attempts: [],
        });
    });

    it("is idempotent when the same event already exists in pending", async () => {
        const event = await createSignedEvent();
        const signed = await enqueueSignedEventForRustPublish(event);

        await enqueueSignedEventForRustPublish(event, {
            requestId: "second-request-for-same-event",
        });

        const pendingDir = join(baseDir, "daemon", "publish-outbox", "pending");
        expect(await readdir(pendingDir)).toEqual([`${signed.id}.json`]);
    });

    it("does not requeue an event already moved to published", async () => {
        const event = await createSignedEvent();
        const signed = await enqueueSignedEventForRustPublish(event);
        const outboxDir = join(baseDir, "daemon", "publish-outbox");
        const pendingPath = join(outboxDir, "pending", `${signed.id}.json`);
        const publishedPath = join(outboxDir, "published", `${signed.id}.json`);

        await mkdir(join(outboxDir, "published"), { recursive: true });
        await rename(pendingPath, publishedPath);

        await enqueueSignedEventForRustPublish(event);

        expect(await readdir(join(outboxDir, "pending"))).toEqual([]);
        expect(await readdir(join(outboxDir, "published"))).toEqual([`${signed.id}.json`]);
    });

    it("rejects conflicting records with the same event id", async () => {
        const event = await createSignedEvent({ content: "original" });
        const signed = await enqueueSignedEventForRustPublish(event);
        const conflictingEvent = {
            rawEvent: () => ({
                ...signed,
                content: "tampered",
            }),
        } as unknown as NDKEvent;

        await expect(enqueueSignedEventForRustPublish(conflictingEvent)).rejects.toThrow(
            "Publish outbox event id conflict"
        );
    });
});
