---
title: Branch Cleanup and Rust Migration
slug: branch-cleanup-and-rust-migration
summary: The repository retains only the master branch after cleanup, with all other worktrees and branches removed
tags:
  - capture
volatility: warm
confidence: medium
created: 2026-05-01
updated: 2026-05-28
verified: 2026-05-01
compiled-from: conversation
sources:
  - session:ef718c1f-8ef0-4f58-bd04-f2ef2584461b
  - session:88ad7919-ca15-4330-84f5-e235bd9611a7
  - session:332f67f3-7c7c-488b-80d8-04195f06adf6
---

# Branch Cleanup and Rust Migration

## Branch Cleanup and Rust Migration

The repository retains only the master branch after cleanup, with all other worktrees and branches removed. All non-master branches were discarded without salvage because they targeted TypeScript code already removed from master in the Rust migration. Completed plan documents in docs/plans/ should be deleted rather than retained as historical artifacts.

The current system is a Rust crate workspace. The TypeScript application runtime (src/) has been removed, but scripts/*.ts probe/audit tooling still exists and runs under bun; docs referencing those scripts are correct, not stale. A keyword-only grep for 'typescript' under-counts stale docs; a comprehensive scan must also find src/*.ts path citations and ```ts code blocks without the word 'typescript'.

Docs commits are made on a separate branch (not directly to master) per the repo's safety rules, then merged via PR.

<!-- citations: [^ef718-1] [^88ad7-1] [^332f6-1] -->

## Top-Level Docs Rewritten for Rust

docs/ARCHITECTURE.md is rewritten to describe the Rust crate workspace instead of the removed TS monolith. README.md is updated to replace stale Node/Bun prerequisites, bun install, and src/ layout with actual tenex CLI commands and Rust reality. CLAUDE.md's stale TS sections (architecture, naming, imports, NDK, tools, summary) are rewritten for Rust, with language-agnostic principle blocks preserved verbatim. docs/CONTRIBUTING.md is fully rewritten for the Rust workflow (cargo check --workspace pre-commit hook, not bun install). [^332f6-2]

## Architecture and Internals Docs Rewritten for Rust

docs/system-prompt-architecture.md is rewritten: the old PromptCompilerService/Effective-Agent-Instructions model does not exist in Rust; the current system uses deterministic tenex-system-prompt assembly plus a LLM-maintained +INDEX.md. docs/CONVERSATION-ID-ARCHITECTURE.md is rewritten: there is no Catalog/Presenter split in Rust; the current system uses a single ConversationStore with per-consumer shortening. docs/SUPERVISION.md is rewritten for tenex-supervision heuristics; after MAX_STUCK_ITERATIONS=3 the system Accepts without a final correction. docs/CONTEXT-MANAGEMENT-AND-REMINDERS.md is rewritten: the Rust system uses a simpler deterministic 5-strategy projection pipeline in tenex-context, not the TS reminder engine's async queues/provider delta/full/skip/cache-anchor model. docs/CONVERSATION_INDEXING.md is rewritten: the embedder is a relay-walking daemon (tenex-embedder), not an in-runtime job; it reads Nostr relay events, not conversation.db. [^332f6-3]

## Surgical Corrections to Rust Reality

docs/internals/conversation-metadata-generation.md is surgically corrected: false present-tense claims that TS code is 'still relevant' or has 'remaining consumers' are removed; the summarizer now reads/writes conversation.db via ConversationStore, not JSON transcripts or conversation-catalog.db. The addendum is also corrected: Rust reads and writes conversation.db directly (not JSON through source.rs); the 'cutover not implemented' items are resolved. docs/RUST-AGENT-SPEC.md has its illustrative glob example updated from *.ts to *.rs for coherence as a Rust spec. MODULE_INVENTORY.md's embedder entry is corrected: the embedder reads Nostr relay events into a global store, not conversation.db into per-project stores; the stale source.rs/progress.rs module names are replaced with the actual scope/cursor/relay/accumulator modules. [^332f6-4]

## Intentionally Untouched Historical and Speculative Content

docs/internals/delegation-runtime.md and docs/DELEGATION-AND-RAL-PROCESSING.md are reframed as explicitly historical TS-runtime records with redirect banners, because the TS RAL model Rust uses is genuinely different and is documented in sibling Rust docs. docs/plans/*, docs/ideas/dreaming/*, MIGRATION_PENDING.md, tui-port/*, CHANGELOG.md, the AGENTS.md TypeScript Reference pointer, and labeled 'Differences From TypeScript' addenda are intentionally left untouched as correct historical/speculative content. [^332f6-5]
## See Also

