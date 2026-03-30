import { existsSync } from "node:fs";
import { config as configService } from "@/services/ConfigService";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

function createBunDatabase(dbPath: string): SqliteDatabase {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite");
    return new Database(dbPath, { readonly: true });
}

type UsageGroupKey = "project" | "provider" | "agent";
type ContextGroupKey = "project" | "provider" | "agent" | "strategy";

const usageGroupColumns: Record<UsageGroupKey, { select: string; group: string }> = {
    project: {
        select: "project_id AS projectId",
        group: "project_id",
    },
    provider: {
        select: "provider AS provider",
        group: "provider",
    },
    agent: {
        select: "agent_slug AS agentSlug",
        group: "agent_slug",
    },
};

const contextGroupColumns: Record<ContextGroupKey, { select: string; group: string }> = {
    project: {
        select: "project_id AS projectId",
        group: "project_id",
    },
    provider: {
        select: "provider AS provider",
        group: "provider",
    },
    agent: {
        select: "agent_slug AS agentSlug",
        group: "agent_slug",
    },
    strategy: {
        select: "strategy_name AS strategyName",
        group: "strategy_name",
    },
};

function addInClause(
    clauses: string[],
    values: Array<string | number>,
    column: string,
    entries: string[] | undefined
): void {
    if (!entries || entries.length === 0) {
        return;
    }

    clauses.push(`${column} IN (${entries.map(() => "?").join(", ")})`);
    values.push(...entries);
}

export class AnalysisQueryService {
    private db: SqliteDatabase | null = null;
    private dbPath: string | null = null;

    public getUsageTotals(options: {
        since: number;
        until: number;
        groupBy: UsageGroupKey[];
        projectIds?: string[];
        providers?: string[];
        agentSlugs?: string[];
        includeUnscopedProjects?: boolean;
    }): Array<Record<string, number | string | null>> {
        return this.queryGroupedUsage(options);
    }

    public getContextSavingsTotals(options: {
        since: number;
        until: number;
        groupBy: ContextGroupKey[];
        projectIds?: string[];
        providers?: string[];
        agentSlugs?: string[];
        strategyNames?: string[];
        includeUnscopedProjects?: boolean;
    }): Array<Record<string, number | string | null>> {
        const db = this.ensureDb();
        if (!db) {
            return [];
        }

        const clauses = [
            "created_at_ms >= ?",
            "created_at_ms <= ?",
            "event_type = 'strategy-complete'",
            "estimated_tokens_saved IS NOT NULL",
        ];
        const values: Array<string | number> = [options.since, options.until];

        addInClause(clauses, values, "project_id", options.projectIds);
        addInClause(clauses, values, "provider", options.providers);
        addInClause(clauses, values, "agent_slug", options.agentSlugs);
        addInClause(clauses, values, "strategy_name", options.strategyNames);

        if (options.groupBy.includes("project") && !options.includeUnscopedProjects) {
            clauses.push("project_id IS NOT NULL");
        }

        const selectGroups = options.groupBy.map((key) => contextGroupColumns[key].select);
        const groupColumns = options.groupBy.map((key) => contextGroupColumns[key].group);
        const selectPrefix = selectGroups.length > 0 ? `${selectGroups.join(", ")}, ` : "";
        const groupByClause = groupColumns.length > 0 ? `GROUP BY ${groupColumns.join(", ")}` : "";
        const orderBy = "ORDER BY estimatedInputTokensSaved DESC, eventCount DESC";

        return db.prepare(`
            SELECT
                ${selectPrefix}
                COUNT(*) AS eventCount,
                SUM(COALESCE(estimated_tokens_before, 0)) AS estimatedInputTokensBefore,
                SUM(COALESCE(estimated_tokens_after, 0)) AS estimatedInputTokensAfter,
                SUM(COALESCE(estimated_tokens_saved, 0)) AS estimatedInputTokensSaved
            FROM analysis_context_impact_rows
            WHERE ${clauses.join(" AND ")}
            ${groupByClause}
            ${orderBy}
        `).all(...values) as Array<Record<string, number | string | null>>;
    }

