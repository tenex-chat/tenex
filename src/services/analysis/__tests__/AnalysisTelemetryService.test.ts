import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { analysisQueryService, analysisTelemetryService } from "@/services/analysis";
import { config as configService } from "@/services/ConfigService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

function createDb(dbPath: string, readonly = false): SqliteDatabase {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(dbPath, readonly ? { readonly: true } : undefined);
}

function buildUserMessage(text: string, id: string, eventId: string) {
    return {
        role: "user" as const,
        id,
        eventId,
        content: [{ type: "text" as const, text }],
    };
}

function buildSystemMessage(text: string, id: string, eventId: string) {
    return {
        role: "system" as const,
        id,
        eventId,
        content: text,
    };
}

function recordRuntimeComplete(params: {
    requestId: string;
    projectId: string;
    conversationId: string;
    agentSlug: string;
    agentId: string;
    provider: string;
    model: string;
    before: number;
    after: number;
}): void {
    analysisTelemetryService.recordContextManagementEvent(
        {
            type: "runtime-complete",
            estimatedTokensBefore: params.before,
            estimatedTokensAfter: params.after,
            removedToolExchangesTotal: 0,
            pinnedToolCallIdsTotal: 0,
            messageCountBefore: 4,
            messageCountAfter: 3,
            payloads: [],
        } as never,
        {
            requestId: params.requestId,
            projectId: params.projectId,
            conversationId: params.conversationId,
            agentSlug: params.agentSlug,
            agentId: params.agentId,
            provider: params.provider,
            model: params.model,
        }
    );
}

function recordStrategyComplete(params: {
    requestId: string;
    projectId: string;
    conversationId: string;
    agentSlug: string;
    agentId: string;
    provider: string;
    model: string;
    strategyName: string;
    before: number;
    after: number;
}): void {
    const strategyPayload =
        params.strategyName === "tool-result-decay"
            ? {
                kind: "tool-result-decay" as const,
                totalToolExchanges: 0,
                placeholderCount: 0,
                inputPlaceholderCount: 0,
            }
            : {
                kind: "compaction-tool" as const,
                mode: "stored" as const,
                editCount: 0,
                compactedMessageCount: 0,
                fromIndex: 0,
                toIndex: 0,
                summaryCharCount: 0,
            };

    analysisTelemetryService.recordContextManagementEvent(
        {
            type: "strategy-complete",
            strategyName: params.strategyName,
            outcome: "applied",
            reason: "test",
            estimatedTokensBefore: params.before,
            estimatedTokensAfter: params.after,
            workingTokenBudget: 200_000,
            removedToolExchangesDelta: 0,
            removedToolExchangesTotal: 0,
            pinnedToolCallIdsDelta: 0,
            messageCountBefore: 4,
            messageCountAfter: 3,
            strategyPayload,
        } as never,
        {
            requestId: params.requestId,
            projectId: params.projectId,
            conversationId: params.conversationId,
            agentSlug: params.agentSlug,
            agentId: params.agentId,
            provider: params.provider,
            model: params.model,
        }
    );
}

