import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import telegramOutboxFixture from "@/test-utils/fixtures/daemon/telegram-outbox.compat.json";

describe("TelegramOutbox compatibility fixture", () => {
    it("exposes the canonical Rust transport outbox paths", () => {
        const daemonDir = "/var/lib/tenex/daemon";

        expect(telegramOutboxFixture.daemonDirName).toBe("daemon");
        expect(telegramOutboxFixture.writer).toBe("rust-daemon");
        expect(Object.keys(telegramOutboxFixture.relativePaths).sort()).toEqual([
            "delivered",
            "failed",
            "outbox",
            "pending",
            "tmp",
        ]);
        expect(Object.keys(telegramOutboxFixture.recordFileNames).sort()).toEqual([
            "delivered",
            "failed",
            "pending",
        ]);

        expect(path.join(daemonDir, telegramOutboxFixture.relativePaths.outbox)).toBe(
            path.join(daemonDir, "transport-outbox", "telegram")
        );
        expect(path.join(daemonDir, telegramOutboxFixture.relativePaths.pending)).toBe(
            path.join(daemonDir, "transport-outbox", "telegram", "pending")
        );
        expect(path.join(daemonDir, telegramOutboxFixture.relativePaths.delivered)).toBe(
            path.join(daemonDir, "transport-outbox", "telegram", "delivered")
        );
        expect(path.join(daemonDir, telegramOutboxFixture.relativePaths.failed)).toBe(
            path.join(daemonDir, "transport-outbox", "telegram", "failed")
        );
        expect(path.join(daemonDir, telegramOutboxFixture.relativePaths.tmp)).toBe(
            path.join(daemonDir, "transport-outbox", "telegram", "tmp")
        );
        expect(telegramOutboxFixture.recordFileNames.pending).toBe("<record-id>.json");
    });

    it("pins the record id derivation rule", () => {
        expect(telegramOutboxFixture.recordIdDerivation).toContain("sha256");
        expect(telegramOutboxFixture.recordIdDerivation).toContain("nostrEventId");
        expect(telegramOutboxFixture.recordIdDerivation).toContain("chatId");
        expect(telegramOutboxFixture.recordIdDerivation).toContain("replyToTelegramMessageId");
    });

    it("describes pending, delivered, and failed record shapes across payload variants", () => {
        const { pendingHtml, pendingPlain, pendingAskError, pendingVoice, delivered, failedRetryable, failedPermanent } =
            telegramOutboxFixture.records;

        for (const record of [
            pendingHtml,
            pendingPlain,
            pendingAskError,
            pendingVoice,
            delivered,
            failedRetryable,
            failedPermanent,
        ]) {
            expect(record).toHaveProperty("schemaVersion", 1);
            expect(record).toHaveProperty("writer", "rust-daemon");
            expect(record).toHaveProperty("writerVersion");
            expect(record).toHaveProperty("recordId");
            expect(record).toHaveProperty("createdAt");
            expect(record).toHaveProperty("updatedAt");
            expect(record).toHaveProperty("nostrEventId");
            expect(record).toHaveProperty("correlationId");
            expect(record.projectBinding).toHaveProperty("projectDTag");
            expect(record.projectBinding).toHaveProperty("backendPubkey");
            expect(record.channelBinding).toHaveProperty("chatId");
            expect(record.senderIdentity).toHaveProperty("agentPubkey");
            expect(record).toHaveProperty("deliveryReason");
            expect(record.payload).toHaveProperty("kind");
            expect(record).toHaveProperty("attempts");
        }

        expect(pendingHtml.payload.kind).toBe("html_text");
        expect(pendingPlain.payload.kind).toBe("plain_text");
        expect(pendingAskError.payload.kind).toBe("ask_error");
        expect(pendingVoice.payload.kind).toBe("reserved_voice");

        expect(pendingHtml.status).toBe("pending");
        expect(pendingHtml.attempts).toEqual([]);

        expect(delivered.status).toBe("delivered");
        expect(delivered.attempts).toHaveLength(1);
        expect(delivered.attempts[0]).toEqual(
            expect.objectContaining({
                attemptedAt: 1710001000200,
                status: "delivered",
                telegramMessageId: 5001,
                retryable: false,
            })
        );

        expect(failedRetryable.status).toBe("failed");
        expect(failedRetryable.attempts).toHaveLength(1);
        expect(failedRetryable.attempts[0]).toEqual(
            expect.objectContaining({
                attemptedAt: 1710001000300,
                status: "failed",
                errorClass: "rate_limited",
                errorDetail: "429 Too Many Requests",
                retryAfter: 1000,
                retryable: true,
                nextAttemptAt: 1710001001300,
            })
        );

        expect(failedPermanent.attempts[0]).toEqual(
            expect.objectContaining({
                status: "failed",
                errorClass: "bot_blocked",
                retryable: false,
            })
        );
        expect(failedPermanent.attempts[0]).not.toHaveProperty("nextAttemptAt");
    });

    it("describes diagnostic report output shapes", () => {
        const { empty, fixtureRecordsBeforeRetry } = telegramOutboxFixture.diagnostics;

        expect(empty).toEqual({
            schemaVersion: 1,
            inspectedAt: 1710001000000,
            pendingCount: 0,
            deliveredCount: 0,
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
                deliveredCount: 1,
                failedCount: 1,
                retryableFailedCount: 1,
                retryDueCount: 0,
                permanentFailedCount: 0,
                tmpFileCount: 0,
                nextRetryAt: 1710001001300,
            })
        );
        expect(fixtureRecordsBeforeRetry.oldestPending).toEqual({
            recordId: "3ace5a343cec2c986b729fa7cfd435ddc38741358f6432ee570873c12cb58b71",
            nostrEventId: "event-pending-html-01",
            createdAt: 1710001000100,
            correlationId: "telegram-fixture-01",
            projectDTag: "project-alpha",
            chatId: 12345,
            deliveryReason: "final_reply",
        });
        expect(fixtureRecordsBeforeRetry.latestFailure).toEqual(
            expect.objectContaining({
                recordId: "88871bf98105f2b10bfff1d4f5c135213c49b072b7f2795863170ba4e68e2952",
                nostrEventId: "event-failed-retryable-01",
                attemptCount: 1,
                errorClass: "rate_limited",
                retryable: true,
                nextAttemptAt: 1710001001300,
            })
        );
    });

    it("describes maintenance report output shapes", () => {
        const { dueRetryDelivered } = telegramOutboxFixture.maintenanceReports;
        const daemonDir = "/var/lib/tenex/daemon";
        const recordId = "31227c95e5adcbb49e7326a8d3f2393ba11222550249703cd0663303b642af67";

        expect(dueRetryDelivered.diagnosticsBefore).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                inspectedAt: 1710001001200,
                pendingCount: 0,
                deliveredCount: 0,
                failedCount: 1,
                retryDueCount: 1,
                nextRetryAt: 1710001001200,
            })
        );
        expect(dueRetryDelivered.requeued).toEqual([
            {
                recordId,
                nostrEventId: "event-failed-fixture-01",
                status: "pending",
                sourcePath: path.join(
                    daemonDir,
                    "transport-outbox",
                    "telegram",
                    "failed",
                    `${recordId}.json`
                ),
                targetPath: path.join(
                    daemonDir,
                    "transport-outbox",
                    "telegram",
                    "pending",
                    `${recordId}.json`
                ),
            },
        ]);
        expect(dueRetryDelivered.drained).toEqual([
            {
                recordId,
                nostrEventId: "event-failed-fixture-01",
                status: "delivered",
                sourcePath: path.join(
                    daemonDir,
                    "transport-outbox",
                    "telegram",
                    "pending",
                    `${recordId}.json`
                ),
                targetPath: path.join(
                    daemonDir,
                    "transport-outbox",
                    "telegram",
                    "delivered",
                    `${recordId}.json`
                ),
                telegramMessageId: 5001,
            },
        ]);
        expect(dueRetryDelivered.diagnosticsAfter).toEqual(
            expect.objectContaining({
                schemaVersion: 1,
                inspectedAt: 1710001001200,
                pendingCount: 0,
                deliveredCount: 1,
                failedCount: 0,
                retryDueCount: 0,
                nextRetryAt: null,
                latestFailure: null,
            })
        );
    });
});
