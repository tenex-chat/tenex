import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import publishOutboxFixture from "@/test-utils/fixtures/daemon/publish-outbox.compat.json";

describe("PublishOutbox compatibility fixture", () => {
    it("exposes the canonical Rust outbox paths", () => {
        const daemonDir = "/var/lib/tenex/daemon";

        expect(publishOutboxFixture.daemonDirName).toBe("daemon");
        expect(Object.keys(publishOutboxFixture.relativePaths).sort()).toEqual([
            "failed",
            "outbox",
            "pending",
            "published",
            "tmp",
        ]);
        expect(Object.keys(publishOutboxFixture.recordFileNames).sort()).toEqual([
            "failed",
            "pending",
            "published",
        ]);

        expect(path.join(daemonDir, publishOutboxFixture.relativePaths.outbox)).toBe(
            path.join(daemonDir, "publish-outbox")
        );
        expect(path.join(daemonDir, publishOutboxFixture.relativePaths.pending)).toBe(
            path.join(daemonDir, "publish-outbox", "pending")
        );
        expect(path.join(daemonDir, publishOutboxFixture.relativePaths.published)).toBe(
            path.join(daemonDir, "publish-outbox", "published")
        );
        expect(path.join(daemonDir, publishOutboxFixture.relativePaths.failed)).toBe(
            path.join(daemonDir, "publish-outbox", "failed")
        );
        expect(path.join(daemonDir, publishOutboxFixture.relativePaths.tmp)).toBe(
            path.join(daemonDir, "publish-outbox", "tmp")
        );
        expect(
            path.join(
                daemonDir,
                publishOutboxFixture.relativePaths.pending,
                publishOutboxFixture.recordFileNames.pending
            )
        ).toBe(path.join(daemonDir, "publish-outbox", "pending", "<event-id>.json"));
        expect(
            path.join(
                daemonDir,
                publishOutboxFixture.relativePaths.published,
                publishOutboxFixture.recordFileNames.published
            )
        ).toBe(path.join(daemonDir, "publish-outbox", "published", "<event-id>.json"));
        expect(
            path.join(
                daemonDir,
                publishOutboxFixture.relativePaths.failed,
                publishOutboxFixture.recordFileNames.failed
            )
        ).toBe(path.join(daemonDir, "publish-outbox", "failed", "<event-id>.json"));
    });

    it("describes accepted, published, and failed outbox record shapes", () => {
        const { accepted, published, failed } = publishOutboxFixture.records;

        for (const record of [accepted, published, failed]) {
            expect(record).toHaveProperty("schemaVersion", 1);
            expect(record).toHaveProperty("acceptedAt");
            expect(record).toHaveProperty("request");
            expect(record).toHaveProperty("event");
            expect(record).toHaveProperty("attempts");
            expect(record.request).toHaveProperty("requestId");
            expect(record.request).toHaveProperty("requestSequence");
            expect(record.request).toHaveProperty("requestTimestamp");
            expect(record.request).toHaveProperty("correlationId");
            expect(record.request).toHaveProperty("projectId");
            expect(record.request).toHaveProperty("agentPubkey");
            expect(record.request).toHaveProperty("conversationId");
            expect(record.request).toHaveProperty("ralNumber");
            expect(record.request).toHaveProperty("requiresEventId");
            expect(record.request).toHaveProperty("timeoutMs");
            expect(record.event).toHaveProperty("id");
            expect(record.event).toHaveProperty("pubkey");
            expect(record.event).toHaveProperty("created_at");
            expect(record.event).toHaveProperty("kind");
            expect(record.event).toHaveProperty("tags");
            expect(record.event).toHaveProperty("content");
            expect(record.event).toHaveProperty("sig");
        }

        expect(accepted.status).toBe("accepted");
        expect(accepted.attempts).toEqual([]);

        expect(published.status).toBe("published");
        expect(published.attempts).toHaveLength(1);
        expect(published.attempts[0]).toEqual(
            expect.objectContaining({
                attemptedAt: 1710001000200,
                status: "published",
                error: null,
                retryable: false,
            })
        );
        expect(published.attempts[0].relayResults).toEqual([
            {
                relayUrl: "wss://relay.example.invalid",
                accepted: true,
                message: null,
            },
        ]);

        expect(failed.status).toBe("failed");
        expect(failed.attempts).toHaveLength(1);
        expect(failed.attempts[0]).toEqual(
            expect.objectContaining({
                attemptedAt: 1710001000300,
                status: "failed",
                error: "relay publish failed",
                retryable: true,
                nextAttemptAt: 1710001001300,
            })
        );
        expect(failed.attempts[0].relayResults).toEqual([]);
    });
});