function createLegacyV1Database(dbPath: string, startedAt: number): void {
    const db = createDb(dbPath);

    db.exec(`
        CREATE TABLE analysis_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE llm_requests (
            request_id TEXT PRIMARY KEY,
            project_id TEXT,
            conversation_id TEXT,
            agent_slug TEXT,
            agent_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            operation_kind TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            completed_at_ms INTEGER,
            status TEXT NOT NULL,
            finish_reason TEXT,
            error_message TEXT,
            rate_limit INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER,
            output_tokens INTEGER,
            total_tokens INTEGER,
            input_no_cache_tokens INTEGER,
            input_cache_read_tokens INTEGER,
            input_cache_write_tokens INTEGER,
            output_text_tokens INTEGER,
            output_reasoning_tokens INTEGER,
            cached_input_tokens INTEGER,
            reasoning_tokens INTEGER,
            cost_usd REAL,
            pre_context_estimated_input_tokens INTEGER,
            sent_estimated_input_tokens INTEGER,
            estimated_input_tokens_saved INTEGER
        );

        CREATE TABLE context_management_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT,
            project_id TEXT,
            conversation_id TEXT,
            agent_slug TEXT,
            agent_id TEXT,
            provider TEXT,
            model TEXT,
            event_type TEXT NOT NULL,
            strategy_name TEXT,
            tool_name TEXT,
            tool_call_id TEXT,
            outcome TEXT,
            reason TEXT,
            estimated_tokens_before INTEGER,
            estimated_tokens_after INTEGER,
            estimated_tokens_saved INTEGER,
            working_token_budget INTEGER,
            removed_tool_exchanges_delta INTEGER,
            removed_tool_exchanges_total INTEGER,
            pinned_tool_call_ids_delta INTEGER,
            pinned_tool_call_ids_total INTEGER,
            message_count_before INTEGER,
            message_count_after INTEGER,
            placeholder_tool_result_count INTEGER,
            placeholder_tool_input_count INTEGER,
            messages_summarized_count INTEGER,
            summary_char_count INTEGER,
            entry_count INTEGER,
            entry_char_count INTEGER,
            forced_tool_choice INTEGER,
            current_prompt_tokens INTEGER,
            warning_threshold_tokens INTEGER,
            utilization_percent REAL,
            raw_estimate INTEGER,
            actual_tokens INTEGER,
            previous_factor REAL,
            new_factor REAL,
            sample_count INTEGER,
            payload_json TEXT,
            created_at_ms INTEGER NOT NULL
        );
    `);

    db.prepare("INSERT INTO analysis_meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        "1"
    );

    db.prepare(`
        INSERT INTO llm_requests (
            request_id,
            project_id,
            conversation_id,
            agent_slug,
            agent_id,
            provider,
            model,
            operation_kind,
            started_at_ms,
            completed_at_ms,
            status,
            pre_context_estimated_input_tokens,
            sent_estimated_input_tokens,
            estimated_input_tokens_saved
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "legacy-request-1",
        "project-legacy",
        "conversation-legacy",
        "executor",
        "agent-legacy",
        "anthropic",
        "claude-opus",
        "stream",
        startedAt,
        startedAt + 200,
        "success",
        120,
        110,
        10
    );

    db.prepare(`
        INSERT INTO context_management_events (
            request_id,
            project_id,
            conversation_id,
            agent_slug,
            agent_id,
            provider,
            model,
            event_type,
            estimated_tokens_before,
            estimated_tokens_after,
            estimated_tokens_saved,
            created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "legacy-request-1",
        "project-legacy",
        "conversation-legacy",
        "executor",
        "agent-legacy",
        "anthropic",
        "claude-opus",
        "runtime-complete",
        300,
        180,
        120,
        startedAt + 10
    );

    db.close(false);
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

    test("persists canonical runtime metrics separately from prepared prompt metrics", async () => {
        const baseTime = Date.now();
        const baseContext = {
            projectId: "project-alpha",
            conversationId: "conversation-1",
            agentSlug: "executor",
            agentId: "agent-pubkey-1",
        };
        const largeMessage = buildUserMessage(`Large prompt ${"x".repeat(400)}`, "msg-1", "evt-1");

        recordRuntimeComplete({
            requestId: "request-1",
            provider: "anthropic",
            model: "claude-opus",
            before: 140,
            after: 100,
            ...baseContext,
        });

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
                preparedPromptMetrics: {
                    preContextEstimatedInputTokens: 120,
                    sentEstimatedInputTokens: 90,
                    estimatedInputTokensSaved: 30,
                },
            },
            baseContext,
        });

        recordStrategyComplete({
            requestId: "request-1",
            provider: "anthropic",
            model: "claude-opus",
            strategyName: "compaction-tool",
            before: 140,
            after: 100,
            ...baseContext,
        });

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
                preparedPromptMetrics: {
                    preContextEstimatedInputTokens: 200,
                    sentEstimatedInputTokens: 170,
                    estimatedInputTokensSaved: 30,
                },
            },
            baseContext,
        });

        recordRuntimeComplete({
            requestId: "request-2",
            provider: "anthropic",
            model: "claude-opus",
            before: 220,
            after: 150,
            ...baseContext,
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

        const db = createDb(dbPath, true);

        const requestRows = db.prepare(`
            SELECT
                request_id,
                provider,
                status,
                rate_limit,
                pre_context_estimated_input_tokens,
                sent_estimated_input_tokens,
                estimated_input_tokens_saved,
                context_runtime_estimated_input_tokens_before,
                context_runtime_estimated_input_tokens_after,
                context_runtime_estimated_input_tokens_saved,
                shared_prefix_breakpoint_applied,
                shared_prefix_message_count,
                shared_prefix_last_message_index,
                input_cache_write_tokens
            FROM llm_requests
            ORDER BY started_at_ms
        `).all() as Array<Record<string, number | string | null>>;
        expect(requestRows).toEqual([
            {
                request_id: "request-1",
                provider: "anthropic",
                status: "success",
                rate_limit: 0,
                pre_context_estimated_input_tokens: 120,
                sent_estimated_input_tokens: 90,
                estimated_input_tokens_saved: 30,
                context_runtime_estimated_input_tokens_before: 140,
                context_runtime_estimated_input_tokens_after: 100,
                context_runtime_estimated_input_tokens_saved: 40,
                shared_prefix_breakpoint_applied: null,
                shared_prefix_message_count: null,
                shared_prefix_last_message_index: null,
                input_cache_write_tokens: 70,
            },
            {
                request_id: "request-2",
                provider: "anthropic",
                status: "error",
                rate_limit: 1,
                pre_context_estimated_input_tokens: 200,
                sent_estimated_input_tokens: 170,
                estimated_input_tokens_saved: 30,
                context_runtime_estimated_input_tokens_before: 220,
                context_runtime_estimated_input_tokens_after: 150,
                context_runtime_estimated_input_tokens_saved: 70,
                shared_prefix_breakpoint_applied: null,
                shared_prefix_message_count: null,
                shared_prefix_last_message_index: null,
                input_cache_write_tokens: null,
            },
            {
                request_id: "request-3",
                provider: "openrouter",
                status: "success",
                rate_limit: 0,
                pre_context_estimated_input_tokens: null,
                sent_estimated_input_tokens: null,
                estimated_input_tokens_saved: null,
                context_runtime_estimated_input_tokens_before: null,
                context_runtime_estimated_input_tokens_after: null,
                context_runtime_estimated_input_tokens_saved: null,
                shared_prefix_breakpoint_applied: null,
                shared_prefix_message_count: null,
                shared_prefix_last_message_index: null,
                input_cache_write_tokens: null,
            },
        ]);

        const messageRows = db.prepare(`
            SELECT request_id, classification, source_event_id, preview, full_text
            FROM llm_request_messages
            ORDER BY request_id, message_index
        `).all() as Array<Record<string, number | string | null>>;
        expect(messageRows[0]).toMatchObject({
            request_id: "request-1",
            classification: "user",
            source_event_id: "evt-1",
            full_text: null,
        });
        expect(String(messageRows[0]?.preview)).toContain("Large prompt");

        const contextRows = db.prepare(`
            SELECT request_id, event_type, strategy_name, estimated_tokens_saved
            FROM context_management_events
            ORDER BY id
        `).all() as Array<Record<string, number | string | null>>;
        expect(contextRows).toEqual([
            {
                request_id: "request-1",
                event_type: "runtime-complete",
                strategy_name: null,
                estimated_tokens_saved: 40,
            },
            {
                request_id: "request-1",
                event_type: "strategy-complete",
                strategy_name: "compaction-tool",
                estimated_tokens_saved: 40,
            },
            {
                request_id: "request-2",
                event_type: "runtime-complete",
                strategy_name: null,
                estimated_tokens_saved: 70,
            },
        ]);

        const carryRows = db.prepare(`
            SELECT carry_request_count, dropped, is_open, classification, agent_slug
            FROM message_carry_runs
        `).all() as Array<Record<string, number | string | null>>;
        expect(carryRows).toEqual([
            {
                carry_request_count: 2,
                dropped: 1,
                is_open: 0,
                classification: "user",
                agent_slug: "executor",
            },
        ]);

        db.close(false);
    });

    test("persists compaction analytics fields without provider-side context edit metadata", async () => {
        const startedAt = Date.now();
        const baseContext = {
            projectId: "project-compaction",
            conversationId: "conversation-compaction",
            agentSlug: "executor",
            agentId: "agent-compaction",
        };

        const handle = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt,
            provider: "anthropic",
            model: "claude-sonnet",
            messages: [buildUserMessage("Continue the parser fix", "msg-compaction", "evt-compaction") as never],
            requestSeed: {
                requestId: "request-compaction",
                telemetryMetadata: {
                    "analysis.request_id": "request-compaction",
                },
            },
            baseContext,
        });

        analysisTelemetryService.recordContextManagementEvent(
            {
                type: "strategy-complete",
                strategyName: "compaction-tool",
                outcome: "applied",
                reason: "manual-compaction-applied",
                estimatedTokensBefore: 180,
                estimatedTokensAfter: 120,
                workingTokenBudget: 40_000,
                removedToolExchangesDelta: 0,
                removedToolExchangesTotal: 0,
                pinnedToolCallIdsDelta: 0,
                messageCountBefore: 7,
                messageCountAfter: 4,
                strategyPayload: {
                    kind: "compaction-tool",
                    mode: "manual",
                    editCount: 1,
                    compactedMessageCount: 4,
                    fromIndex: 1,
                    toIndex: 4,
                    summaryCharCount: 128,
                },
            } as never,
            {
                requestId: "request-compaction",
                ...baseContext,
                provider: "anthropic",
                model: "claude-sonnet",
            }
        );

        await handle?.reportSuccess({
            completedAt: startedAt + 500,
            finishReason: "stop",
            usage: {
                inputTokens: 80,
                outputTokens: 20,
                totalTokens: 100,
            },
        });

        const db = createDb(dbPath, true);

        const contextRow = db.prepare(`
            SELECT
                strategy_name,
                compaction_mode,
                compaction_edit_count,
                compaction_message_count,
                compaction_from_index,
                compaction_to_index,
                summary_char_count
            FROM context_management_events
            WHERE request_id = ?
        `).get("request-compaction") as Record<string, number | string | null>;
        expect(contextRow).toEqual({
            strategy_name: "compaction-tool",
            compaction_mode: "manual",
            compaction_edit_count: 1,
            compaction_message_count: 4,
            compaction_from_index: 1,
            compaction_to_index: 4,
            summary_char_count: 128,
        });

        db.close(false);
    });

    test("aggregates canonical runtime savings separately from prepared prompt savings", async () => {
        const baseTime = Date.now();
        const records: Array<{
            requestId: string;
            provider: string;
            model: string;
            projectId: string;
            agentSlug: string;
            agentId: string;
            startedAt: number;
            usage: {
                inputTokens: number;
                outputTokens: number;
                totalTokens: number;
            };
            runtimeBefore: number;
            runtimeAfter: number;
            preparedBefore: number;
            preparedAfter: number;
            strategy: string;
        }> = [
            {
                requestId: "req-a",
                provider: "anthropic",
                model: "claude-opus",
                projectId: "project-alpha",
                agentSlug: "executor",
                agentId: "executor-pubkey",
                startedAt: baseTime + 1_000,
                usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
                runtimeBefore: 150,
                runtimeAfter: 100,
                preparedBefore: 135,
                preparedAfter: 100,
                strategy: "compaction-tool",
            },
            {
                requestId: "req-b",
                provider: "openrouter",
                model: "gpt-4.1",
                projectId: "project-alpha",
                agentSlug: "executor",
                agentId: "executor-pubkey",
                startedAt: baseTime + 2_000,
                usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
                runtimeBefore: 70,
                runtimeAfter: 60,
                preparedBefore: 67,
                preparedAfter: 60,
                strategy: "tool-result-decay",
            },
            {
                requestId: "req-c",
                provider: "anthropic",
                model: "claude-opus",
                projectId: "project-beta",
                agentSlug: "reviewer",
                agentId: "reviewer-pubkey",
                startedAt: baseTime + 3_000,
                usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
                runtimeBefore: 45,
                runtimeAfter: 30,
                preparedBefore: 39,
                preparedAfter: 30,
                strategy: "compaction-tool",
            },
        ];

        for (const record of records) {
            recordRuntimeComplete({
                requestId: record.requestId,
                projectId: record.projectId,
                conversationId: `${record.projectId}-conversation`,
                agentSlug: record.agentSlug,
                agentId: record.agentId,
                provider: record.provider,
                model: record.model,
                before: record.runtimeBefore,
                after: record.runtimeAfter,
            });

            const handle = analysisTelemetryService.openRequest({
                operationKind: "stream",
                startedAt: record.startedAt,
                provider: record.provider,
                model: record.model,
                messages: [
                    buildUserMessage(
                        `prompt-${record.requestId}`,
                        record.requestId,
                        `${record.requestId}-event`
                    ) as never,
                ],
                requestSeed: {
                    requestId: record.requestId,
                    telemetryMetadata: {
                        "analysis.request_id": record.requestId,
                    },
                    preparedPromptMetrics: {
                        preContextEstimatedInputTokens: record.preparedBefore,
                        sentEstimatedInputTokens: record.preparedAfter,
                        estimatedInputTokensSaved: record.preparedBefore - record.preparedAfter,
                    },
                },
                baseContext: {
                    projectId: record.projectId,
                    conversationId: `${record.projectId}-conversation`,
                    agentSlug: record.agentSlug,
                    agentId: record.agentId,
                },
            });

            recordStrategyComplete({
                requestId: record.requestId,
                projectId: record.projectId,
                conversationId: `${record.projectId}-conversation`,
                agentSlug: record.agentSlug,
                agentId: record.agentId,
                provider: record.provider,
                model: record.model,
                strategyName: record.strategy,
                before: record.runtimeBefore,
                after: record.runtimeAfter,
            });

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
                contextRuntimeEstimatedInputTokensSaved: 65,
                preparedPromptEstimatedInputTokensSaved: 44,
                estimatedInputTokensSaved: 65,
            }),
            expect.objectContaining({
                provider: "openrouter",
                requestCount: 1,
                inputTokens: 60,
                contextRuntimeEstimatedInputTokensSaved: 10,
                preparedPromptEstimatedInputTokensSaved: 7,
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
                estimatedInputTokensSaved: 60,
            }),
            expect.objectContaining({
                projectId: "project-beta",
                agentSlug: "reviewer",
                inputTokens: 30,
                estimatedInputTokensSaved: 15,
            }),
        ]);

        const contextSavings = analysisQueryService.getContextSavingsTotals({
            since,
            until,
            groupBy: ["strategy", "provider"],
        });
        expect(contextSavings).toEqual([
            expect.objectContaining({
                strategyName: "compaction-tool",
                provider: "anthropic",
                estimatedInputTokensSaved: 65,
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
                requestId: "req-d",
                provider: "anthropic",
                errorMessage: "This account is rate limited",
            }),
        ]);
    });

    test("persists invalid tool calls and exposes grouped analytics", async () => {
        const baseTime = Date.now();
        const firstHandle = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: baseTime + 1_000,
            provider: "openrouter",
            model: "gpt-4.1",
            messages: [buildUserMessage("Use fs_read", "msg-invalid-1", "evt-invalid-1") as never],
            requestSeed: {
                requestId: "invalid-request-1",
                telemetryMetadata: {
                    "analysis.request_id": "invalid-request-1",
                },
            },
            baseContext: {
                projectId: "project-alpha",
                conversationId: "conversation-invalid-1",
                agentSlug: "executor",
                agentId: "agent-invalid-1",
            },
        });
        await firstHandle?.reportInvalidToolCalls({
            recordedAt: baseTime + 1_100,
            invalidToolCalls: [
                {
                    stepNumber: 0,
                    toolCallIndex: 0,
                    toolName: "fs_read",
                    toolCallId: "bad-tool-1",
                    errorType: "ValidationError",
                    errorMessage: "path is required",
                    input: { path: 42 },
                },
                {
                    stepNumber: 1,
                    toolCallIndex: 0,
                    toolName: "fs_read",
                    toolCallId: "bad-tool-2",
                    errorType: "ValidationError",
                    errorMessage: "path must be absolute",
                    input: { path: "relative.txt" },
                },
            ],
        });
        await firstHandle?.reportSuccess({
            completedAt: baseTime + 1_500,
            finishReason: "stop",
            usage: {
                inputTokens: 40,
                outputTokens: 10,
                totalTokens: 50,
            },
        });

        const secondHandle = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: baseTime + 2_000,
            provider: "anthropic",
            model: "claude-sonnet",
            messages: [buildUserMessage("Delegate this", "msg-invalid-2", "evt-invalid-2") as never],
            requestSeed: {
                requestId: "invalid-request-2",
                telemetryMetadata: {
                    "analysis.request_id": "invalid-request-2",
                },
            },
            baseContext: {
                projectId: "project-beta",
                conversationId: "conversation-invalid-2",
                agentSlug: "reviewer",
                agentId: "agent-invalid-2",
            },
        });
        await secondHandle?.reportInvalidToolCalls({
            recordedAt: baseTime + 2_050,
            invalidToolCalls: [
                {
                    stepNumber: 0,
                    toolCallIndex: 0,
                    toolName: "delegate",
                    toolCallId: "bad-tool-3",
                    errorType: "ZodError",
                    errorMessage: "targetAgent is required",
                    input: {},
                },
            ],
        });
        await secondHandle?.reportSuccess({
            completedAt: baseTime + 2_300,
            finishReason: "stop",
            usage: {
                inputTokens: 20,
                outputTokens: 8,
                totalTokens: 28,
            },
        });

        const db = createDb(dbPath, true);
        const invalidRows = db.prepare(`
            SELECT
                request_id,
                step_number,
                tool_call_index,
                tool_name,
                tool_call_id,
                error_type,
                error_message,
                input_json
            FROM invalid_tool_calls
            ORDER BY request_id, step_number
        `).all() as Array<Record<string, number | string | null>>;
        expect(invalidRows).toEqual([
            {
                request_id: "invalid-request-1",
                step_number: 0,
                tool_call_index: 0,
                tool_name: "fs_read",
                tool_call_id: "bad-tool-1",
                error_type: "ValidationError",
                error_message: "path is required",
                input_json: JSON.stringify({ path: 42 }),
            },
            {
                request_id: "invalid-request-1",
                step_number: 1,
                tool_call_index: 0,
                tool_name: "fs_read",
                tool_call_id: "bad-tool-2",
                error_type: "ValidationError",
                error_message: "path must be absolute",
                input_json: JSON.stringify({ path: "relative.txt" }),
            },
            {
                request_id: "invalid-request-2",
                step_number: 0,
                tool_call_index: 0,
                tool_name: "delegate",
                tool_call_id: "bad-tool-3",
                error_type: "ZodError",
                error_message: "targetAgent is required",
                input_json: JSON.stringify({}),
            },
        ]);
        db.close(false);

        const countsByTool = analysisQueryService.getInvalidToolCallCounts({
            since: baseTime,
            until: baseTime + 10_000,
            groupBy: ["tool", "model", "agent"],
        });
        expect(countsByTool).toEqual([
            expect.objectContaining({
                toolName: "fs_read",
                model: "gpt-4.1",
                agentSlug: "executor",
                invalidToolCallCount: 2,
            }),
            expect.objectContaining({
                toolName: "delegate",
                model: "claude-sonnet",
                agentSlug: "reviewer",
                invalidToolCallCount: 1,
            }),
        ]);

        const invalidEvents = analysisQueryService.listInvalidToolCalls({
            since: baseTime,
            until: baseTime + 10_000,
            toolNames: ["fs_read"],
        });
        expect(invalidEvents).toEqual([
            expect.objectContaining({
                requestId: "invalid-request-1",
                toolName: "fs_read",
                provider: "openrouter",
                model: "gpt-4.1",
                agentSlug: "executor",
                errorType: "ValidationError",
            }),
            expect.objectContaining({
                requestId: "invalid-request-1",
                toolName: "fs_read",
                provider: "openrouter",
                model: "gpt-4.1",
                agentSlug: "executor",
                errorType: "ValidationError",
            }),
        ]);
    });

    test("lists unfinalized requests and excludes system carry rows by default", async () => {
        const now = Date.now();
        const baseContext = {
            projectId: "project-alpha",
            conversationId: "conversation-carry",
            agentSlug: "executor",
            agentId: "executor-pubkey",
        };
        const largeSystemMessage = buildSystemMessage(
            `System prompt ${"s".repeat(400)}`,
            "sys-1",
            "sys-evt-1"
        );
        const largeUserMessage = buildUserMessage(
            `User prompt ${"u".repeat(400)}`,
            "usr-1",
            "usr-evt-1"
        );

        const firstHandle = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: now - 20_000,
            provider: "anthropic",
            model: "claude-opus",
            messages: [largeSystemMessage as never, largeUserMessage as never],
            requestSeed: {
                requestId: "carry-request-1",
                telemetryMetadata: {
                    "analysis.request_id": "carry-request-1",
                },
            },
            baseContext,
        });
        await firstHandle?.reportSuccess({
            completedAt: now - 19_500,
            finishReason: "stop",
            usage: {
                inputTokens: 90,
                outputTokens: 20,
                totalTokens: 110,
            },
        });

        analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: now - 10_000,
            provider: "anthropic",
            model: "claude-opus",
            messages: [largeSystemMessage as never, largeUserMessage as never],
            requestSeed: {
                requestId: "carry-request-2",
                telemetryMetadata: {
                    "analysis.request_id": "carry-request-2",
                },
            },
            baseContext,
        });

        const unfinalized = analysisQueryService.listUnfinalizedRequests({
            since: now - 60_000,
            olderThanMs: 1_000,
        });
        expect(unfinalized).toEqual([
            expect.objectContaining({
                requestId: "carry-request-2",
                projectId: "project-alpha",
                agentSlug: "executor",
                provider: "anthropic",
            }),
        ]);
        expect(Number(unfinalized[0]?.ageMs)).toBeGreaterThanOrEqual(9_000);

        const carryRowsDefault = analysisQueryService.listMessageCarryRuns({
            since: now - 60_000,
            openOnly: true,
        });
        expect(carryRowsDefault).toEqual([
            expect.objectContaining({
                conversationId: "conversation-carry",
                classification: "user",
                carryRequestCount: 2,
                isOpen: 1,
            }),
        ]);

        const carryRowsWithSystem = analysisQueryService.listMessageCarryRuns({
            since: now - 60_000,
            openOnly: true,
            includeSystem: true,
        });
        expect(carryRowsWithSystem).toHaveLength(2);
        expect(
            carryRowsWithSystem
                .map((row) => String(row.classification))
                .sort()
        ).toEqual(["system", "user"]);
    });

    test("migrates v1 databases and backfills canonical runtime metrics from runtime-complete rows", async () => {
        const startedAt = Date.now() - 5_000;
        createLegacyV1Database(dbPath, startedAt);

        const handle = analysisTelemetryService.openRequest({
            operationKind: "stream",
            startedAt: startedAt + 1_000,
            provider: "openrouter",
            model: "gpt-4.1",
            messages: [buildUserMessage("hello", "new-msg", "new-evt") as never],
            requestSeed: {
                requestId: "new-request",
                telemetryMetadata: {
                    "analysis.request_id": "new-request",
                },
            },
            baseContext: {
                projectId: "project-new",
                conversationId: "conversation-new",
                agentSlug: "executor",
                agentId: "agent-new",
            },
        });
        await handle?.reportSuccess({
            completedAt: startedAt + 1_200,
            finishReason: "stop",
            usage: {
                inputTokens: 12,
                outputTokens: 4,
                totalTokens: 16,
            },
        });

        const db = createDb(dbPath, true);

        const columns = db.prepare("PRAGMA table_info(llm_requests)").all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual(
            expect.arrayContaining([
                "context_runtime_estimated_input_tokens_before",
                "context_runtime_estimated_input_tokens_after",
                "context_runtime_estimated_input_tokens_saved",
                "shared_prefix_breakpoint_applied",
                "shared_prefix_message_count",
                "shared_prefix_last_message_index",
            ])
        );

        const contextColumns = db.prepare("PRAGMA table_info(context_management_events)").all() as Array<{ name: string }>;
        expect(contextColumns.map((column) => column.name)).toEqual(
            expect.arrayContaining([
                "compaction_mode",
                "compaction_edit_count",
                "compaction_message_count",
                "compaction_from_index",
                "compaction_to_index",
            ])
        );

        const legacyRow = db.prepare(`
            SELECT
                pre_context_estimated_input_tokens,
                sent_estimated_input_tokens,
                estimated_input_tokens_saved,
                context_runtime_estimated_input_tokens_before,
                context_runtime_estimated_input_tokens_after,
                context_runtime_estimated_input_tokens_saved
            FROM llm_requests
            WHERE request_id = ?
        `).get("legacy-request-1") as Record<string, number | null>;
        expect(legacyRow).toEqual({
            pre_context_estimated_input_tokens: 120,
            sent_estimated_input_tokens: 110,
            estimated_input_tokens_saved: 10,
            context_runtime_estimated_input_tokens_before: 300,
            context_runtime_estimated_input_tokens_after: 180,
            context_runtime_estimated_input_tokens_saved: 120,
        });

        const migratedViewRow = db.prepare(`
            SELECT
                estimated_input_tokens_saved,
                prepared_prompt_estimated_input_tokens_saved
            FROM analysis_usage_rows
            WHERE request_id = ?
        `).get("legacy-request-1") as Record<string, number | null>;
        expect(migratedViewRow).toEqual({
            estimated_input_tokens_saved: 120,
            prepared_prompt_estimated_input_tokens_saved: 10,
        });

        const schemaVersion = db.prepare(`
            SELECT value
            FROM analysis_meta
            WHERE key = ?
        `).get("schema_version") as { value: string };
        expect(schemaVersion.value).toBe("7");

        db.close(false);
    });
});
