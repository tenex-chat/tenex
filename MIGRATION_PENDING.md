# TENEX Migration Pending: TypeScript → Rust

Feature parity gaps between the TypeScript runtime and the Rust agent/daemon stack.
Organized by functional area. Items marked ✅ are already at parity; items marked ❌ are missing or incomplete in Rust.

> **TypeScript reference**: the TypeScript runtime source has been removed from this repo. For looking up how something worked in TypeScript, use the read-only reference worktree at `/home/pablo/Work/tenex-typescript-ref` (commit `35738290`, 2026-04-27).

---

## 1. Agent Tools

### 1.1 Fully Missing Tools (TypeScript-only)
- ✅ `send_message` — proactive Telegram delivery to bound channels (note: agent won't know channel IDs until Fragment 08 injects Telegram bindings into the system prompt)
- [ ] `mcp_list_resources` — discover available MCP resources and resource templates from configured servers
- [ ] `mcp_resource_read` — fetch content from an MCP resource, with URI template expansion
- [ ] `mcp_subscribe` — create persistent subscriptions to MCP resource update notifications
- [ ] `mcp_subscription_stop` — cancel an active MCP resource subscription
- 🚫 `rag_subscription_create` — won't port (RAG subscriptions are a TypeScript-only abstraction)
- 🚫 `rag_subscription_delete` — won't port
- 🚫 `rag_subscription_get` — won't port
- 🚫 `rag_subscription_list` — won't port
- 🚫 `rag_collection_create` — won't port (collection management scoped to TypeScript RAG layer)
- 🚫 `rag_collection_delete` — won't port
- 🚫 `rag_collection_list` — won't port
- 🚫 `rag_collection_get` — won't port

### 1.2 Partially Implemented Tools (parameter/behavior gaps)

#### `conversation_get`
- ✅ `untilId` parameter — slice conversation transcript to a specific message ID
- ✅ `prompt` parameter — LLM-driven conversation analysis with structured output
- [ ] `includeToolCalls` parameter — include tool-call/result pairs in transcript
- [ ] XML-formatted transcript output (Rust returns plain text `[role] author8: content`)
- [ ] Relative timestamp formatting in output

#### `conversation_list`
- ✅ `projectId` parameter — cross-project listing (`"ALL"` queries all projects under `~/.tenex/projects/`)
- ✅ `with` parameter — filter conversations by participant pubkey
- ✅ Hierarchical delegation chain tree output (depth-indented with `└─` connectors)
- ✅ Delegation chain nesting (child conversations nested under parent by `rustRuntime.delegation.parent_conversation_id`)

---

## 2. System Prompt Fragments

### 2.1 Missing Fragments
- [ ] **Fragment 00 — Global System Prompt**: user-configured global guidance from `config.json`
- [ ] **Fragment 05 — Delegation Chain**: multi-agent workflow hierarchy visualization for active turn
- [ ] **Fragment 18 — No-Response Guidance**: Telegram silent-completion mode instructions
- 🚫 **Fragment 20 — Voice Mode**: TTS-specific formatting guidance — won't port (voice mode is not implemented in the Rust stack)
- ✅ **Fragment 22 — Scheduled Tasks**: display agent's own scheduled tasks with human-readable cron expressions
- [ ] **Fragment 28 — Agent-Directed Monitoring**: guidance on monitoring delegated work and using `delegate_followup` for mid-flight corrections (spec references but is not implemented in Rust code)
- ✅ **Fragment 33 — Telegram Chat Context**: chat title, topic title, admin list, member count, recently seen participants (requires `TelegramChatContextService`)
- ✅ **Fragment 34 — Telegram Delivery Rules**: `[[telegram_voice:…]]` marker syntax documentation

### 2.2 Missing Dynamic Context Injection
- ✅ **Proactive RAG Context** — RAG search at score ≥ 0.65, up to 5 snippets injected into the system prompt each turn; LLM query planner (for messages > 20 words) and LLM reranker (when > 3 results pass threshold) implemented in `tenex-agent/src/context_discovery.rs`
- [ ] **Conversation Reminders** — active/recent conversation context overlay (streaming conversations, delegation parent refs, human-readable durations)
- [ ] **Effective Instructions (Lesson Synthesis)** — `PromptCompilerService` merges base instructions with lessons; Rust intentionally uses a different approach (`+INDEX.md` file), but LLM-synthesized multi-lesson synthesis is absent

### 2.3 Incomplete Fragments
- ✅ **Fragment 08 — Project Context**: Now renders project ID, owner pubkey, conversation ID, `$PROJECT_BASE`-relative workspace paths, and Telegram channel bindings (`<channels>` block) from `BindingStore`. Remaining gaps that cannot be implemented with current data:
  - ❌ **Worktree metadata** — no Rust git-worktree utility exists; `tenex-project` carries no worktree data
  - ❌ **Team-related channel bindings** — teams (`Team` struct) have no channel fields in the current data model
  - ❌ **Other project cross-references** — `ProjectMetadata` has no such field; not populated by the ingestion pipeline

---

## 3. Conversation Management

### 3.1 Compaction
- ✅ **LLM-driven compaction summaries**: `CompactionSummarizer` trait in `tenex-context` + `LlmCompactionSummarizer` impl in `tenex-agent` produce an 8-section summary (Task, Completed, Important Findings, Failures And Dead Ends, Tool Use And Side Effects, Open Issues, Next Steps, Persistent Facts) via the resolved model. Falls back to a deterministic placeholder if the LLM call fails.

### 3.2 Missing from Both (not a Rust gap specifically)
- ✅ Rust has equivalent CompactionToolStrategy, ToolResultDecayStrategy, RemindersStrategy (all at parity via `tenex-context`)

---

## 4. Supervision (`tenex-supervision`)

### 4.1 Missing Heuristics
- [ ] **SilentAgentHeuristic** (post-completion) — detects agents completing with no output, low token counts, or LLM error-fallback messages; requires `messageContent`, `outputTokens`, `usedErrorFallback` context fields
- 🚫 **DelegationClaimHeuristic** (post-completion) — won't port (requires LLM verification pass; high cost for marginal benefit)

### 4.2 Missing Context Fields
Pre-tool and post-completion contexts are missing fields that the two unimplemented heuristics require:
- [ ] `agentSlug` and `agentPubkey` in `PostCompletionContext` and `PreToolContext`
- [ ] `messageContent` — final text output from the agent turn
- [ ] `outputTokens` — LLM output token count for the turn
- [ ] `usedErrorFallback` — flag for LLM error-fallback messages
- [ ] `systemPrompt`, `conversationHistory`, `availableTools` (needed for LLM verification)
- [ ] `toolArgs` in `PreToolContext`

### 4.3 Missing LLM Verification Layer
- [ ] `SupervisorLLMService` — LLM-based verification of heuristic detections with structured response (`verdict: "ok" | "violation"`, `explanation`, `correctionMessage`); TypeScript heuristics can each supply a custom verification prompt

### 4.4 Correction Action Gaps
- [ ] `inject-message` correction action — inject a message without blocking execution (Rust only has binary `Accept`/`ReEngage`)
- [ ] `block-tool` correction action — block a specific tool call and require re-engagement
- [ ] `suppress-publish` correction action — suppress turn publication

### 4.5 Behavioral Differences
- ✅ `ConsecutiveToolsWithoutTodoHeuristic`: TypeScript sets `reEngage: false` (nudge only); Rust sets `re_engage: true` (actually re-engages the agent loop — different semantics)
- ✅ `WorkerTodoBeforeFileOrShellHeuristic`: TypeScript protects 11 tools (includes `home_read`, `home_write`, `home_edit`, `home_glob`, `home_grep`); Rust protects 6 tools

### 4.6 Missing Infrastructure
- 🚫 `HeuristicRegistry` singleton — won't port (Rust's static dispatch of known heuristics makes a runtime registry unnecessary)
- [ ] OpenTelemetry spans and events for supervision checks
- [ ] Per-execution state tracking (`SupervisionState` scoped to execution ID)

