# `tenex doctor` — Diagnostic Output Spec

This document specifies the **exact** output, behavior, and exit codes of the
`tenex doctor` command tree, for pixel-exact reproduction in the Rust port.

The Rust port must NOT read any TypeScript source. All facts below cite their
source line directly so the porter can rely on this document alone.

---

## 1. Top-Level Structure

`tenex doctor` is **not** a single end-to-end health-check command. It is a
parent command that **only dispatches to subcommands** — invoking
`tenex doctor` with no subcommand prints commander's auto-generated help.

Source: `src/commands/doctor.ts:74-78`

```
doctor                      Diagnose and repair TENEX state
├── agents                  Agent diagnostics and repair
│   ├── refetch             Refetch and update all agent definitions from Nostr
│   ├── orphans [--purge]   List agents not assigned to any project
│   └── categorize [--dry-run]
│                           Auto-categorize agents that lack an explicit or inferred category
├── migrate                 Apply pending TENEX state migrations
└── conversations           Conversation indexing diagnostics and repair
    ├── status              Check conversation indexing status
    └── reindex [--confirm] Force full re-index of all conversations
```

Subcommand registration:

| Tree level | Source |
|------------|--------|
| `doctor` parent | `src/commands/doctor.ts:74-78` |
| `doctor agents` | `src/commands/doctor.ts:48-52` |
| `doctor agents refetch` | `src/commands/doctor.ts:17-19` |
| `doctor agents orphans` | `src/commands/doctor.ts:21-26` |
| `doctor agents categorize` | `src/commands/doctor.ts:28-46` |
| `doctor migrate` | `src/commands/doctor.ts:54-56` |
| `doctor conversations` | `src/commands/doctor.ts:69-72` |
| `doctor conversations status` | `src/commands/doctor.ts:58-60` |
| `doctor conversations reindex` | `src/commands/doctor.ts:62-67` |

Top-level command registered with the program at `src/index.ts:42`,
`src/index.ts:50`, and `src/index.ts:69`.

### 1.1 Run flow per subcommand

Each subcommand runs **its own sequence** end-to-end. There is **no parallel
fan-out** — every check inside a subcommand is sequential. The order is fixed
and matches the source order of `console.log` calls below.

There is also **no global `doctor` "run-all" flow**. The Rust port must not
invent one.

### 1.2 Verbosity flags

There are **no `--verbose` or `--quiet` flags** on any `doctor` subcommand.
Output volume is fixed. Source: full file `src/commands/doctor.ts:1-352` —
no `option('--verbose'`, `option('--quiet'`, or `option('-v'`.

The only options anywhere in the doctor tree are:

| Subcommand | Flag | Source |
|------------|------|--------|
| `doctor agents orphans` | `--purge` | `src/commands/doctor.ts:23` |
| `doctor agents categorize` | `--dry-run` | `src/commands/doctor.ts:30` |
| `doctor conversations reindex` | `--confirm` | `src/commands/doctor.ts:64` |

### 1.3 Color / glyph palette

All color comes from `chalk` (imported at `src/commands/doctor.ts:2`).

| Semantic | Chalk function | ANSI/role | Glyph used |
|----------|----------------|-----------|------------|
| Pass / success | `chalk.green` | green | `✓` (U+2713) |
| Warn | `chalk.yellow` | yellow | `⚠` (U+26A0) |
| Fail / error | `chalk.red` | red | `✗` (U+2717) |
| Section header / progress | `chalk.blue` | blue | (no glyph) |
| Section subheader | `chalk.bold` | bold | (no glyph) |
| Detail / dim line | `chalk.gray` | gray | (no glyph) |

The Rust port should map:
- `chalk.green` → ANSI 32 (or `crossterm::Color::Green`)
- `chalk.yellow` → ANSI 33
- `chalk.red` → ANSI 31
- `chalk.blue` → ANSI 34
- `chalk.gray` → ANSI 90 (bright black)
- `chalk.bold` → SGR 1

There is **no indentation tree, no horizontal section divider, no banner**.
Items inside a section are prefixed with two spaces (`"  "`) — see
`src/commands/doctor.ts:109,138,141,173,181,208,268-279,285-291`.

