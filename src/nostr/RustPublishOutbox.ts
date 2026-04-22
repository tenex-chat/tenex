import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "@/services/ConfigService";
import { logger } from "@/utils/logger";
import type { NDKEvent } from "@nostr-dev-kit/ndk";

const PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RustPublishOutboxContext {
    requestId?: string;
    requestSequence?: number;
    requestTimestamp?: number;
    correlationId?: string;
    projectId?: string;
    conversationId?: string;
    ralNumber?: number;
    waitForRelayOk?: boolean;
    timeoutMs?: number;
}

interface SignedNostrEvent {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
}

interface PublishOutboxRecord {
    schemaVersion: number;
    status: "accepted";
    acceptedAt: number;
    request: {
        requestId: string;
        requestSequence: number;
        requestTimestamp: number;
        correlationId: string;
        projectId: string;
        agentPubkey: string;
        conversationId: string;
        ralNumber: number;
        waitForRelayOk: boolean;
        timeoutMs: number;
    };
    event: SignedNostrEvent;
    attempts: [];
}

export async function enqueueSignedEventForRustPublish(
    event: NDKEvent,
    context: RustPublishOutboxContext = {}
): Promise<SignedNostrEvent> {
    const signedEvent = toSignedNostrEvent(event);
    const now = Date.now();
    const requestTimestamp = context.requestTimestamp ?? now;
    const record: PublishOutboxRecord = {
        schemaVersion: PUBLISH_OUTBOX_RECORD_SCHEMA_VERSION,
        status: "accepted",
        acceptedAt: now,
        request: {
            requestId: context.requestId ?? `ts-publish:${signedEvent.id}`,
            requestSequence: context.requestSequence ?? requestTimestamp,
            requestTimestamp,
            correlationId: context.correlationId ?? "typescript_signed_event",
            projectId: context.projectId ?? "typescript-runtime",
            agentPubkey: signedEvent.pubkey,
            conversationId: context.conversationId ?? signedEvent.id,
            ralNumber: context.ralNumber ?? 0,
            waitForRelayOk: context.waitForRelayOk ?? true,
            timeoutMs: context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        },
        event: signedEvent,
        attempts: [],
    };

    await persistPendingRecord(record);
    logger.info("[RustPublishOutbox] Enqueued signed event for Rust relay publish", {
        eventId: signedEvent.id,
        kind: signedEvent.kind,
        pubkey: signedEvent.pubkey.substring(0, 8),
        requestId: record.request.requestId,
    });

    return signedEvent;
}

function toSignedNostrEvent(event: NDKEvent): SignedNostrEvent {
    const raw = event.rawEvent() as Partial<SignedNostrEvent>;
    if (!raw.id || !raw.pubkey || raw.created_at === undefined || raw.kind === undefined || !raw.sig) {
        throw new Error("Cannot enqueue unsigned or incomplete Nostr event for Rust publish");
    }

    return {
        id: raw.id,
        pubkey: raw.pubkey,
        created_at: raw.created_at,
        kind: raw.kind,
        tags: raw.tags?.map((tag) => [...tag]) ?? [],
        content: raw.content ?? "",
        sig: raw.sig,
    };
}

async function persistPendingRecord(record: PublishOutboxRecord): Promise<void> {
    const daemonDir = config.getConfigPath("daemon");
    const pendingDir = path.join(daemonDir, "publish-outbox", "pending");
    const publishedDir = path.join(daemonDir, "publish-outbox", "published");
    const failedDir = path.join(daemonDir, "publish-outbox", "failed");
    const tmpDir = path.join(daemonDir, "publish-outbox", "tmp");
    const fileName = `${record.event.id}.json`;

    await fs.mkdir(pendingDir, { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });

    for (const existingPath of [
        path.join(pendingDir, fileName),
        path.join(publishedDir, fileName),
        path.join(failedDir, fileName),
    ]) {
        const existing = await readExistingRecord(existingPath);
        if (!existing) {
            continue;
        }
        if (JSON.stringify(existing.event) !== JSON.stringify(record.event)) {
            throw new Error(`Publish outbox event id conflict at ${existingPath}`);
        }
        return;
    }

    const targetPath = path.join(pendingDir, fileName);
    const tmpPath = path.join(tmpDir, `${record.event.id}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    try {
        await fs.link(tmpPath, targetPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
        }
    } finally {
        await fs.rm(tmpPath, { force: true });
    }
}

async function readExistingRecord(filePath: string): Promise<PublishOutboxRecord | null> {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8")) as PublishOutboxRecord;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