---

## 5. MCP Integration (`tenex-mcp`)

### 5.1 Missing MCP Resource Capabilities
- [ ] MCP resource discovery (`listResources()`, `listResourceTemplates()`)
- [ ] MCP resource fetch with URI template parameter expansion
- [ ] MCP resource subscription (persistent update notifications within a conversation)
- [ ] Notification handler management for resource updates
- [ ] Metadata caching with TTL for resources and templates (TypeScript uses 30s staleness)

### 5.2 MCP Server Lifecycle Differences
- 🚫 TypeScript defers server startup until first tool call (`ensureServersForTools()`) — won't fix (eager startup at manifest load is the intentional Rust design)
- 🚫 TypeScript supports dynamic tool cache refresh (`refreshToolCache()`) — won't fix (restart is acceptable; no live-reload requirement)
- 🚫 TypeScript supports `allowedPaths` security checks on filesystem-touching MCP servers — won't fix

---

## 6. RAG Integration (`tenex-rag`)

### 6.1 Search Capability Gaps
- 🚫 Free-form collection names in `rag_search` — won't port (Rust's fixed collection names are the intentional design)
- ✅ `prompt` parameter in `rag_search` — LLM-focused extraction from results
- [ ] Scope-aware search (global / project / personal) via `RAGCollectionRegistry`
- 🚫 Multiple specialized search providers (`ConversationSearchProvider`, `LessonSearchProvider`, `GenericCollectionSearchProvider`) — won't port
- 🚫 `UnifiedSearchService` — won't port (Rust `rag_search` is the single search surface; provider multiplexing not needed)
- ✅ `ContextDiscoveryService` — LLM query planner and LLM reranker implemented in `tenex-agent/src/context_discovery.rs`; pointer-only hint format and deferred background results not ported (direct snippet injection used instead)

