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

    it("describes filesystem-derived diagnostic shapes", () => {
        const { empty, fixtureRecordsBeforeRetry } = publishOutboxFixture.diagnostics;

        expect(empty).toEqual({
            schemaVersion: 1,
            inspectedAt: 1710001000000,
            pendingCount: 0,
            publishedCount: 0,
            failedCount: 0,
            retryableFailedCount: 0,
            retryDueCount: 0,
            permanentFailedCount: 0,
            tmpFileCount: 0,
            oldestPending: null,
            nextRetryAt: null,
            latestFailure: null,
        });

        expect(fixtureRecordsBeforeRetry).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                inspectedAt: 1710001001200,
                pendingCount: 1,
                publishedCount: 1,
                failedCount: 1,
                retryableFailedCount: 1,
                retryDueCount: 0,
                permanentFailedCount: 0,
                tmpFileCount: 0,
                nextRetryAt: 1710001001300,
            })
        );
        expect(fixtureRecordsBeforeRetry.oldestPending).toEqual({
            eventId: "event-accepted-01",
            acceptedAt: 1710001000100,
            requestId: "publish-fixture-01",
            projectId: "project-alpha",
            conversationId: "conversation-alpha",
            agentPubkey: "a".repeat(64),
        });
        expect(fixtureRecordsBeforeRetry.latestFailure).toEqual({
            eventId: "event-failed-01",
            requestId: "publish-fixture-01",
            projectId: "project-alpha",
            conversationId: "conversation-alpha",
            agentPubkey: "a".repeat(64),
            attemptCount: 1,
            attemptedAt: 1710001000300,
            error: "relay publish failed",
            retryable: true,
            nextAttemptAt: 1710001001300,
        });
    });

    it("describes maintenance report output shapes", () => {
        const { dueRetryPublished } = publishOutboxFixture.maintenanceReports;
        const daemonDir = "/var/lib/tenex/daemon";

        expect(dueRetryPublished.diagnosticsBefore).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                inspectedAt: 1710001001200,
                pendingCount: 0,
                publishedCount: 0,
                failedCount: 1,
                retryDueCount: 1,
                nextRetryAt: 1710001001200,
            })
        );
        expect(dueRetryPublished.requeued).toEqual([
            {
                eventId: "event-failed-01",
                status: "accepted",
                sourcePath: path.join(daemonDir, "publish-outbox", "failed", "event-failed-01.json"),
                targetPath: path.join(daemonDir, "publish-outbox", "pending", "event-failed-01.json"),
            },
        ]);
        expect(dueRetryPublished.drained).toEqual([
            {
                eventId: "event-failed-01",
                status: "published",
                sourcePath: path.join(daemonDir, "publish-outbox", "pending", "event-failed-01.json"),
                targetPath: path.join(daemonDir, "publish-outbox", "published", "event-failed-01.json"),
            },
        ]);
        expect(dueRetryPublished.diagnosticsAfter).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                inspectedAt: 1710001001200,
                pendingCount: 0,
                publishedCount: 1,
                failedCount: 0,
                retryDueCount: 0,
                nextRetryAt: null,
                latestFailure: null,
            })
        );
    });
});
