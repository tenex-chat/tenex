// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BunDatabase = any;

const ANALYSIS_SCHEMA_VERSION = "7";

export class AnalysisSchemaManager {
    public constructor(private readonly db: BunDatabase) {}

    public ensureSchema(): void {
        this.configureDatabase();
        this.createBaseSchema();
        const previousVersion = this.getSchemaVersion();
        this.migrateSchema(previousVersion);
        this.createIndexes();
        this.recreateViews();
        this.setSchemaVersion(ANALYSIS_SCHEMA_VERSION);
    }

    private configureDatabase(): void {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA foreign_keys = OFF");
        this.db.exec("PRAGMA busy_timeout = 5000");
    }

    private createBaseSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS analysis_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS llm_requests (
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
                estimated_input_tokens_saved INTEGER,
                context_runtime_estimated_input_tokens_before INTEGER,
                context_runtime_estimated_input_tokens_after INTEGER,
                context_runtime_estimated_input_tokens_saved INTEGER,
                shared_prefix_breakpoint_applied INTEGER,
                shared_prefix_message_count INTEGER,
                shared_prefix_last_message_index INTEGER,
                api_key_identity TEXT
            );

            CREATE TABLE IF NOT EXISTS llm_request_messages (
                request_id TEXT NOT NULL,
                message_index INTEGER NOT NULL,
                message_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                classification TEXT NOT NULL,
                estimated_tokens INTEGER,
                source_event_id TEXT,
                message_id TEXT,
                tool_call_id TEXT,
                preview TEXT,
                full_text TEXT,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (request_id, message_index)
            );

            CREATE TABLE IF NOT EXISTS context_management_events (
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
                compaction_mode TEXT,
                compaction_edit_count INTEGER,
                compaction_message_count INTEGER,
                compaction_from_index INTEGER,
                compaction_to_index INTEGER,
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

            CREATE TABLE IF NOT EXISTS message_carry_runs (
                run_id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_key TEXT NOT NULL,
                project_id TEXT,
                conversation_id TEXT NOT NULL,
                agent_slug TEXT NOT NULL,
                message_hash TEXT NOT NULL,
                message_id TEXT,
                source_event_id TEXT,
                role TEXT NOT NULL,
                classification TEXT NOT NULL,
                estimated_tokens INTEGER NOT NULL,
                tool_call_id TEXT,
                preview TEXT,
                full_text TEXT,
                first_request_id TEXT NOT NULL,
                last_request_id TEXT NOT NULL,
                first_request_started_at_ms INTEGER NOT NULL,
                last_request_started_at_ms INTEGER NOT NULL,
                carry_request_count INTEGER NOT NULL,
                large_message_threshold_tokens INTEGER NOT NULL,
                is_open INTEGER NOT NULL DEFAULT 1,
                dropped INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS invalid_tool_calls (
                request_id TEXT NOT NULL,
                step_number INTEGER NOT NULL,
                tool_call_index INTEGER NOT NULL,
                tool_name TEXT NOT NULL,
                tool_call_id TEXT,
                error_type TEXT,
                error_message TEXT,
                input_json TEXT,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (request_id, step_number, tool_call_index)
            );
        `);
    }

    private createIndexes(): void {
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_llm_requests_started_at
                ON llm_requests (started_at_ms);
            CREATE INDEX IF NOT EXISTS idx_llm_requests_grouping
                ON llm_requests (project_id, provider, api_key_identity, agent_slug, started_at_ms);
            CREATE INDEX IF NOT EXISTS idx_llm_requests_api_key_identity
                ON llm_requests(api_key_identity);
            CREATE INDEX IF NOT EXISTS idx_llm_requests_rate_limit
                ON llm_requests (rate_limit, started_at_ms);

            CREATE INDEX IF NOT EXISTS idx_context_management_started_at
                ON context_management_events (created_at_ms);
            CREATE INDEX IF NOT EXISTS idx_context_management_grouping
                ON context_management_events (
                    project_id,
                    provider,
                    agent_slug,
                    strategy_name,
                    created_at_ms
                );
            CREATE INDEX IF NOT EXISTS idx_context_management_request_id
                ON context_management_events (request_id);

            CREATE INDEX IF NOT EXISTS idx_message_carry_runs_thread
                ON message_carry_runs (thread_key, is_open);
            CREATE INDEX IF NOT EXISTS idx_message_carry_runs_started_at
                ON message_carry_runs (first_request_started_at_ms);

            CREATE INDEX IF NOT EXISTS idx_invalid_tool_calls_created_at
                ON invalid_tool_calls (created_at_ms);
            CREATE INDEX IF NOT EXISTS idx_invalid_tool_calls_tool_name
                ON invalid_tool_calls (tool_name, created_at_ms);
            CREATE INDEX IF NOT EXISTS idx_invalid_tool_calls_request
                ON invalid_tool_calls (request_id);
        `);
    }

