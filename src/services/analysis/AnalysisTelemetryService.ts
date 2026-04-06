import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { SharedV3ProviderOptions as ProviderOptions } from "@ai-sdk/provider";
import { createDefaultPromptTokenEstimator, type ContextManagementTelemetryEvent } from "ai-sdk-context-management";
import type { ModelMessage, Tool as CoreTool, ToolChoice } from "ai";
import type {
    InvalidToolCall,
    LLMAnalysisHooks,
    LLMAnalysisRequestHandle,
    LLMRequestAnalysisSeed,
    LanguageModelUsageWithCostUsd,
} from "@/llm/types";
import { resolvePath } from "@/lib/fs";
import { formatAnyError } from "@/lib/error-formatter";
import { AnalysisSchemaManager } from "@/services/analysis/AnalysisSchemaManager";
import { config as configService } from "@/services/ConfigService";
import { logger } from "@/utils/logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunDatabase = any;

function createBunDatabase(dbPath: string): BunDatabase {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(dbPath);
}

type Primitive = string | number | boolean | null;

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const PENDING_RUNTIME_METRICS_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_RUNTIME_METRICS = 2048;
const RATE_LIMIT_PATTERNS = [
    /\brate.?limit/i,
    /too many requests/i,
    /\b429\b/,
    /quota.?exhaust/i,
    /quota.?exceed/i,
] as const;
const STATUS_RATE_LIMIT_CODES = new Set([429]);
const promptEstimator = createDefaultPromptTokenEstimator();

interface AnalysisBaseContext {
    projectId?: string;
    conversationId?: string;
    agentSlug?: string;
    agentId?: string;
}

interface ContextManagementAnalysisScope extends AnalysisBaseContext {
    requestId: string;
    provider: string;
    model: string;
}

interface MessageSnapshot {
    messageHash: string;
    messageId?: string;
    sourceEventId?: string;
    role: string;
    classification: string;
    estimatedTokens: number;
    preview?: string;
    fullText?: string;
    toolCallId?: string;
}

interface OpenRequestParams {
    operationKind: "stream" | "generate-text" | "generate-object";
    startedAt: number;
    messages: ModelMessage[];
    providerOptions?: ProviderOptions;
    toolChoice?: ToolChoice<Record<string, CoreTool>>;
    requestSeed?: LLMRequestAnalysisSeed;
    provider: string;
    model: string;
    apiKeyIdentity?: string;
    baseContext: AnalysisBaseContext;
}

