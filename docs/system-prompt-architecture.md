# TENEX System Prompt Construction: Architecture and Synthesis

This report provides a comprehensive technical overview of how TENEX constructs and synthesizes system prompts for its AI agents. The system follows a modular "Prompt Fragment" architecture that allows for dynamic, context-aware, and highly specialized agent behavior.

## 1. Fragment Architecture

TENEX uses a registry-based system to manage pieces of the system prompt. This allows the system to assemble complex instructions from smaller, reusable, and testable components.

### Core Data Structures (`src/prompts/core/types.ts`)
- **`PromptFragment<T>`**: The atomic unit of the prompt system.
  - `id`: Unique identifier (e.g., `"agent-identity"`).
  - `priority`: Numeric value determining where the fragment appears (lower numbers appear earlier).
  - `template`: A function that takes typed arguments and returns the prompt string.
- **`FragmentConfig`**: A configuration object specifying which fragment to use, what arguments to pass, and an optional condition for rendering.

### The Registry and Builder
- **`FragmentRegistry`**: A singleton class that holds all available fragments. Fragments are registered at startup in `/src/prompts/fragments/index.ts`.
- **`PromptBuilder`**: The engine that assembles the final prompt. It collects fragments, filters them based on conditions, sorts them by priority, and executes their templates.

## 2. The Synthesis Process

The final system prompt is not a static string but a synthesized document.

1.  **Registration**: On initialization, all files in `src/prompts/fragments/` register themselves with the `fragmentRegistry`.
2.  **Configuration**: The `buildSystemPrompt` utility defines a list of `FragmentConfig` objects needed for a standard agent.
3.  **Context Gathering**: The system prepares a `BuildContext`, containing:
    *   The specialized `AgentInstance` (name, role, instructions).
    *   Project metadata (paths, timestamps, user pubkeys).
    *   Dynamic data (active todos, retrieved lessons, available team members, current git worktrees).
4.  **Assembly**: The `PromptBuilder` iterates through the configurations:
    *   It checks the `condition` (e.g., only include "Voice Mode" if the user is using voice).
    *   It retrieves the template from the registry.
    *   It applies the arguments from the context.
5.  **Ordering**: Fragments are joined with double newlines, ordered strictly by their `priority` property.

## 3. Core Components of a Final System Prompt

A TENEX system prompt is composed of the following functional layers (ordered by standard priority):

### I. Identity and Environment (Priority 1-5)
- **Agent Identity (01)**: Establishes the agent's name, role, specific instructions, and NSEC for tool usage.
- **Home Directory (02)**: Injects the absolute path to the agent's private workspace.

### II. Task Management (Priority 6-10)
- **Todos (06)**: Lists pending, in-progress, and done items for the current session.
- **Todo Guidance (06)**: Instructs the agent on how to use `todo_write` to maintain state.
- **Referenced Article (10)**: If a specific spec or file is the subject of the conversation, its content is injected here.

### III. System Awareness (Priority 11-20)
- **Nudges (11)**: Behavioral guidance (e.g., "Don't be lazy," "Show your thinking").
- **Available Agents (15)**: Lists all other agents in the project, their roles, and `useCriteria` to enable effective delegation.
- **Voice Mode (20)**: Guidelines for TTS-friendly responses (natural language, no markdown tables, etc.).

### IV. Dynamic Knowledge (Priority 22-27)
- **Scheduled Tasks (22)**: Lists any recurring tasks assigned to the agent.
- **Retrieved Lessons (24)**: Injects relevant "Lessons Learned" retrieved via vector search based on the current context.
- **RAG Instructions (25)**: Comprehensive documentation on how to use the RAG (Retrieval-Augmented Generation) tools.
- **MCP Resources (26)**: Lists available Model Context Protocol resources.
- **Memorized Reports (27)**: Injects relevant NDKArticle reports published by other agents.

### V. Operational Context (Priority 30-95)
- **Git Worktree Context (30)**: Informs the agent about the current branch and the structure of `.worktrees/`.
- **Delegation Completion (95)**: A special fragment added when an agent "wakes up" after a delegated task finishes, providing a summary of the results.

## 4. Key Fragment Details

| Fragment ID | File | Priority | Role |
| :--- | :--- | :--- | :--- |
| `agent-identity` | `01-agent-identity.ts` | 1 | The "Soul" - defines WHO the agent is. |
| `available-agents`| `15-available-agents.ts` | 15 | The "Team" - defines WHO they can ask for help. |
| `rag-instructions`| `25-rag-instructions.ts` | 25 | The "Library" - how to use external knowledge. |
| `worktree-context`| `30-worktree-context.ts` | 30 | The "Map" - where they are in the filesystem. |

## 5. Summary of priority-based ordering

The priority system ensures that the most fundamental information (Identity) is always at the top "Top-of-Mind", while transient operational updates (Delegation Status) or detailed tool manuals (RAG) appear later to avoid drowning out the agent's core mission.

- **0-10**: Core Identity & Task State
- **11-20**: Social Context (Team) & Interface Guidelines
- **21-30**: Knowledge Tools & Filesystem Context
- **90+**: Reactive state updates (e.g. "Your delegated task just finished")

---
*This report was synthesized by the HR Agent based on a deep-dive into the `/src/prompts` subsystem.*
