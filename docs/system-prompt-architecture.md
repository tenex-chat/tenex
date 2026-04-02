# TENEX System Prompt Construction

This document describes the current system prompt architecture in TENEX. The key distinction is that lesson handling is no longer part of prompt assembly. Lessons and lesson comments are compiled ahead of time into each agent's Effective Agent Instructions, and the prompt builder only reads that compiled result.

## 1. High-Level Flow

1. `ProjectRuntime.start()` creates a `ProjectContext` and a project-scoped `PromptCompilerRegistryService`.
2. The registry registers every agent in that runtime and creates one `PromptCompilerService` per agent.
3. Lesson and lesson-comment events are stored in `ProjectContext`.
4. `ProjectContext` synchronizes the affected agent's lesson/comment snapshot into the registry.
5. The per-agent compiler recompiles Effective Agent Instructions in the background.
6. `buildSystemPromptMessages()` reads those compiled instructions synchronously and builds the rest of the prompt around them.

The runtime never blocks an agent turn on compilation. If a recompile is in progress, TENEX serves the last good compiled instructions. If nothing has ever compiled yet, TENEX falls back to the base `agent.instructions`.

## 2. Ownership Boundaries

### Runtime-owned compilation
- **`src/daemon/ProjectRuntime.ts`** owns compiler lifecycle.
- **`src/services/prompt-compiler/PromptCompilerRegistryService.ts`** is the project-scoped coordinator.
- **`src/services/prompt-compiler/prompt-compiler-service.ts`** is the per-agent worker that performs LLM synthesis, debouncing, disk caching, and kind:0 publishing.
- **`src/services/projects/ProjectContext.ts`** is the source of truth for lessons and lesson comments and triggers registry synchronization after mutations.

### Read-only prompt assembly
- **`src/prompts/utils/systemPromptBuilder.ts`** does not construct prompt compilers, subscribe to lesson comments, or append raw lessons/comments.
- It only resolves Effective Agent Instructions from `ProjectContext.promptCompilerRegistry` and injects them into the normal fragment pipeline by replacing `agent.instructions` for fragment rendering.

## 3. Effective Agent Instructions

The Effective Agent Instructions are the compiled instruction set used by the agent at runtime. They contain only:

- Base Agent Instructions from `agent.instructions`
- Agent lessons
- Lesson comments

Project context, tools, skills, MCP resources, worktree state, and the rest of the normal system prompt are still added later as prompt fragments. They are not part of the lesson compilation step.

## 4. Prompt Builder Composition

After resolving Effective Agent Instructions, the prompt builder assembles the normal fragment stack:

- Agent identity and home directory
- System-reminder explanation
- Global system prompt
- Environment and transport context
- Meta-project and conversation context
- Skills
- Worktree and AGENTS.md guidance
- Core runtime fragments such as scheduled tasks, MCP resources, RAG collection stats, and memorized reports
- Agent-specific fragments such as available agents and delegation guidance

The old "retrieved lessons" fallback path is not part of normal prompt construction anymore. Lessons influence behavior through compiled instructions, not raw fragment injection.

## 5. Cache and Freshness Model

`PromptCompilerService` keeps a last-good compiled cache both in memory and on disk. Freshness is determined by:

- the latest `created_at` across synchronized lessons and lesson comments
- the current base instructions and agent definition event ID

When those inputs change:

- background recompilation is triggered
- stale compiled instructions remain usable until the new compile completes
- base instructions are used only if no compiled result exists yet

## 6. Event Ingestion

Lesson and lesson-comment ingestion happens outside the compiler:

- **`src/daemon/Daemon.ts`** hydrates incoming lesson and lesson-comment events into active runtimes
- **`src/event-handler/index.ts`** stores runtime-local lesson events in `ProjectContext`

The compiler does not own NDK subscriptions, EOSE coordination, or comment-event parsing.

## 7. Design Intent

This split keeps the lesson system adaptive without putting compiler lifecycle, cache management, and event-ingestion logic on the prompt hot path:

- lesson/comment event arrives
- runtime updates project state
- runtime-owned compiler recompiles in background
- future prompts read compiled instructions synchronously