    private recreateViews(): void {
        this.db.exec(`
            DROP VIEW IF EXISTS analysis_usage_rows;
            DROP VIEW IF EXISTS analysis_context_impact_rows;
            DROP VIEW IF EXISTS analysis_rate_limit_rows;
            DROP VIEW IF EXISTS analysis_message_carry_rows;
            DROP VIEW IF EXISTS analysis_invalid_tool_call_rows;
            DROP VIEW IF EXISTS analysis_unfinalized_request_rows;

            CREATE VIEW analysis_usage_rows AS
                SELECT
                    request_id,
                    project_id,
                    conversation_id,
                    agent_slug,
                    agent_id,
                    provider,
                    model,
                    api_key_identity,
                    operation_kind,
                    started_at_ms,
                    completed_at_ms,
                    status,
                    finish_reason,
                    error_message,
                    rate_limit,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    input_no_cache_tokens,
                    input_cache_read_tokens,
                    input_cache_write_tokens,
                    output_text_tokens,
                    output_reasoning_tokens,
                    cached_input_tokens,
                    reasoning_tokens,
                    cost_usd,
                    context_runtime_estimated_input_tokens_before,
                    context_runtime_estimated_input_tokens_after,
                    context_runtime_estimated_input_tokens_saved,
                    shared_prefix_breakpoint_applied,
                    shared_prefix_message_count,
                    shared_prefix_last_message_index,
                    pre_context_estimated_input_tokens,
                    sent_estimated_input_tokens,
                    pre_context_estimated_input_tokens AS prepared_prompt_estimated_input_tokens_before,
                    sent_estimated_input_tokens AS prepared_prompt_estimated_input_tokens_after,
                    estimated_input_tokens_saved AS prepared_prompt_estimated_input_tokens_saved,
                    COALESCE(
                        context_runtime_estimated_input_tokens_saved,
                        estimated_input_tokens_saved
                    ) AS estimated_input_tokens_saved
                FROM llm_requests;

            CREATE VIEW analysis_context_impact_rows AS
                SELECT
                    id,
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
                    created_at_ms
                FROM context_management_events;

            CREATE VIEW analysis_rate_limit_rows AS
                SELECT * FROM analysis_usage_rows
                WHERE rate_limit = 1;

            CREATE VIEW analysis_message_carry_rows AS
                SELECT
                    run_id,
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
                FROM message_carry_runs;

            CREATE VIEW analysis_invalid_tool_call_rows AS
                SELECT
                    itc.request_id,
                    lr.project_id,
                    lr.conversation_id,
                    lr.agent_slug,
                    lr.agent_id,
                    lr.provider,
                    lr.model,
                    lr.api_key_identity,
                    lr.operation_kind,
                    lr.started_at_ms,
                    lr.completed_at_ms,
                    itc.step_number,
                    itc.tool_call_index,
                    itc.tool_name,
                    itc.tool_call_id,
                    itc.error_type,
                    itc.error_message,
                    itc.input_json,
                    itc.created_at_ms
                FROM invalid_tool_calls itc
                LEFT JOIN llm_requests lr
                    ON lr.request_id = itc.request_id;

            CREATE VIEW analysis_unfinalized_request_rows AS
                SELECT *
                FROM analysis_usage_rows
                WHERE status = 'started';
        `);
    }

    private getSchemaVersion(): string | undefined {
        const version = this.db.prepare(
            "SELECT value FROM analysis_meta WHERE key = ?"
        ).get("schema_version") as { value?: string } | null;
        return version?.value;
    }