---

## 2. `tenex doctor agents refetch`

Function: `repairAgents()` at `src/commands/doctor.ts:89-150`.

### 2.1 Run flow (sequential)

1. `agentStorage.initialize()` — `src/commands/doctor.ts:90`
2. `initNDK()` — `src/commands/doctor.ts:91`
3. Load all stored agents — `src/commands/doctor.ts:94`
4. Filter to agents with an `eventId` — `src/commands/doctor.ts:95`
5. Print header, then iterate **sequentially** (one `await ndk.fetchEvent` per
   agent — `src/commands/doctor.ts:103-143`)
6. Print summary — `src/commands/doctor.ts:145-149`

### 2.2 Per-agent check spec

| Field | Value |
|-------|-------|
| Header (verbatim) | `Checking <N> Nostr agent(s)...` |
| Header color | `chalk.blue` |
| Header source | `src/commands/doctor.ts:98` |
| Inspects | Nostr relays — fetches `agent.eventId` via `ndk.fetchEvent(id, { groupable: false })` (`src/commands/doctor.ts:107`) |
| Pass criteria | Event found AND no fields differ between stored and fetched (`agentChanged` returns `false`) — `src/commands/doctor.ts:80-87,140-142` |
| "Updated" criteria | Event found AND any of `name`, `role`, `description`, `instructions`, `useCriteria` differs — `src/commands/doctor.ts:80-87,136-139` |
| Fail criteria | `ndk.fetchEvent` returns null — `src/commands/doctor.ts:108-112` |
| Pass message | `chalk.gray("  <slug> (<pubkey8>...): ok") + chalk.gray("  [tools: <toolsDisplay>]")` — `src/commands/doctor.ts:141` |
| Updated message | `chalk.green("  ✓ <slug> (<pubkey8>...): updated") + chalk.gray("  [tools: <toolsDisplay>]")` — `src/commands/doctor.ts:138` |
| Fail message | `chalk.yellow("  ⚠ <slug> (<pubkey8>...): event not found on relays, skipping")` — `src/commands/doctor.ts:109` |
| Suggested fix | None — failure just increments counter |

`<pubkey8>` = first 8 hex chars of the agent pubkey (`pubkey.substring(0, 8)`)
— `src/commands/doctor.ts:105`.

`<toolsDisplay>` = `toolTags.join(", ")` if `toolTags.length > 0`, else
`"(none)"` — `src/commands/doctor.ts:133`.

`agentChanged` field set: `name`, `role`, `description`, `instructions`,
`useCriteria` only — `tools` differences alone do **not** count as changed —
`src/commands/doctor.ts:80-87`.

### 2.3 Summary line

```
\nDone: <updated> updated, <skipped> skipped (no eventId), <failed> failed
```

- Color: `chalk.blue`
- Note the **leading `\n`** — produces a blank line before the summary.
- `<skipped>` = total agents minus those with eventId (`src/commands/doctor.ts:96`).
- Source: `src/commands/doctor.ts:145-149`.

### 2.4 Exit code

Always `0`. The function does not call `process.exit` and does not throw on
fail counts. Failures are counted but tolerated.
Source: `src/commands/doctor.ts:89-150` (no `process.exit` in body).

---

## 3. `tenex doctor agents orphans [--purge]`

Function: `findOrphanedAgents(purge)` at `src/commands/doctor.ts:152-184`.

### 3.1 Run flow (sequential)

1. `agentStorage.initialize()` — `src/commands/doctor.ts:153`
2. Load all stored agents — `src/commands/doctor.ts:154`
3. For each agent, call `agentStorage.getAgentProjects(pubkey)`; if empty,
   collect as orphan — `src/commands/doctor.ts:156-163`
4. Print result — `src/commands/doctor.ts:165-174`
5. If `--purge`, delete each orphan sequentially — `src/commands/doctor.ts:176-183`

### 3.2 Output spec

