import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { analysisQueryService, analysisTelemetryService } from "@/services/analysis";
import { config as configService } from "@/services/ConfigService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

function createReadonlyDb(dbPath: string): SqliteDatabase {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(dbPath, { readonly: true });
}

function buildUserMessage(text: string, id: string, eventId: string) {
    return {
        role: "user" as const,
        id,
        eventId,
        content: [{ type: "text" as const, text }],
    };
}

describe("Analysis telemetry services", () => {
    let testDir: string;
    let dbPath: string;
    let getAnalysisTelemetryConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(async () => {
        testDir = `/tmp/tenex-analysis-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        dbPath = `${testDir}/trace-analysis.db`;
        await mkdir(testDir, { recursive: true });
        analysisTelemetryService.resetForTests();
        analysisQueryService.close();
        getAnalysisTelemetryConfigSpy = spyOn(
            configService,
            "getAnalysisTelemetryConfig"
        ).mockReturnValue({
            enabled: true,
            dbPath,
            retentionDays: 14,
            largeMessageThresholdTokens: 50,
            storeMessagePreviews: true,
            maxPreviewChars: 64,
            storeFullMessageText: false,
        });
    });

    afterEach(async () => {
        getAnalysisTelemetryConfigSpy.mockRestore();
        analysisTelemetryService.resetForTests();
        analysisQueryService.close();
        await rm(testDir, { recursive: true, force: true });
    });

    test("persists request, context, carry, and rate-limit rows", async () => {
        const baseTime = Date.now();
        const baseContext = {
            projectId: "project-alpha",
            conversationId: "conversation-1",
            agentSlug: "executor",
            agentId: "agent-pubkey-1",
        };
        const largeMessage = buildUserMessage(`Large prompt ${"x".repeat(400)}`, "msg-1", "evt-1");

        const handle1 = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: baseTime + 1_000,
            provider: "anthropic",
            model: "claude-opus",
            messages: [largeMessage as never],
            requestSeed: {
                requestId: "request-1",
                telemetryMetadata: {
                    "analysis.request_id": "request-1",
                },
                contextMetrics: {
                    preContextEstimatedInputTokens: 120,
                    sentEstimatedInputTokens: 80,
                    estimatedInputTokensSaved: 40,
                },
            },
            baseContext,
        });

        expect(handle1?.requestId).toBe("request-1");

        analysisTelemetryService.recordContextManagementEvent(
            {
                type: "strategy-complete",
                strategyName: "scratchpad",
                outcome: "applied",
                reason: "forced-threshold",
                estimatedTokensBefore: 120,
                estimatedTokensAfter: 80,
                workingTokenBudget: 200,
                removedToolExchangesDelta: 1,
                removedToolExchangesTotal: 1,
                pinnedToolCallIdsDelta: 0,
                messageCountBefore: 4,
                messageCountAfter: 3,
                strategyPayload: {
                    kind: "scratchpad",
                    forcedToolChoice: true,
                    currentTokens: 120,
                },
            } as never,
            {
                requestId: "request-1",
                provider: "anthropic",
                model: "claude-opus",
                ...baseContext,
            }
        );

        await handle1?.reportSuccess({
            completedAt: baseTime + 1_500,
            finishReason: "stop",
            usage: {
                inputTokens: 100,
                outputTokens: 35,
                totalTokens: 135,
                inputTokenDetails: {
                    noCacheTokens: 10,
                    cacheReadTokens: 20,
                    cacheWriteTokens: 70,
                },
                outputTokenDetails: {
                    textTokens: 30,
                    reasoningTokens: 5,
                },
                costUsd: 1.25,
            },
        });

        const handle2 = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: baseTime + 2_000,
            provider: "anthropic",
            model: "claude-opus",
            messages: [largeMessage as never],
            requestSeed: {
                requestId: "request-2",
                telemetryMetadata: {
                    "analysis.request_id": "request-2",
                },
            },
            baseContext,
        });

        await handle2?.reportError({
            completedAt: baseTime + 2_100,
            error: new Error(
                "This request would exceed your account's rate limit. Please try again later."
            ),
        });

        const handle3 = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: baseTime + 3_000,
            provider: "openrouter",
            model: "gpt-4.1",
            messages: [buildUserMessage("ok", "msg-2", "evt-2") as never],
            requestSeed: {
                requestId: "request-3",
                telemetryMetadata: {
                    "analysis.request_id": "request-3",
                },
            },
            baseContext,
        });

        await handle3?.reportSuccess({
            completedAt: baseTime + 3_400,
            finishReason: "stop",
            usage: {
                inputTokens: 15,
                outputTokens: 5,
                totalTokens: 20,
            },
        });

        const db = createReadonlyDb(dbPath);

        const requestRows = db.prepare(`
            SELECT
                request_id,
                provider,
                status,
                rate_limit,
                input_cache_write_tokens,
                pre_context_estimated_input_tokens,
                estimated_input_tokens_saved
            FROM llm_requests
            ORDER BY started_at_ms
        `).all() as Array<Record<string, number | string | null>>;
        expect(requestRows).toHaveLength(3);
        expect(requestRows[0]).toMatchObject({
            request_id: "request-1",
            provider: "anthropic",
            status: "success",
            input_cache_write_tokens: 70,
            pre_context_estimated_input_tokens: 120,
            estimated_input_tokens_saved: 40,
        });
        expect(requestRows[1]).toMatchObject({
            request_id: "request-2",
            status: "error",
            rate_limit: 1,
        });

        const contextRows = db.prepare(`
            SELECT strategy_name, estimated_tokens_saved, forced_tool_choice
            FROM context_management_events
        `).all() as Array<Record<string, number | string | null>>;
        expect(contextRows).toEqual([
            {
                strategy_name: "scratchpad",
                estimated_tokens_saved: 40,
                forced_tool_choice: 1,
            },
        ]);

        const carryRows = db.prepare(`
            SELECT carry_request_count, dropped, is_open, agent_slug
            FROM message_carry_runs
        `).all() as Array<Record<string, number | string | null>>;
        expect(carryRows).toEqual([
            {
                carry_request_count: 2,
                dropped: 1,
                is_open: 0,
                agent_slug: "executor",
            },
        ]);

        const viewCount = db.prepare("SELECT COUNT(*) AS count FROM analysis_usage_rows").get() as {
            count: number;
        };
        expect(viewCount.count).toBe(3);

        db.close(false);
    });

    test("aggregates usage, savings, and rate limits over explicit windows", async () => {
        const baseTime = Date.now();
        const records = [
            {
                requestId: "req-a",
                provider: "anthropic",
                model: "claude-opus",
                projectId: "project-alpha",
                agentSlug: "executor",
                startedAt: baseTime + 1_000,
                usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
                saved: 40,
                strategy: "scratchpad",
            },
            {
                requestId: "req-b",
                provider: "openrouter",
                model: "gpt-4.1",
                projectId: "project-alpha",
                agentSlug: "executor",
                startedAt: baseTime + 2_000,
                usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
                saved: 10,
                strategy: "tool-result-decay",
            },
            {
                requestId: "req-c",
                provider: "anthropic",
                model: "claude-opus",
                projectId: "project-beta",
                agentSlug: "reviewer",
                startedAt: baseTime + 3_000,
                usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
                saved: 15,
                strategy: "scratchpad",
            },
        ] as const;

        for (const record of records) {
            const handle = analysisTelemetryService.openRequest({
                operationKind: "stream",
                startedAt: record.startedAt,
                provider: record.provider,
                model: record.model,
                messages: [buildUserMessage(`prompt-${record.requestId}`, record.requestId, record.requestId) as never],
                requestSeed: {
                    requestId: record.requestId,
                    telemetryMetadata: {
                        "analysis.request_id": record.requestId,
                    },
                    contextMetrics: {
                        preContextEstimatedInputTokens: record.usage.inputTokens + record.saved,
                        sentEstimatedInputTokens: record.usage.inputTokens,
                        estimatedInputTokensSaved: record.saved,
                    },
                },
                baseContext: {
                    projectId: record.projectId,
                    conversationId: `${record.projectId}-conversation`,
                    agentSlug: record.agentSlug,
                    agentId: `${record.agentSlug}-pubkey`,
                },
            });

            analysisTelemetryService.recordContextManagementEvent(
                {
                    type: "strategy-complete",
                    strategyName: record.strategy,
                    outcome: "applied",
                    reason: "test",
                    estimatedTokensBefore: record.usage.inputTokens + record.saved,
                    estimatedTokensAfter: record.usage.inputTokens,
                    workingTokenBudget: 200,
                    removedToolExchangesDelta: 0,
                    removedToolExchangesTotal: 0,
                    pinnedToolCallIdsDelta: 0,
                    messageCountBefore: 3,
                    messageCountAfter: 2,
                    strategyPayload: {
                        kind: "scratchpad",
                        forcedToolChoice: false,
                    },
                } as never,
                {
                    requestId: record.requestId,
                    projectId: record.projectId,
                    conversationId: `${record.projectId}-conversation`,
                    agentSlug: record.agentSlug,
                    agentId: `${record.agentSlug}-pubkey`,
                    provider: record.provider,
                    model: record.model,
                }
            );

            await handle?.reportSuccess({
                completedAt: record.startedAt + 500,
                finishReason: "stop",
                usage: record.usage,
            });
        }

        const rateLimited = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: baseTime + 4_000,
            provider: "anthropic",
            model: "claude-opus",
            messages: [buildUserMessage("rate-limited", "req-d", "evt-d") as never],
            requestSeed: {
                requestId: "req-d",
                telemetryMetadata: {
                    "analysis.request_id": "req-d",
                },
            },
            baseContext: {
                projectId: "project-alpha",
                conversationId: "project-alpha-conversation",
                agentSlug: "executor",
                agentId: "executor-pubkey",
            },
        });
        await rateLimited?.reportError({
            completedAt: baseTime + 4_100,
            error: new Error("This account is rate limited"),
        });

        const since = baseTime;
        const until = baseTime + 10_000;
        const usageByProvider = analysisQueryService.getUsageTotals({
            since,
            until,
            groupBy: ["provider"],
        });
        expect(usageByProvider).toEqual([
            expect.objectContaining({
                provider: "anthropic",
                requestCount: 3,
                inputTokens: 130,
                estimatedInputTokensSaved: 55,
            }),
            expect.objectContaining({
                provider: "openrouter",
                requestCount: 1,
                inputTokens: 60,
                estimatedInputTokensSaved: 10,
            }),
        ]);

        const usageByProjectAndAgent = analysisQueryService.getUsageTotals({
            since,
            until,
            groupBy: ["project", "agent"],
        });
        expect(usageByProjectAndAgent).toEqual([
            expect.objectContaining({
                projectId: "project-alpha",
                agentSlug: "executor",
                inputTokens: 160,
            }),
            expect.objectContaining({
                projectId: "project-beta",
                agentSlug: "reviewer",
                inputTokens: 30,
            }),
        ]);

        const contextSavings = analysisQueryService.getContextSavingsTotals({
            since,
            until,
            groupBy: ["strategy", "provider"],
        });
        expect(contextSavings).toEqual([
            expect.objectContaining({
                strategyName: "scratchpad",
                provider: "anthropic",
                estimatedInputTokensSaved: 55,
            }),
            expect.objectContaining({
                strategyName: "tool-result-decay",
                provider: "openrouter",
                estimatedInputTokensSaved: 10,
            }),
        ]);

        const rateLimitCounts = analysisQueryService.getRateLimitCounts({
            since,
            until,
            groupBy: ["provider"],
        });
        expect(rateLimitCounts).toEqual([
            expect.objectContaining({
                provider: "anthropic",
                rateLimitCount: 1,
            }),
        ]);

        const rateLimitEvents = analysisQueryService.listRateLimitEvents({
            since,
            until,
        });
        expect(rateLimitEvents).toEqual([
            expect.objectContaining({
                request_id: "req-d",
                provider: "anthropic",
                errorMessage: "This account is rate limited",
            }),
        ]);
    });
});