interface PendingRuntimeMetrics {
    estimatedInputTokensBefore: number;
    estimatedInputTokensAfter: number;
    estimatedInputTokensSaved: number;
    observedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asLooseRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toOptionalInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.round(value)
        : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeRole(role: unknown): string {
    return typeof role === "string" && role.length > 0 ? role : "unknown";
}

function stringifyJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function clipText(value: string, limit: number): string {
    return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function extractStructuredStatusCode(error: unknown): number | undefined {
    if (!isRecord(error)) {
        return undefined;
    }

    if (typeof error.status === "number") {
        return error.status;
    }
    if (typeof error.statusCode === "number") {
        return error.statusCode;
    }

    if (isRecord(error.response)) {
        if (typeof error.response.status === "number") {
            return error.response.status;
        }
        if (typeof error.response.statusCode === "number") {
            return error.response.statusCode;
        }
    }

    if (isRecord(error.data)) {
        if (typeof error.data.status === "number") {
            return error.data.status;
        }
        if (typeof error.data.statusCode === "number") {
            return error.data.statusCode;
        }
    }

    return undefined;
}

function extractCandidateErrorTexts(error: unknown): string[] {
    const candidates = new Set<string>();

    if (typeof error === "string") {
        candidates.add(error);
    }

    if (error instanceof Error) {
        if (error.message) {
            candidates.add(error.message);
        }
        const asString = error.toString();
        if (asString && asString !== error.message) {
            candidates.add(asString);
        }
    }

    if (isRecord(error)) {
        const nestedMessage = toOptionalString(error.message);
        if (nestedMessage) {
            candidates.add(nestedMessage);
        }
        const nestedError = toOptionalString(error.error);
        if (nestedError) {
            candidates.add(nestedError);
        }
    }

    const formatted = formatAnyError(error);
    if (formatted) {
        candidates.add(formatted);
    }

    return Array.from(candidates);
}

function isRateLimitError(error: unknown): boolean {
    const statusCode = extractStructuredStatusCode(error);
    if (statusCode !== undefined) {
        return STATUS_RATE_LIMIT_CODES.has(statusCode);
    }

    return extractCandidateErrorTexts(error).some((text) =>
        RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
    );
}

function getActiveMessageId(message: ModelMessage): string | undefined {
    return toOptionalString(asLooseRecord(message)?.id);
}

function getActiveEventId(message: ModelMessage): string | undefined {
    return toOptionalString(asLooseRecord(message)?.eventId);
}

function getFirstToolCallId(message: ModelMessage): string | undefined {
    const content = asLooseRecord(message)?.content;
    if (!Array.isArray(content)) {
        return undefined;
    }

    for (const part of content) {
        const partRecord = asLooseRecord(part);
        if (!partRecord) {
            continue;
        }
        const toolCallId = toOptionalString(partRecord.toolCallId);
        if (toolCallId) {
            return toolCallId;
        }
    }

    return undefined;
}

function classifyMessage(message: ModelMessage): string {
    const messageRecord = asLooseRecord(message);
    const role = normalizeRole(messageRecord?.role);
    const content = messageRecord?.content;

    if (role === "system") {
        return "system";
    }

    if (role === "tool") {
        return "tool-result";
    }

    if (Array.isArray(content)) {
        if (
            content.some((part) => toOptionalString(asLooseRecord(part)?.type) === "tool-result")
        ) {
            return "tool-result";
        }
        if (content.some((part) => toOptionalString(asLooseRecord(part)?.type) === "tool-call")) {
            return "tool-call";
        }
    }

    if (role === "assistant") {
        return "assistant";
    }

    if (role === "user") {
        return "user";
    }

    return role;
}

function renderMessageText(message: ModelMessage): string {
    const content = asLooseRecord(message)?.content;

    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return stringifyJson(content);
    }

    const renderedParts = content.map((part) => {
        const partRecord = asLooseRecord(part);
        if (!partRecord) {
            return stringifyJson(part);
        }
        const partType = toOptionalString(partRecord.type);

        if (partType === "text") {
            return toOptionalString(partRecord.text) ?? "";
        }

        if (partType === "tool-call") {
            return stringifyJson({
                type: partType,
                toolName: partRecord.toolName,
                toolCallId: partRecord.toolCallId,
                input: partRecord.input,
            });
        }

        if (partType === "tool-result") {
            return stringifyJson({
                type: partType,
                toolName: partRecord.toolName,
                toolCallId: partRecord.toolCallId,
                output: partRecord.output,
            });
        }

        if (partType === "tool-approval-request" || partType === "tool-approval-response") {
            return stringifyJson(partRecord);
        }

        return stringifyJson(partRecord);
    });

    return renderedParts.filter((part) => part.length > 0).join("\n");
}

function buildMessageHash(message: ModelMessage): string {
    const eventId = getActiveEventId(message);
    const messageId = getActiveMessageId(message);
    const payload = eventId
        ? `event:${eventId}`
            : messageId
                ? `id:${messageId}`
                : stringifyJson({
                    role: asLooseRecord(message)?.role,
                    content: asLooseRecord(message)?.content,
                });

    return createHash("sha256").update(payload).digest("hex");
}

function snapshotMessage(
    message: ModelMessage,
    options: {
        storeMessagePreviews: boolean;
        maxPreviewChars: number;
        storeFullMessageText: boolean;
    }
): MessageSnapshot {
    const renderedText = renderMessageText(message);
    const preview = options.storeMessagePreviews && renderedText.length > 0
        ? clipText(renderedText, options.maxPreviewChars)
        : undefined;
    const fullText = options.storeFullMessageText && renderedText.length > 0
        ? renderedText
        : undefined;

    return {
        messageHash: buildMessageHash(message),
        messageId: getActiveMessageId(message),
        sourceEventId: getActiveEventId(message),
        role: normalizeRole(asLooseRecord(message)?.role),
        classification: classifyMessage(message),
        estimatedTokens: Math.max(0, promptEstimator.estimateMessage(message as never)),
        preview,
        fullText,
        toolCallId: getFirstToolCallId(message),
    };
}

function buildThreadKey(
    conversationId: string | undefined,
    agentSlug: string | undefined,
    agentId: string | undefined
): string | undefined {
    if (!conversationId) {
        return undefined;
    }

    const agentKey = agentSlug ?? agentId;
    return agentKey ? `${conversationId}::${agentKey}` : undefined;
}

function getStatementChanges(result: unknown): number {
    const resultRecord = asLooseRecord(result);
    const changes = resultRecord?.changes;
    return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

export class AnalysisTelemetryService {
    private db: BunDatabase | null = null;
    private initialized = false;
    private dbPath: string | null = null;
    private lastRetentionSweepAt = 0;
    private pendingRuntimeMetrics = new Map<string, PendingRuntimeMetrics>();

    public isEnabled(): boolean {
        return configService.getAnalysisTelemetryConfig().enabled;
    }

    public createRequestSeed(params: {
        preparedPromptMetrics?: LLMRequestAnalysisSeed["preparedPromptMetrics"];
    }): LLMRequestAnalysisSeed | undefined {
        if (!this.isEnabled()) {
            return undefined;
        }

        const requestId = randomUUID();
        return {
            requestId,
            telemetryMetadata: {
                "analysis.request_id": requestId,
            },
            preparedPromptMetrics: params.preparedPromptMetrics,
        };
    }

    public createLLMAnalysisHooks(baseContext: AnalysisBaseContext): LLMAnalysisHooks | undefined {
        if (!this.isEnabled()) {
            return undefined;
        }

        return {
            openRequest: async (params) => {
                return await this.openRequest({
                    ...params,
                    baseContext,
                });
            },
        };
    }

    public openRequest(params: OpenRequestParams): LLMAnalysisRequestHandle | undefined {
        if (!this.isEnabled()) {
            return undefined;
        }

        const settings = configService.getAnalysisTelemetryConfig();
        const requestId = params.requestSeed?.requestId ?? randomUUID();
        const telemetryMetadata = {
            ...(params.requestSeed?.telemetryMetadata ?? {}),
            "analysis.request_id": requestId,
        };
        const preparedPromptMetrics = params.requestSeed?.preparedPromptMetrics;
        const promptCachingDiagnostics = params.requestSeed?.promptCachingDiagnostics;
        const runtimeMetrics = this.consumePendingRuntimeMetrics(requestId);
        const context = {
            projectId: params.baseContext.projectId,
            conversationId: params.baseContext.conversationId,
            agentSlug: params.baseContext.agentSlug,
            agentId: params.baseContext.agentId,
        };

        const db = this.ensureDb();
        const messageSnapshots = params.messages.map((message) =>
            snapshotMessage(message, {
                storeMessagePreviews: settings.storeMessagePreviews,
                maxPreviewChars: settings.maxPreviewChars,
                storeFullMessageText: settings.storeFullMessageText,
            })
        );

        db.exec("BEGIN");
        try {
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
                    status,
                    api_key_identity,
                    pre_context_estimated_input_tokens,
                    sent_estimated_input_tokens,
                    estimated_input_tokens_saved,
                    context_runtime_estimated_input_tokens_before,
                    context_runtime_estimated_input_tokens_after,
                    context_runtime_estimated_input_tokens_saved,
                    shared_prefix_breakpoint_applied,
                    shared_prefix_message_count,
                    shared_prefix_last_message_index
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(request_id) DO UPDATE SET
                    project_id = excluded.project_id,
                    conversation_id = excluded.conversation_id,
                    agent_slug = excluded.agent_slug,
                    agent_id = excluded.agent_id,
                    provider = excluded.provider,
                    model = excluded.model,
                    operation_kind = excluded.operation_kind,
                    started_at_ms = excluded.started_at_ms,
                    status = excluded.status,
                    api_key_identity = excluded.api_key_identity,
                    pre_context_estimated_input_tokens = excluded.pre_context_estimated_input_tokens,
                    sent_estimated_input_tokens = excluded.sent_estimated_input_tokens,
                    estimated_input_tokens_saved = excluded.estimated_input_tokens_saved,
                    context_runtime_estimated_input_tokens_before = COALESCE(
                        excluded.context_runtime_estimated_input_tokens_before,
                        llm_requests.context_runtime_estimated_input_tokens_before
                    ),
                    context_runtime_estimated_input_tokens_after = COALESCE(
                        excluded.context_runtime_estimated_input_tokens_after,
                        llm_requests.context_runtime_estimated_input_tokens_after
                    ),
                    context_runtime_estimated_input_tokens_saved = COALESCE(
                        excluded.context_runtime_estimated_input_tokens_saved,
                        llm_requests.context_runtime_estimated_input_tokens_saved
                    ),
                    shared_prefix_breakpoint_applied = excluded.shared_prefix_breakpoint_applied,
                    shared_prefix_message_count = excluded.shared_prefix_message_count,
                    shared_prefix_last_message_index = excluded.shared_prefix_last_message_index,
                    api_key_identity = excluded.api_key_identity
            `).run(
                requestId,
                context.projectId ?? null,
                context.conversationId ?? null,
                context.agentSlug ?? null,
                context.agentId ?? null,
                params.provider,
                params.model,
                params.operationKind,
                params.startedAt,
                "started",
                params.apiKeyIdentity ?? null,
                preparedPromptMetrics?.preContextEstimatedInputTokens ?? null,
                preparedPromptMetrics?.sentEstimatedInputTokens ?? null,
                preparedPromptMetrics?.estimatedInputTokensSaved ?? null,
                runtimeMetrics?.estimatedInputTokensBefore ?? null,
                runtimeMetrics?.estimatedInputTokensAfter ?? null,
                runtimeMetrics?.estimatedInputTokensSaved ?? null,
                promptCachingDiagnostics?.sharedPrefixBreakpointApplied === undefined
                    ? null
                    : promptCachingDiagnostics.sharedPrefixBreakpointApplied
                        ? 1
                        : 0,
                promptCachingDiagnostics?.sharedPrefixMessageCount ?? null,
                promptCachingDiagnostics?.sharedPrefixLastMessageIndex ?? null
            );

            db.prepare("DELETE FROM llm_request_messages WHERE request_id = ?").run(requestId);
            const insertMessage = db.prepare(`
                INSERT INTO llm_request_messages (
                    request_id,
                    message_index,
                    message_hash,
                    role,
                    classification,
                    estimated_tokens,
                    source_event_id,
                    message_id,
                    tool_call_id,
                    preview,
                    full_text,
                    created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const [index, snapshot] of messageSnapshots.entries()) {
                insertMessage.run(
                    requestId,
                    index,
                    snapshot.messageHash,
                    snapshot.role,
                    snapshot.classification,
                    snapshot.estimatedTokens,
                    snapshot.sourceEventId ?? null,
                    snapshot.messageId ?? null,
                    snapshot.toolCallId ?? null,
                    snapshot.preview ?? null,
                    snapshot.fullText ?? null,
                    params.startedAt
                );
            }

            this.updateCarryRuns({
                requestId,
                startedAt: params.startedAt,
                threadKey: buildThreadKey(
                    context.conversationId,
                    context.agentSlug,
                    context.agentId
                ),
                conversationId: context.conversationId,
                agentSlug: context.agentSlug,
                largeMessageThresholdTokens: settings.largeMessageThresholdTokens,
                projectId: context.projectId,
                messageSnapshots,
            });

            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            logger.warn("[AnalysisTelemetryService] Failed to open request row", {
                error: formatAnyError(error),
                requestId,
            });
            return undefined;
        }

        this.maybeSweepRetention(settings.retentionDays);

        return {
            requestId,
            telemetryMetadata,
            reportInvalidToolCalls: async ({ invalidToolCalls, recordedAt }) => {
                this.recordInvalidToolCalls(requestId, invalidToolCalls, recordedAt);
            },
            reportSuccess: async ({ completedAt, usage, finishReason, metadata }) => {
                void metadata;
                this.finalizeRequestSuccess(requestId, completedAt, usage, finishReason);
            },
            reportError: async ({ completedAt, error }) => {
                this.finalizeRequestError(requestId, completedAt, error);
            },
        };
    }

    public recordContextManagementEvent(
        event: ContextManagementTelemetryEvent,
        scope: ContextManagementAnalysisScope
    ): void {
        if (!this.isEnabled()) {
            return;
        }

        const db = this.ensureDb();
        const payload = this.extractContextManagementPayload(event);
        const createdAt = Date.now();

        try {
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
                    strategy_name,
                    tool_name,
                    tool_call_id,
                    outcome,
                    reason,
                    estimated_tokens_before,
                    estimated_tokens_after,
                    estimated_tokens_saved,
                    working_token_budget,
                    removed_tool_exchanges_delta,
                    removed_tool_exchanges_total,
                    pinned_tool_call_ids_delta,
                    pinned_tool_call_ids_total,
                    message_count_before,
                    message_count_after,
                    placeholder_tool_result_count,
                    placeholder_tool_input_count,
                    compaction_mode,
                    compaction_edit_count,
                    compaction_message_count,
                    compaction_from_index,
                    compaction_to_index,
                    messages_summarized_count,
                    summary_char_count,
                    entry_count,
                    entry_char_count,
                    forced_tool_choice,
                    current_prompt_tokens,
                    warning_threshold_tokens,
                    utilization_percent,
                    raw_estimate,
                    actual_tokens,
                    previous_factor,
                    new_factor,
                    sample_count,
                    payload_json,
                    created_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                scope.requestId,
                scope.projectId ?? null,
                scope.conversationId ?? null,
                scope.agentSlug ?? null,
                scope.agentId ?? null,
                scope.provider,
                scope.model,
                event.type,
                payload.strategyName ?? null,
                payload.toolName ?? null,
                payload.toolCallId ?? null,
                payload.outcome ?? null,
                payload.reason ?? null,
                payload.estimatedTokensBefore ?? null,
                payload.estimatedTokensAfter ?? null,
                payload.estimatedTokensSaved ?? null,
                payload.workingTokenBudget ?? null,
                payload.removedToolExchangesDelta ?? null,
                payload.removedToolExchangesTotal ?? null,
                payload.pinnedToolCallIdsDelta ?? null,
                payload.pinnedToolCallIdsTotal ?? null,
                payload.messageCountBefore ?? null,
                payload.messageCountAfter ?? null,
                payload.placeholderToolResultCount ?? null,
                payload.placeholderToolInputCount ?? null,
                payload.compactionMode ?? null,
                payload.compactionEditCount ?? null,
                payload.compactionMessageCount ?? null,
                payload.compactionFromIndex ?? null,
                payload.compactionToIndex ?? null,
                payload.messagesSummarizedCount ?? null,
                payload.summaryCharCount ?? null,
                payload.entryCount ?? null,
                payload.entryCharCount ?? null,
                payload.forcedToolChoice ?? null,
                payload.currentPromptTokens ?? null,
                payload.warningThresholdTokens ?? null,
                payload.utilizationPercent ?? null,
                payload.rawEstimate ?? null,
                payload.actualTokens ?? null,
                payload.previousFactor ?? null,
                payload.newFactor ?? null,
                payload.sampleCount ?? null,
                stringifyJson(payload.payloadJson),
                createdAt
            );
            if (event.type === "runtime-complete") {
                this.recordRuntimeMetrics(scope.requestId, {
                    estimatedInputTokensBefore: Math.max(0, event.estimatedTokensBefore),
                    estimatedInputTokensAfter: Math.max(0, event.estimatedTokensAfter),
                    estimatedInputTokensSaved: Math.max(
                        0,
                        event.estimatedTokensBefore - event.estimatedTokensAfter
                    ),
                    observedAt: createdAt,
                });
            }
        } catch (error) {
            logger.warn("[AnalysisTelemetryService] Failed to write context-management row", {
                error: formatAnyError(error),
                requestId: scope.requestId,
                eventType: event.type,
            });
        }
    }

    public getDbPath(): string {
        return configService.getAnalysisTelemetryConfig().dbPath;
    }

    public close(): void {
        if (!this.db) {
            return;
        }

        try {
            this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        } catch {
            // Best effort.
        }

        this.db.close(false);
        this.db = null;
        this.initialized = false;
        this.dbPath = null;
        this.pendingRuntimeMetrics.clear();
    }

    public resetForTests(): void {
        this.close();
    }

    public recordInvalidToolCalls(
        requestId: string,
        invalidToolCalls: InvalidToolCall[],
        recordedAt = Date.now()
    ): void {
        if (!this.isEnabled() || invalidToolCalls.length === 0) {
            return;
        }

        const db = this.ensureDb();
        const insertInvalidToolCall = db.prepare(`
            INSERT INTO invalid_tool_calls (
                request_id,
                step_number,
                tool_call_index,
                tool_name,
                tool_call_id,
                error_type,
                error_message,
                input_json,
                created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(request_id, step_number, tool_call_index) DO UPDATE SET
                tool_name = excluded.tool_name,
                tool_call_id = excluded.tool_call_id,
                error_type = excluded.error_type,
                error_message = excluded.error_message,
                input_json = excluded.input_json,
                created_at_ms = excluded.created_at_ms
        `);

        db.exec("BEGIN");
        try {
            for (const invalidToolCall of invalidToolCalls) {
                insertInvalidToolCall.run(
                    requestId,
                    invalidToolCall.stepNumber,
                    invalidToolCall.toolCallIndex,
                    invalidToolCall.toolName,
                    invalidToolCall.toolCallId ?? null,
                    invalidToolCall.errorType,
                    invalidToolCall.errorMessage,
                    invalidToolCall.input === undefined
                        ? null
                        : stringifyJson(invalidToolCall.input),
                    recordedAt
                );
            }
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            logger.warn("[AnalysisTelemetryService] Failed to write invalid tool call rows", {
                error: formatAnyError(error),
                requestId,
                invalidToolCallCount: invalidToolCalls.length,
            });
        }
    }

    private consumePendingRuntimeMetrics(requestId: string): PendingRuntimeMetrics | undefined {
        this.prunePendingRuntimeMetrics();
        const metrics = this.pendingRuntimeMetrics.get(requestId);
        if (metrics) {
            this.pendingRuntimeMetrics.delete(requestId);
        }
        return metrics;
    }

    private recordRuntimeMetrics(requestId: string, metrics: PendingRuntimeMetrics): void {
        const db = this.ensureDb();
        const result = db.prepare(`
            UPDATE llm_requests
            SET
                context_runtime_estimated_input_tokens_before = ?,
                context_runtime_estimated_input_tokens_after = ?,
                context_runtime_estimated_input_tokens_saved = ?
            WHERE request_id = ?
        `).run(
            metrics.estimatedInputTokensBefore,
            metrics.estimatedInputTokensAfter,
            metrics.estimatedInputTokensSaved,
            requestId
        );

        if (getStatementChanges(result) > 0) {
            this.pendingRuntimeMetrics.delete(requestId);
            return;
        }

        this.pendingRuntimeMetrics.set(requestId, metrics);
        this.prunePendingRuntimeMetrics(metrics.observedAt);
    }

    private prunePendingRuntimeMetrics(now = Date.now()): void {
        for (const [requestId, metrics] of this.pendingRuntimeMetrics) {
            if (now - metrics.observedAt <= PENDING_RUNTIME_METRICS_TTL_MS) {
                break;
            }
            this.pendingRuntimeMetrics.delete(requestId);
        }

        while (this.pendingRuntimeMetrics.size > MAX_PENDING_RUNTIME_METRICS) {
            const oldest = this.pendingRuntimeMetrics.keys().next().value;
            if (!oldest) {
                break;
            }
            this.pendingRuntimeMetrics.delete(oldest);
        }
    }

    private finalizeRequestSuccess(
        requestId: string,
        completedAt: number,
        usage: LanguageModelUsageWithCostUsd | undefined,
        finishReason: string | undefined
    ): void {
        if (!this.isEnabled()) {
            return;
        }

        // Extract total cleared tokens from context management edits
        try {
            this.ensureDb().prepare(`
                UPDATE llm_requests
                SET
                    completed_at_ms = ?,
                    status = ?,
                    finish_reason = ?,
                    input_tokens = ?,
                    output_tokens = ?,
                    total_tokens = ?,
                    input_no_cache_tokens = ?,
                    input_cache_read_tokens = ?,
                    input_cache_write_tokens = ?,
                    output_text_tokens = ?,
                    output_reasoning_tokens = ?,
                    cached_input_tokens = ?,
                    reasoning_tokens = ?,
                    cost_usd = ?
                WHERE request_id = ?
            `).run(
                completedAt,
                "success",
                finishReason ?? null,
                usage?.inputTokens ?? null,
                usage?.outputTokens ?? null,
                usage?.totalTokens ?? null,
                usage?.inputTokenDetails?.noCacheTokens ?? null,
                usage?.inputTokenDetails?.cacheReadTokens ?? null,
                usage?.inputTokenDetails?.cacheWriteTokens ?? null,
                usage?.outputTokenDetails?.textTokens ?? null,
                usage?.outputTokenDetails?.reasoningTokens ?? null,
                usage?.cachedInputTokens ?? null,
                usage?.reasoningTokens ?? null,
                usage?.costUsd ?? null,
                requestId
            );
        } catch (error) {
            logger.warn("[AnalysisTelemetryService] Failed to finalize successful request", {
                error: formatAnyError(error),
                requestId,
            });
        }
    }

    private finalizeRequestError(requestId: string, completedAt: number, error: unknown): void {
        if (!this.isEnabled()) {
            return;
        }

        try {
            this.ensureDb().prepare(`
                UPDATE llm_requests
                SET
                    completed_at_ms = ?,
                    status = ?,
                    error_message = ?,
                    rate_limit = ?
                WHERE request_id = ?
            `).run(
                completedAt,
                "error",
                formatAnyError(error),
                isRateLimitError(error) ? 1 : 0,
                requestId
            );
        } catch (writeError) {
            logger.warn("[AnalysisTelemetryService] Failed to finalize errored request", {
                error: formatAnyError(writeError),
                requestId,
            });
        }
    }

    private ensureDb(): BunDatabase {
        const settings = configService.getAnalysisTelemetryConfig();
        const resolvedDbPath = resolvePath(settings.dbPath);

        if (!this.db || !this.initialized || this.dbPath !== resolvedDbPath) {
            this.close();
            this.dbPath = resolvedDbPath;
            mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
            this.db = createBunDatabase(resolvedDbPath);
            new AnalysisSchemaManager(this.db).ensureSchema();
            this.initialized = true;
        }

        return this.db;
    }

    private maybeSweepRetention(retentionDays: number): void {
        const now = Date.now();
        if (now - this.lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
            return;
        }

        this.lastRetentionSweepAt = now;
        const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
        const db = this.ensureDb();

        db.exec("BEGIN");
        try {
            db.prepare("DELETE FROM llm_request_messages WHERE created_at_ms < ?").run(cutoff);
            db.prepare("DELETE FROM context_management_events WHERE created_at_ms < ?").run(cutoff);
            db.prepare("DELETE FROM message_carry_runs WHERE last_request_started_at_ms < ? AND is_open = 0").run(cutoff);
            db.prepare("DELETE FROM invalid_tool_calls WHERE created_at_ms < ?").run(cutoff);
            db.prepare("DELETE FROM llm_requests WHERE started_at_ms < ?").run(cutoff);
            db.exec("COMMIT");
        } catch (error) {
            db.exec("ROLLBACK");
            logger.warn("[AnalysisTelemetryService] Retention cleanup failed", {
                error: formatAnyError(error),
            });
        }
    }

    private updateCarryRuns(options: {
        requestId: string;
        startedAt: number;
        threadKey: string | undefined;
        conversationId?: string;
        agentSlug?: string;
        projectId?: string;
        largeMessageThresholdTokens: number;
        messageSnapshots: MessageSnapshot[];
    }): void {
        if (!options.threadKey || !options.conversationId || !options.agentSlug) {
            return;
        }

        const db = this.ensureDb();
        const openRuns = db.prepare(`
            SELECT
                run_id,
                message_hash
            FROM message_carry_runs
            WHERE thread_key = ? AND is_open = 1
        `).all(options.threadKey) as Array<{ run_id: number; message_hash: string }>;
        const openByHash = new Map(openRuns.map((row) => [row.message_hash, row.run_id]));
        const eligibleMessages = options.messageSnapshots.filter(
            (snapshot) => snapshot.estimatedTokens >= options.largeMessageThresholdTokens
        );
        const nextHashes = new Set(eligibleMessages.map((snapshot) => snapshot.messageHash));

        const closeRun = db.prepare(`
            UPDATE message_carry_runs
            SET is_open = 0, dropped = 1
            WHERE run_id = ?
        `);
        for (const run of openRuns) {
            if (!nextHashes.has(run.message_hash)) {
                closeRun.run(run.run_id);
            }
        }

        const updateRun = db.prepare(`
            UPDATE message_carry_runs
            SET
                last_request_id = ?,
                last_request_started_at_ms = ?,
                carry_request_count = carry_request_count + 1
            WHERE run_id = ?
        `);
        const insertRun = db.prepare(`
            INSERT INTO message_carry_runs (
                thread_key,
                project_id,
                conversation_id,
                agent_slug,
                message_hash,
                message_id,
                source_event_id,
                role,
                classification,
                estimated_tokens,
                tool_call_id,
                preview,
                full_text,
                first_request_id,
                last_request_id,
                first_request_started_at_ms,
                last_request_started_at_ms,
                carry_request_count,
                large_message_threshold_tokens,
                is_open,
                dropped
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
        `);

        for (const snapshot of eligibleMessages) {
            const runId = openByHash.get(snapshot.messageHash);
            if (runId) {
                updateRun.run(options.requestId, options.startedAt, runId);
                continue;
            }

            insertRun.run(
                options.threadKey,
                options.projectId ?? null,
                options.conversationId,
                options.agentSlug,
                snapshot.messageHash,
                snapshot.messageId ?? null,
                snapshot.sourceEventId ?? null,
                snapshot.role,
                snapshot.classification,
                snapshot.estimatedTokens,
                snapshot.toolCallId ?? null,
                snapshot.preview ?? null,
                snapshot.fullText ?? null,
                options.requestId,
                options.requestId,
                options.startedAt,
                options.startedAt,
                1,
                options.largeMessageThresholdTokens
            );
        }
    }

    private extractContextManagementPayload(event: ContextManagementTelemetryEvent): Record<string, Primitive | object | undefined> {
        switch (event.type) {
            case "runtime-start":
                return {
                    estimatedTokensBefore: event.estimatedTokensBefore,
                    messageCountBefore: event.messageCount,
                    payloadJson: event.payloads,
                };
            case "strategy-complete": {
                const payload = isRecord(event.strategyPayload) ? event.strategyPayload : undefined;
                return {
                    strategyName: event.strategyName,
                    outcome: event.outcome,
                    reason: event.reason,
                    estimatedTokensBefore: event.estimatedTokensBefore,
                    estimatedTokensAfter: event.estimatedTokensAfter,
                    estimatedTokensSaved: Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter),
                    workingTokenBudget: event.workingTokenBudget,
                    removedToolExchangesDelta: event.removedToolExchangesDelta,
                    removedToolExchangesTotal: event.removedToolExchangesTotal,
                    pinnedToolCallIdsDelta: event.pinnedToolCallIdsDelta,
                    messageCountBefore: event.messageCountBefore,
                    messageCountAfter: event.messageCountAfter,
                    placeholderToolResultCount: toOptionalInteger(payload?.placeholderCount),
                    placeholderToolInputCount: toOptionalInteger(payload?.inputPlaceholderCount),
                    compactionMode: toOptionalString(payload?.mode),
                    compactionEditCount: toOptionalInteger(payload?.editCount),
                    compactionMessageCount: toOptionalInteger(payload?.compactedMessageCount),
                    compactionFromIndex: toOptionalInteger(payload?.fromIndex),
                    compactionToIndex: toOptionalInteger(payload?.toIndex),
                    messagesSummarizedCount: toOptionalInteger(payload?.messagesSummarizedCount),
                    summaryCharCount: toOptionalInteger(payload?.summaryCharCount),
                    entryCount: toOptionalInteger(payload?.entryCount),
                    entryCharCount: toOptionalInteger(payload?.entryCharCount),
                    forcedToolChoice: typeof payload?.forcedToolChoice === "boolean"
                        ? (payload.forcedToolChoice ? 1 : 0)
                        : undefined,
                    currentPromptTokens: toOptionalInteger(payload?.currentTokens ?? payload?.currentPromptTokens ?? payload?.estimatedPromptTokens),
                    warningThresholdTokens: toOptionalInteger(payload?.warningThresholdTokens),
                    utilizationPercent: toOptionalNumber(
                        payload?.utilizationPercent
                            ?? payload?.workingBudgetUtilizationPercent
                            ?? payload?.rawContextUtilizationPercent
                    ),
                    payloadJson: event.strategyPayload,
                };
            }
            case "tool-execute-start":
                return {
                    strategyName: event.strategyName,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    payloadJson: event.payloads,
                };
            case "tool-execute-complete":
                return {
                    strategyName: event.strategyName,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    payloadJson: event.payloads,
                };
            case "tool-execute-error":
                return {
                    strategyName: event.strategyName,
                    toolName: event.toolName,
                    toolCallId: event.toolCallId,
                    payloadJson: event.payloads,
                };
            case "runtime-complete":
                return {
                    estimatedTokensBefore: event.estimatedTokensBefore,
                    estimatedTokensAfter: event.estimatedTokensAfter,
                    estimatedTokensSaved: Math.max(0, event.estimatedTokensBefore - event.estimatedTokensAfter),
                    removedToolExchangesTotal: event.removedToolExchangesTotal,
                    pinnedToolCallIdsTotal: event.pinnedToolCallIdsTotal,
                    messageCountBefore: event.messageCountBefore,
                    messageCountAfter: event.messageCountAfter,
                    payloadJson: event.payloads,
                };
            case "calibration-update":
                return {
                    rawEstimate: event.rawEstimate,
                    actualTokens: event.actualTokens,
                    previousFactor: event.previousFactor,
                    newFactor: event.newFactor,
                    sampleCount: event.sampleCount,
                    payloadJson: undefined,
                };
        }
    }
}

export const analysisTelemetryService = new AnalysisTelemetryService();