| Condition | Message (verbatim) | Color | Source |
|-----------|--------------------|-------|--------|
| `orphans.length === 0` | `No orphaned agents found.` | `chalk.green` | `src/commands/doctor.ts:166` |
| Orphans exist (header) | `Found <N> orphaned agent(s):` | `chalk.yellow` | `src/commands/doctor.ts:170` |
| Per-orphan line | `  <slug> (<pubkey8>...)  [<source>]` | `chalk.gray` | `src/commands/doctor.ts:173` |
| Purge header | `\nPurging <N> orphaned agent(s)...` | `chalk.blue` | `src/commands/doctor.ts:178` |
| Per-purge line | `  ✓ deleted <slug>` | `chalk.green` | `src/commands/doctor.ts:181` |
| Purge summary | `Done: <N> deleted` | `chalk.blue` | `src/commands/doctor.ts:183` |

`<source>` is `nostr:<shortenEventId(eventId)>` if the agent has an `eventId`,
otherwise `local` — `src/commands/doctor.ts:172`.

Notice the **double space** between `(<pubkey8>...)` and `[<source>]` on the
per-orphan line — this is verbatim in source `src/commands/doctor.ts:173`.

### 3.3 Exit code

Always `0`. No `process.exit` is called.
Source: `src/commands/doctor.ts:152-184`.

---

## 4. `tenex doctor agents categorize [--dry-run]`

Inline action handler at `src/commands/doctor.ts:31-46`.

### 4.1 Run flow

Single call to `backfillAgentCategories(agentStorage, { dryRun })` —
`src/commands/doctor.ts:33`. The check is opaque from this command's
perspective; only the returned counters are rendered.

### 4.2 Output spec

| Condition | Message (verbatim) | Color | Stream | Source |
|-----------|--------------------|-------|--------|--------|
| Always (after run) | `Processed: <p>, Categorized: <c>, Skipped: <s>, Failed: <f>` | `chalk.blue` | stdout | `src/commands/doctor.ts:35` |
| `result.failed > 0` | `<f> agent(s) failed categorization — check logs for details` | `chalk.red` | **stderr** | `src/commands/doctor.ts:38` |
| Caught exception | `Failed to categorize agents: <message>` | `chalk.red` | **stderr** | `src/commands/doctor.ts:43` |

Note the em-dash (`—`, U+2014) in the failure message at line 38.

### 4.3 Exit code

| Outcome | Code | Source |
|---------|------|--------|
| `result.failed === 0` and no exception | `0` | implicit |
| `result.failed > 0` | `1` | `src/commands/doctor.ts:39` |
| Exception thrown | `1` | `src/commands/doctor.ts:44` |

---

## 5. `tenex doctor migrate`

Function: `runMigrations()` at `src/commands/doctor.ts:186-218`.

### 5.1 Run flow

1. `migrationService.migrate()` — single call, blocking — `src/commands/doctor.ts:187`
2. Print version line — `src/commands/doctor.ts:189-193`
3. If no migrations applied: print "No pending" line and return —
   `src/commands/doctor.ts:195-198`
4. Else loop applied migrations sequentially — `src/commands/doctor.ts:200-215`
5. Print final-version footer — `src/commands/doctor.ts:217`

### 5.2 Output spec

| Position | Message (verbatim) | Color | Source |
|----------|--------------------|-------|--------|
| Header | `Current migration version: <currentVersion> (latest: <latestVersion>)` | `chalk.blue` | `src/commands/doctor.ts:191` |
| No-op | `No pending migrations.` | `chalk.green` | `src/commands/doctor.ts:196` |
| Applied entry — line 1 | `Applied migration <from> -> <to>: <description>` | `chalk.green` | `src/commands/doctor.ts:202-204` |
| Applied entry — line 2 | `  migrated=<migratedCount> skipped=<skippedCount>` | `chalk.gray` | `src/commands/doctor.ts:207-209` |
| Per warning | `  warning: <warning>` | `chalk.yellow` | `src/commands/doctor.ts:213` |
| Footer | `Final migration version: <finalVersion>` | `chalk.blue` | `src/commands/doctor.ts:217` |

The `<from> -> <to>` arrow is **ASCII** ` -> ` (hyphen + greater-than),
**not** `→`. Source: `src/commands/doctor.ts:203`.

### 5.3 Exit code