    private setSchemaVersion(version: string): void {
        this.db.prepare(`
            INSERT INTO analysis_meta (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run("schema_version", version);
    }

    private migrateSchema(previousVersion: string | undefined): void {
        const addedRuntimeColumns = this.ensureRequestRuntimeColumns();
        const addedPromptCachingColumns = this.ensureRequestPromptCachingColumns();
        const addedApiKeyIdentityColumn = this.ensureApiKeyIdentityColumn();
        const addedCompactionColumns = this.ensureContextManagementCompactionColumns();
        if (
            addedRuntimeColumns
            || addedPromptCachingColumns
            || addedApiKeyIdentityColumn
            || addedCompactionColumns
            || previousVersion !== ANALYSIS_SCHEMA_VERSION
        ) {
            this.backfillRuntimeMetricsFromContextEvents();
        }
    }

    private ensureRequestRuntimeColumns(): boolean {
        let addedColumns = false;

        if (!this.hasColumn("llm_requests", "context_runtime_estimated_input_tokens_before")) {
            this.addColumn(
                "llm_requests",
                "context_runtime_estimated_input_tokens_before INTEGER"
            );
            addedColumns = true;
        }

        if (!this.hasColumn("llm_requests", "context_runtime_estimated_input_tokens_after")) {
            this.addColumn(
                "llm_requests",
                "context_runtime_estimated_input_tokens_after INTEGER"
            );
            addedColumns = true;
        }

        if (!this.hasColumn("llm_requests", "context_runtime_estimated_input_tokens_saved")) {
            this.addColumn(
                "llm_requests",
                "context_runtime_estimated_input_tokens_saved INTEGER"
            );
            addedColumns = true;
        }

        return addedColumns;
    }

    private ensureRequestPromptCachingColumns(): boolean {
        let addedColumns = false;

        if (!this.hasColumn("llm_requests", "shared_prefix_breakpoint_applied")) {
            this.addColumn("llm_requests", "shared_prefix_breakpoint_applied INTEGER");
            addedColumns = true;
        }

        if (!this.hasColumn("llm_requests", "shared_prefix_message_count")) {
            this.addColumn("llm_requests", "shared_prefix_message_count INTEGER");
            addedColumns = true;
        }

        if (!this.hasColumn("llm_requests", "shared_prefix_last_message_index")) {
            this.addColumn("llm_requests", "shared_prefix_last_message_index INTEGER");
            addedColumns = true;
        }

        return addedColumns;
    }

    private ensureContextManagementCompactionColumns(): boolean {
        let addedColumns = false;

        if (!this.hasColumn("context_management_events", "compaction_mode")) {
            this.addColumn("context_management_events", "compaction_mode TEXT");
            addedColumns = true;
        }

        if (!this.hasColumn("context_management_events", "compaction_edit_count")) {
            this.addColumn("context_management_events", "compaction_edit_count INTEGER");
            addedColumns = true;
        }

        if (!this.hasColumn("context_management_events", "compaction_message_count")) {
            this.addColumn("context_management_events", "compaction_message_count INTEGER");
            addedColumns = true;
        }

        if (!this.hasColumn("context_management_events", "compaction_from_index")) {
            this.addColumn("context_management_events", "compaction_from_index INTEGER");
            addedColumns = true;
        }

        if (!this.hasColumn("context_management_events", "compaction_to_index")) {
            this.addColumn("context_management_events", "compaction_to_index INTEGER");
            addedColumns = true;
        }

        return addedColumns;
    }

    private ensureApiKeyIdentityColumn(): boolean {
        if (this.hasColumn("llm_requests", "api_key_identity")) {
            return false;
        }
        this.addColumn("llm_requests", "api_key_identity TEXT");
        return true;
    }

    private hasColumn(tableName: string, columnName: string): boolean {
        const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
        return columns.some((column) => column.name === columnName);
    }

    private addColumn(tableName: string, columnDefinition: string): void {
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
    }

    private backfillRuntimeMetricsFromContextEvents(): void {
        this.db.exec(`
            UPDATE llm_requests
            SET
                context_runtime_estimated_input_tokens_before = (
                    SELECT estimated_tokens_before
                    FROM context_management_events
                    WHERE request_id = llm_requests.request_id
                      AND event_type = 'runtime-complete'
                    ORDER BY id DESC
                    LIMIT 1
                ),
                context_runtime_estimated_input_tokens_after = (
                    SELECT estimated_tokens_after
                    FROM context_management_events
                    WHERE request_id = llm_requests.request_id
                      AND event_type = 'runtime-complete'
                    ORDER BY id DESC
                    LIMIT 1
                ),
                context_runtime_estimated_input_tokens_saved = (
                    SELECT estimated_tokens_saved
                    FROM context_management_events
                    WHERE request_id = llm_requests.request_id
                      AND event_type = 'runtime-complete'
                    ORDER BY id DESC
                    LIMIT 1
                )
            WHERE EXISTS (
                SELECT 1
                FROM context_management_events
                WHERE request_id = llm_requests.request_id
                  AND event_type = 'runtime-complete'
            )
        `);
    }
}