    public listRateLimitEvents(options: {
        since: number;
        until: number;
        projectIds?: string[];
        providers?: string[];
        agentSlugs?: string[];
        limit?: number;
    }): Array<Record<string, number | string | null>> {
        const db = this.ensureDb();
        if (!db) {
            return [];
        }

        const clauses = [
            "started_at_ms >= ?",
            "started_at_ms <= ?",
        ];
        const values: Array<string | number> = [options.since, options.until];

        addInClause(clauses, values, "project_id", options.projectIds);
        addInClause(clauses, values, "provider", options.providers);
        addInClause(clauses, values, "agent_slug", options.agentSlugs);

        const limit = options.limit ?? 100;
        values.push(limit);

        return db.prepare(`
            SELECT
                request_id AS requestId,
                project_id AS projectId,
                conversation_id AS conversationId,
                agent_slug AS agentSlug,
                provider,
                model,
                operation_kind AS operationKind,
                started_at_ms AS startedAt,
                completed_at_ms AS completedAt,
                error_message AS errorMessage
            FROM analysis_rate_limit_rows
            WHERE ${clauses.join(" AND ")}
            ORDER BY started_at_ms DESC
            LIMIT ?
        `).all(...values) as Array<Record<string, number | string | null>>;
    }

    public getRateLimitCounts(options: {
        since: number;
        until: number;
        groupBy: UsageGroupKey[];
        projectIds?: string[];
        providers?: string[];
        agentSlugs?: string[];
        includeUnscopedProjects?: boolean;
    }): Array<Record<string, number | string | null>> {
        const db = this.ensureDb();
        if (!db) {
            return [];
        }

        const clauses = [
            "started_at_ms >= ?",
            "started_at_ms <= ?",
        ];
        const values: Array<string | number> = [options.since, options.until];

        addInClause(clauses, values, "project_id", options.projectIds);
        addInClause(clauses, values, "provider", options.providers);
        addInClause(clauses, values, "agent_slug", options.agentSlugs);

        if (options.groupBy.includes("project") && !options.includeUnscopedProjects) {
            clauses.push("project_id IS NOT NULL");
        }

        const selectGroups = options.groupBy.map((key) => usageGroupColumns[key].select);
        const groupColumns = options.groupBy.map((key) => usageGroupColumns[key].group);
        const selectPrefix = selectGroups.length > 0 ? `${selectGroups.join(", ")}, ` : "";
        const groupByClause = groupColumns.length > 0 ? `GROUP BY ${groupColumns.join(", ")}` : "";

        return db.prepare(`
            SELECT
                ${selectPrefix}
                COUNT(*) AS rateLimitCount
            FROM analysis_rate_limit_rows
            WHERE ${clauses.join(" AND ")}
            ${groupByClause}
            ORDER BY rateLimitCount DESC
        `).all(...values) as Array<Record<string, number | string | null>>;
    }

    public listUnfinalizedRequests(options: {
        since: number;
        until?: number;
        olderThanMs?: number;
        projectIds?: string[];
        providers?: string[];
        agentSlugs?: string[];
        includeUnscopedProjects?: boolean;
        limit?: number;
    }): Array<Record<string, number | string | null>> {
        const db = this.ensureDb();
        if (!db) {
            return [];
        }

        const now = Date.now();
        const clauses = [
            "started_at_ms >= ?",
        ];
        const values: Array<string | number> = [now, options.since];

        if (options.until !== undefined) {
            clauses.push("started_at_ms <= ?");
            values.push(options.until);
        }

        if (options.olderThanMs !== undefined) {
            clauses.push("started_at_ms <= ?");
            values.push(now - options.olderThanMs);
        }

        addInClause(clauses, values, "project_id", options.projectIds);
        addInClause(clauses, values, "provider", options.providers);
        addInClause(clauses, values, "agent_slug", options.agentSlugs);

        if (!options.includeUnscopedProjects) {
            clauses.push("project_id IS NOT NULL");
        }

        const limit = options.limit ?? 100;
        values.push(limit);

        return db.prepare(`
            SELECT
                request_id AS requestId,
                project_id AS projectId,
                conversation_id AS conversationId,
                agent_slug AS agentSlug,
                provider,
                model,
                operation_kind AS operationKind,
                started_at_ms AS startedAt,
                (? - started_at_ms) AS ageMs
            FROM analysis_unfinalized_request_rows
            WHERE ${clauses.join(" AND ")}
            ORDER BY started_at_ms ASC
            LIMIT ?
        `).all(...values) as Array<Record<string, number | string | null>>;
    }