Always `0`. No `process.exit`. Exceptions from `migrationService.migrate()`
propagate up to the global handler in `src/index.ts:79-91`.
Source: `src/commands/doctor.ts:186-218`.

---

## 6. `tenex doctor conversations status`

Function: `checkConversationIndexingStatus()` at `src/commands/doctor.ts:252-308`.

### 6.1 Run flow (sequential)

1. Header (always printed before any work) — `src/commands/doctor.ts:256`
2. `conversationEmbeddingService.initialize()` — `src/commands/doctor.ts:259`
3. `hasIndexedConversations()` — `src/commands/doctor.ts:261`
4. `RAGService.getInstance().getCollectionStats("conversation_embeddings")` — `src/commands/doctor.ts:262-263`
5. `indexingJob.getStatus()` — `src/commands/doctor.ts:264`
6. `getEmbeddingInfo()` — `src/commands/doctor.ts:265`
7. Render four labelled sections in fixed order — see below
8. `getContentVersionBreakdown()` — `src/commands/doctor.ts:281` (walks every
   project's catalog on disk; sequential)
9. Final pass / warn line — `src/commands/doctor.ts:298-302`

### 6.2 Output spec — verbatim, in source order

```
<chalk.blue>Checking conversation indexing status...\n</>          ← line 256

<chalk.bold>RAG Collection:</>                                      ← line 267
<chalk.gray>  Collection: conversation_embeddings</>                ← line 268
<chalk.gray>  Total indexed: <stats.totalCount></>                  ← line 269
<chalk.gray>  Has content: <yes|no></>                              ← line 270
<chalk.gray>  Embedding provider: <embeddingInfo></>                ← line 271

<chalk.bold>\nIndexing Job:</>                                      ← line 273
<chalk.gray>  Running: <yes|no></>                                  ← line 274
<chalk.gray>  Batch in progress: <yes|no></>                        ← line 275
<chalk.gray>  Interval: <intervalMs/60000> minutes</>               ← line 276

<chalk.bold>\nIndexing State:</>                                    ← line 278
<chalk.gray>  Tracked conversations: <stateStats.totalEntries></>   ← line 279

# Optional — only if versionBreakdown.total > 0  (line 282)
<chalk.bold>\nContent Versions:</>                                  ← line 283
[if v2 > 0]   <chalk.gray>  v2 (full transcript): <v2></>           ← line 285
[if v1 > 0]   <chalk.yellow>  v1 (metadata only): <v1></>           ← line 288
[if unknown>0]<chalk.gray>  unknown/legacy: <unknown></>            ← line 291
[if v1 > 0]   <chalk.yellow>\n  ⚠ <v1> conversation(s) using old format. Run 'reindex' to upgrade to v2.</>
                                                                    ← line 294

# Final status line — exactly one of:
[!hasIndexed] <chalk.yellow>\n⚠ No conversations indexed yet. Run 'tenex doctor conversations reindex' to backfill.</>
                                                                    ← line 299
[hasIndexed]  <chalk.green>\n✓ Conversation indexing is active</>   ← line 301
```

The leading `\n` on certain strings is verbatim and produces a blank line
above that line.

`<yes|no>` is the literal string `"yes"` or `"no"` (lower-case) —
`src/commands/doctor.ts:270,274,275`.

`<intervalMs/60000>` is JavaScript's `Number.prototype.toString` of a float —
e.g., `2`, `2.5`, `0.5`. Do **not** force formatting.

### 6.3 Pass / warn / fail rules (logical)

| Check | Pass | Warn | Fail |
|-------|------|------|------|
| Embedding service init | (silent) | — | Throws → caught at line 303 |
| Has indexed conversations | `hasIndexed === true` (`✓` line) | `hasIndexed === false` (`⚠` line) | — |
| Content version v1 count | `v1 === 0` | `v1 > 0` (yellow lines + final yellow `⚠` advisory) | — |

### 6.4 Catch-all error

```
<chalk.red>\n✗ Error checking status: <message></>
```
Source: `src/commands/doctor.ts:305`. Then `process.exit(1)` —
`src/commands/doctor.ts:306`.

### 6.5 Exit code

| Outcome | Code |
|---------|------|
| Any uncaught error inside try block | `1` (`src/commands/doctor.ts:306`) |
| Otherwise (including the warn-paths) | `0` |

The yellow warn line at line 299 does **not** set a non-zero exit code.

---

## 7. `tenex doctor conversations reindex [--confirm]`

Function: `reindexConversations(skipConfirm)` at `src/commands/doctor.ts:310-351`.

### 7.1 Confirmation flow (when `--confirm` is **not** passed)

Source: `src/commands/doctor.ts:311-331`.

```
<chalk.yellow>This will clear all conversation indexing state and re-index all conversations.</>      ← line 312
<chalk.yellow>This may take several minutes depending on the number of conversations.\n</>           ← line 313
<chalk.gray>Run with --confirm to skip this prompt.\n</>                                              ← line 314
<chalk.blue>Continue? (yes/no): </>                                                                   ← line 323 (readline prompt)
```

Accepted affirmative answers (case-insensitive): `"yes"`, `"y"` —
`src/commands/doctor.ts:327`.

If the user answers anything else:

```
<chalk.gray>Cancelled.</>                                                                             ← line 328
```
Function returns; exit code `0`.

### 7.2 Re-index execution

After confirmation (or if `--confirm` was passed):

```
<chalk.blue>\nStarting full conversation re-index...\n</>                                             ← line 335
```

Then `indexingJob.forceFullReindex()` runs once, sequentially (single
blocking await) — `src/commands/doctor.ts:340`.

### 7.3 Result lines

| Outcome | Message (verbatim) | Color | Source |
|---------|--------------------|-------|--------|
| Success | `\n✓ Re-index complete in <secs>s` | `chalk.green` | `src/commands/doctor.ts:344` |
| Success follow-up | `Run 'tenex doctor conversations status' to verify.` | `chalk.gray` | `src/commands/doctor.ts:345` |
| Failure | `\n✗ Re-index failed: <message>` | `chalk.red` | `src/commands/doctor.ts:348` |

`<secs>` formatting: `((Date.now() - startTime) / 1000).toFixed(1)` — always
exactly **one** decimal place. Source: `src/commands/doctor.ts:342`.

### 7.4 Exit code

| Outcome | Code |
|---------|------|
| Confirmation declined | `0` (just returns — `src/commands/doctor.ts:329-330`) |
| Re-index throws | `1` (`src/commands/doctor.ts:349`) |
| Re-index succeeds | `0` |

---

## 8. End-of-run summary lines (cross-reference)

| Subcommand | Summary line | Color | Source |
|------------|--------------|-------|--------|
| `agents refetch` | `\nDone: <u> updated, <s> skipped (no eventId), <f> failed` | `chalk.blue` | `src/commands/doctor.ts:147` |
| `agents orphans` (no purge) | (per-orphan list ends; no extra summary) | — | — |
| `agents orphans --purge` | `Done: <n> deleted` | `chalk.blue` | `src/commands/doctor.ts:183` |
| `agents categorize` | `Processed: <p>, Categorized: <c>, Skipped: <s>, Failed: <f>` | `chalk.blue` | `src/commands/doctor.ts:35` |
| `migrate` (no pending) | `No pending migrations.` | `chalk.green` | `src/commands/doctor.ts:196` |
| `migrate` (applied) | `Final migration version: <v>` | `chalk.blue` | `src/commands/doctor.ts:217` |
| `conversations status` (ok) | `\n✓ Conversation indexing is active` | `chalk.green` | `src/commands/doctor.ts:301` |
| `conversations status` (no data) | `\n⚠ No conversations indexed yet. Run 'tenex doctor conversations reindex' to backfill.` | `chalk.yellow` | `src/commands/doctor.ts:299` |
| `conversations reindex` (ok) | `\n✓ Re-index complete in <s>s` | `chalk.green` | `src/commands/doctor.ts:344` |
| `conversations reindex` (fail) | `\n✗ Re-index failed: <message>` | `chalk.red` | `src/commands/doctor.ts:348` |

---

## 9. Exit-code matrix

| Subcommand | Exit 0 | Exit 1 |
|------------|--------|--------|
| `agents refetch` | always (failures counted, not exited) | (only via uncaught throw bubbling to global handler) |
| `agents orphans [--purge]` | always | (only via uncaught throw) |
| `agents categorize [--dry-run]` | `result.failed === 0` and no exception | `result.failed > 0` (`src/commands/doctor.ts:39`) **or** caught exception (`src/commands/doctor.ts:44`) |
| `migrate` | always | (only via uncaught throw) |
| `conversations status` | success path | caught exception in try block (`src/commands/doctor.ts:306`) |
| `conversations reindex [--confirm]` | confirmation declined OR success | caught exception during reindex (`src/commands/doctor.ts:349`) |

The CLI also defines `program.exitOverride()` (`src/index.ts:73`); successful
returns finally hit `process.exit(0)` at `src/index.ts:96`.

---

## 10. What this command does **not** do

These would be reasonable health-check features in similar CLIs but are
**absent** from `tenex doctor`. Do not invent them in the Rust port:

- No relay reachability ping.
- No identity / nsec validity check.
- No LLM provider key check.
- No filesystem permission check.
- No version self-check against npm.
- No JSON / `--json` output mode.
- No `--verbose` or `--quiet`.
- No `doctor` aggregate run.
- No section divider lines (no `---`, no boxes).
- No emoji other than the three glyphs `✓`, `✗`, `⚠`.

Source for the absence claims: full read of `src/commands/doctor.ts:1-352`
(only file in the doctor scope; confirmed via
`find src/commands -iname "*doctor*"`).

---

## 11. Helper functions used (for porter context only)

These are dependencies of the doctor command and live outside scope. The
porter only needs to know they return the data shapes referenced above.

| Symbol | Source import | Purpose |
|--------|---------------|---------|
| `agentStorage` | `@/agents/AgentStorage` | `initialize()`, `getAllStoredAgents()`, `saveAgent()`, `deleteAgent()`, `getAgentProjects(pubkey)` (`src/commands/doctor.ts:3`) |
| `backfillAgentCategories` | `@/agents/backfillAgentCategories` | Returns `{ processed, categorized, skipped, failed }` (`src/commands/doctor.ts:4`) |
| `NDKAgentDefinition` | `@/events/NDKAgentDefinition` | `.from(event)` → `{ title, role, description, instructions, useCriteria }` (`src/commands/doctor.ts:5`) |
| `initNDK`, `getNDK` | `@/nostr/ndkClient` | NDK bootstrap + handle (`src/commands/doctor.ts:6`) |
| `migrationService` | `@/services/migrations` | `.migrate()` → `{ currentVersion, latestVersion, finalVersion, applied[] }` (`src/commands/doctor.ts:7`) |
| `shortenEventId` | `@/utils/conversation-id` | Truncate event id for display (`src/commands/doctor.ts:8`) |
| `NDKPrivateKeySigner` | `@nostr-dev-kit/ndk` | `.pubkey` from nsec (`src/commands/doctor.ts:9`) |
| `getConversationIndexingJob` | `@/conversations/search/embeddings` | `.getStatus()`, `.forceFullReindex()` (`src/commands/doctor.ts:10`) |
| `getConversationEmbeddingService` | `@/conversations/search/embeddings` | `.initialize()`, `.hasIndexedConversations()`, `.getEmbeddingInfo()` (`src/commands/doctor.ts:10`) |
| `RAGService` | `@/services/rag/RAGService` | `.getInstance().getCollectionStats(name)` → `{ totalCount }` (`src/commands/doctor.ts:11`) |
| `ConversationCatalogService` | `@/conversations/ConversationCatalogService` | `.getInstance(projectId, dir).getEmbeddingState(id)` → `{ contentVersion: 'v1'|'v2'|... }` (`src/commands/doctor.ts:12`) |
| `listProjectIdsFromDisk`, `listConversationIdsFromDiskForProject` | `@/conversations/ConversationDiskReader` | Disk walkers used in version breakdown (`src/commands/doctor.ts:13`) |
| `getTenexBasePath` | `@/constants` | TENEX root (`src/commands/doctor.ts:14`) |