### 6.2 RAG Subscription System (TypeScript-only)
- [ ] `RagSubscriptionService` — manages persistent subscriptions that pipe MCP resource updates into RAG collections; reconnects automatically on daemon startup; backed by `rag_subscriptions.json`

### 6.3 Embedding Provider Gaps
- 🚫 Local embedding models via ONNX Runtime (`LocalTransformerEmbeddingProvider` using Xenova models) — won't port (Rust requires an API endpoint; ONNX/Xenova is Node-specific)
- 🚫 Backward-compatible embedding config format (TypeScript infers provider from model name string) — won't port (Rust requires explicit provider field; no legacy config to support)
- [ ] Mock embedding provider for tests

---

## 7. Telegram Transport (`tenex-telegram`)

### 7.1 Missing Features
- ✅ **`TelegramChatContextService`** — enriches agent context with chat title, topic title, admin list, member count, and recently-seen participant list via Telegram Bot API; cached with ~5-minute TTL. Without this, agents have no visibility into group/topic metadata
- ✅ **System prompt fragments for Telegram** — Fragment 33 (chat context) and Fragment 34 (delivery rules) are not injected into the Rust agent system prompt (see §2.1)
- ✅ **`send_message` tool** — proactive messaging to bound channels (see §1.1)
- [ ] **Identity binding validation for DMs** — TypeScript checks `AuthorizedIdentityService` before accepting DMs; Rust accepts all DMs that pass the `allows_dms()` config flag
- ✅ **Persistent pending project selection** — `PendingSelectionStore` in `pending_selection_store.rs` persists pending channel-to-project selection state to `{base_dir}/data/pending-channel-selections.json` with 24-hour TTL; atomic writes via `.tmp` + rename; expired entries pruned on load and access

---

## 8. Runtime Orchestration / Dispatch

The Rust `tenex` runtime (`tenex/src/runtime_cmd/`) already implements core orchestration. Gaps below are TypeScript-specific in-process abstractions that have no direct Rust equivalent.

### 8.1 RAL State Management
- ✅ Multi-RAL concurrency per conversation — `DispatchCoordinator` with `driver_busy`/`queued: VecDeque` and `persisted_driver_busy` via SQLite
- ✅ `KillSwitchRegistry` — `kill_agent_conversation()` sends SIGTERM/SIGKILL to agent process groups
- ✅ `DelegationRegistry` — delegation routes tracked in SQLite (`register_delegation_route_if_needed`, `delegation_route_for_completion`)
- [ ] `MessageInjectionQueue` — bounded in-process message buffer (max 100 msgs) with role-aware queuing and event-ID-based deduplication; Rust uses VecDeque without the same bounds/deduplication
- [ ] `ExecutionTimingTracker` — LLM stream duration per RAL, accumulated runtime, unreported runtime
- [ ] `HeuristicViolationManager` — post-completion supervision violation tracking per RAL

### 8.2 Delegation Routing
- ✅ Delegation completion routing — `delegation_route_for_completion` routes child completions back to parent conversation/agent
- 🚫 Delegation completion debouncing (`DELEGATION_COMPLETION_DEBOUNCE_MS = 2500`) — won't port (process-per-project isolation in Rust makes in-process debouncing unnecessary)
- [ ] Deferred completions for nested delegation trees
- [ ] Delegation prefix resolution and canonicalization
- [ ] Implicit kill-wake path (synthetic envelopes for delegation kills)

### 8.3 Agent Config Update (kind:24020)
- 🚫 Won't port — already implemented as `tenex/src/runtime_cmd/agent_config_update.rs` with partial-update semantics (model, tool, skill, blocked-skill, mcp tags; full reset via `reset` tag)

### 8.4 Escalation (ask tool target)
- ✅ `EscalationService` — `crates/tenex-agent/src/escalation.rs` resolves the escalation agent slug from `config.escalation.agent` (project agents first, then global index fallback). `AskTool` routes through the escalation agent via `DelegationIntent` when a pubkey is resolved; falls back to owner ask on resolution failure.

---

## 9. LLM Layer