    public listMessageCarryRuns(options: {
        since: number;
        until?: number;
        projectIds?: string[];
        agentSlugs?: string[];
        includeSystem?: boolean;
        openOnly?: boolean;
        limit?: number;
    }): Array<Record<string, number | string | null>> {
        const db = this.ensureDb();
        if (!db) {
            return [];
        }

        const clauses = [
            "last_request_started_at_ms >= ?",
        ];
        const values: Array<string | number> = [options.since];

        if (options.until !== undefined) {
            clauses.push("last_request_started_at_ms <= ?");
            values.push(options.until);
        }

        addInClause(clauses, values, "project_id", options.projectIds);
        addInClause(clauses, values, "agent_slug", options.agentSlugs);

        if (!options.includeSystem) {
            clauses.push("classification != 'system'");
        }

        if (options.openOnly) {
            clauses.push("is_open = 1");
        }

        const limit = options.limit ?? 100;
        values.push(limit);

        return db.prepare(`
            SELECT
                run_id AS runId,
                project_id AS projectId,
                conversation_id AS conversationId,
                agent_slug AS agentSlug,
                classification,
                estimated_tokens AS estimatedTokens,
                carry_request_count AS carryRequestCount,
                is_open AS isOpen,
                dropped,
                preview,
                first_request_started_at_ms AS firstRequestStartedAt,
                last_request_started_at_ms AS lastRequestStartedAt
            FROM analysis_message_carry_rows
            WHERE ${clauses.join(" AND ")}
            ORDER BY carry_request_count DESC, estimated_tokens DESC
            LIMIT ?
        `).all(...values) as Array<Record<string, number | string | null>>;
    }

    public close(): void {
        if (!this.db) {
            return;
        }

        this.db.close(false);
        this.db = null;
        this.dbPath = null;
    }

    private ensureDb(): SqliteDatabase | null {
        const dbPath = configService.getAnalysisTelemetryConfig().dbPath;
        if (!existsSync(dbPath)) {
            return null;
        }

        if (!this.db || this.dbPath !== dbPath) {
            this.close();
            this.db = createBunDatabase(dbPath);
            this.db.exec("PRAGMA busy_timeout = 5000");
            this.dbPath = dbPath;
        }

        return this.db;
    }

    private queryGroupedUsage(options: {
        since: number;
        until: number;
        groupBy: UsageGroupKey[];
        projectIds?: string[];
        providers?: string[];
        agentSlugs?: string[];
        includeUnscopedProjects?: boolean;
    }): Array<Record<string, number | string | null>> {
        const db = this.ensureDb();
        if (!db) {
            return [];
        }

        const clauses = [
            "started_at_ms >= ?",
            "started_at_ms <= ?",
        ];
        const values: Array<string | number> = [options.since, options.until];

        addInClause(clauses, values, "project_id", options.projectIds);
        addInClause(clauses, values, "provider", options.providers);
        addInClause(clauses, values, "agent_slug", options.agentSlugs);

        if (options.groupBy.includes("project") && !options.includeUnscopedProjects) {
            clauses.push("project_id IS NOT NULL");
        }

        const selectGroups = options.groupBy.map((key) => usageGroupColumns[key].select);
        const groupColumns = options.groupBy.map((key) => usageGroupColumns[key].group);
        const selectPrefix = selectGroups.length > 0 ? `${selectGroups.join(", ")}, ` : "";
        const groupByClause = groupColumns.length > 0 ? `GROUP BY ${groupColumns.join(", ")}` : "";

        return db.prepare(`
            SELECT
                ${selectPrefix}
                COUNT(*) AS requestCount,
                SUM(COALESCE(input_tokens, 0)) AS inputTokens,
                SUM(COALESCE(output_tokens, 0)) AS outputTokens,
                SUM(COALESCE(total_tokens, 0)) AS totalTokens,
                SUM(COALESCE(input_no_cache_tokens, 0)) AS noCacheInputTokens,
                SUM(COALESCE(input_cache_read_tokens, 0)) AS cacheReadInputTokens,
                SUM(COALESCE(input_cache_write_tokens, 0)) AS cacheWriteInputTokens,
                SUM(COALESCE(context_runtime_estimated_input_tokens_before, 0)) AS contextRuntimeEstimatedInputTokensBefore,
                SUM(COALESCE(context_runtime_estimated_input_tokens_after, 0)) AS contextRuntimeEstimatedInputTokensAfter,
                SUM(COALESCE(context_runtime_estimated_input_tokens_saved, 0)) AS contextRuntimeEstimatedInputTokensSaved,
                SUM(COALESCE(prepared_prompt_estimated_input_tokens_before, 0)) AS preparedPromptEstimatedInputTokensBefore,
                SUM(COALESCE(prepared_prompt_estimated_input_tokens_after, 0)) AS preparedPromptEstimatedInputTokensAfter,
                SUM(COALESCE(prepared_prompt_estimated_input_tokens_saved, 0)) AS preparedPromptEstimatedInputTokensSaved,
                SUM(COALESCE(estimated_input_tokens_saved, 0)) AS estimatedInputTokensSaved
            FROM analysis_usage_rows
            WHERE ${clauses.join(" AND ")}
            ${groupByClause}
            ORDER BY inputTokens DESC, requestCount DESC
        `).all(...values) as Array<Record<string, number | string | null>>;
    }
}

export const analysisQueryService = new AnalysisQueryService();