### 9.1 Provider SDK Implementations
Rust (`tenex-llm-config`) is a credential resolver only; all provider protocol work is TypeScript:
- [ ] Anthropic provider with OAuth token support (`sk-ant-oat*` tokens)
- [ ] OpenRouter provider with usage tracking and metadata extraction
- [ ] Ollama provider with vision model pattern detection
- 🚫 Codex agent provider with MCP server adapter (`CodexToolsAdapter`) — won't port (covered by ACP integration)
- 🚫 Claude Code agent provider with built-in tool routing — won't port (covered by ACP integration)

### 9.2 Request Pipeline
- [ ] **Message sanitizer middleware** — strips trailing assistant messages and empty-content messages before every API call to prevent provider rejections; Rust context projection has no equivalent validation
- ✅ **Multimodal preparation** — URL-fetch + base64 encoding of images from markdown `![](url)` and bare HTTPS URLs; images prepended to multipart user message for vision-capable providers (anthropic, openai, openrouter); Ollama vision model detection not ported (Ollama passes text only)
- ✅ **Prompt cache breakpoint emission** — `BreakpointHint` emitted when `cached_input_tokens > 0`; `cache_creation_input_tokens` recorded as `written_tokens` in `CacheObservation`

### 9.3 Instruction Synthesis
- [ ] **`PromptCompilerService`** — LLM-synthesized agent instructions: compiles base instructions + lessons + lesson comments into compiled instructions; persists scoped disk cache at `~/.tenex/agents/prompts/<project-dTag>/`; publishes updated kind:0 profile after compilation. Rust agents use static instructions only.

### 9.4 Dynamic Tool Loading
- 🚫 **`DynamicToolService`** — won't port (not implemented in TypeScript either; planned feature deferred from both stacks)

### 9.5 Tool Permission Enforcement
- [ ] Rust carries `only_tools`, `allow_tools`, `deny_tools` frontmatter fields in `SkillFrontmatter` but does **not enforce** them. TypeScript applies the three-tier hierarchy at runtime (only-tools replaces tool set; allow-tools unions; deny-tools subtracts). Enforcement must be added to Rust agent tool set construction.

---

## 10. Identity & Authorization (`tenex-identity`)

### 10.1 Principal Binding Store (TypeScript-only)
- [ ] `IdentityBindingStore` — maps transport principal IDs (e.g., `telegram:12345`) to Nostr pubkeys; persisted at `~/.tenex/data/identity-bindings.json`; not yet migrated to Rust daemons
- [ ] `AuthorizedIdentityService` — merges whitelisted principals, legacy whitelisted pubkeys, and per-agent DM allowlists; required by Rust daemons that need to gate on authorization (intervention, scheduler)

### 10.2 Cache TTL Mismatch
- 🚫 TypeScript `PubkeyService` uses 10-minute in-process TTL vs. `tenex-identity` daemon 24-hour SQLite TTL — won't port (24-hour TTL with background refresh is the intentional Rust design)

---

## 11. Intervention (`tenex-intervention`)

### 11.1 Delegation Check (Pending)
- ✅ Active-delegation check now queries the project's `conversation.db`: `ConversationStore::has_active_delegation` scans child conversations whose `runtime_state_json -> $.rustRuntime.delegation.parent_conversation_id` matches the completing conversation and have no completion record. The intervention timer is silently cleared when an active delegation is found.

---

## 12. Nostr / Protocol

### 12.1 NIP-46 Signer
- [ ] NIP-46 bunker support — TypeScript has a basic `Nip46SigningService` used in migration scripts; Rust has the `Signer` trait abstraction in `tenex-project` ready for a NIP-46 backend, but no implementation yet

---

## 13. APNs Push Notifications
- 🚫 `APNsService` — won't port (not implemented in either stack; out of scope for the Rust migration)

---

## Known Intentional Divergences (not gaps)

These are deliberate design differences, not missing features:

- **`learn` tool storage**: TypeScript stores lessons in a `lessons` RAG collection; Rust uses an LLM-maintained `+INDEX.md` file in the agent home directory.
- **`rag_add_documents` audience**: TypeScript accepts a free-form `collection` name; Rust enforces `"self"` or `"project"` and resolves the collection name internally.
- **Summarizer output**: TypeScript produces free-form 8-section prose; Rust (`tenex-summarizer`) produces a structured JSON object (`title`, `summary`, `status_label`, `status_current_activity`, `categories`).
- **Conversation store backend**: TypeScript uses JSON files for transcripts + SQLite for the catalog read model; Rust uses SQLite exclusively for both.
- **Runtime architecture**: TypeScript runs all projects in one Bun process; Rust spawns isolated per-project runtime processes (better fault isolation, deliberate trade-off).
- **Live agent reloading**: Rust runtime watches `agents/*.json` and reloads without restart; TypeScript daemon requires a full restart to pick up new agents (Rust advantage).
