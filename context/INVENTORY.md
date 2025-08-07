# TENEX Project Inventory

## 1. Project Overview

**Description:** TENEX is a command-line interface (CLI) application that provides a suite of tools for developers. It appears to be extensible, with a system of agents that can be managed and interacted with. The CLI also includes features for debugging, project setup, and interacting with the Nostr protocol.

**Technologies:**
- **Language:** TypeScript
- **Runtime:** Bun
- **Key Libraries:**
    - `commander`: For creating the command-line interface.
    - `@nostr-dev-kit/ndk`: For Nostr protocol integration.
    - `multi-llm-ts`: Suggests integration with multiple Large Language Models (LLMs).
    - `zod`: For data validation.

**Architecture:** The project follows a modular, command-based architecture. Each command is defined in its own module, and the main `tenex.ts` file acts as the entry point that registers all the commands. There is a clear separation of concerns, with distinct modules for agents, commands, services, and utilities.

## 2. Directory Structure

- **`src/`**: The main source code directory.
    - **`agents/`**: Contains the logic for different agents that can be used within the TENEX CLI. This is likely where the core business logic of the application resides.
    - **`claude/`**: Specific integrations with Claude models.
    - **`commands/`**: Defines the commands available in the CLI (e.g., `agent`, `daemon`, `project`).
    - **`conversations/`**: Manages the state and flow of conversations with agents.
    - **`daemon/`**: Likely contains code related to running TENEX as a background process.
    - **`event-handler/`**: Handles various events within the application.
    - **`events/`**: Defines different event types.
    - **`lib/`**: Contains utility libraries, such as file system and shell helpers.
        - **`fs/`**: Provides file system utilities, including a custom file system implementation.
        - **`shell.ts`**: Offers shell command execution functionality.
    - **`llm/`**: Manages interactions with Large Language Models (LLMs).
    - **`logging/`**: Provides logging functionality.
        - **`ExecutionLogger.ts`**: A specific logger for tracking agent execution.
    - **`nostr/`**: Handles integration with the Nostr protocol.
    - **`prompts/`**: Stores and builds prompts for interacting with LLMs.
        - **`core/`**: Core components for building prompts, including a `PromptBuilder` and a `FragmentRegistry`.
        - **`fragments/`**: A collection of prompt fragments that can be reused across different prompts.
        - **`utils/`**: Utilities for working with prompts, such as a `messageBuilder` and a `systemPromptBuilder`.
    - **`services/`**: Contains services that provide specific functionalities.
        - **`ConfigService.ts`**: Manages the application's configuration.
        - **`mcp/`**: Contains services related to the Model Context Protocol (MCP).
        - **`ProjectContext.ts`**: Manages the context of the current project.
    - **`test-utils/`**: Provides utilities for testing.
    - **`tools/`**: Defines tools that can be used by agents.
        - **`core.ts`**: Core functionality for defining and executing tools.
        - **`implementations/`**: The actual implementations of the tools, such as `analyze`, `complete`, `shell`, and `writeContextFile`.
        - **`registry.ts`**: A registry for all available tools.
    - **`tracing/`**: Implements tracing for monitoring and debugging.
    - **`utils/`**: Contains miscellaneous utility functions.
        - **`agentFetcher.ts`**: Fetches agent definitions.
        - **`conversationFetcher.ts`**: Fetches conversation data.
        - **`error-handler.ts`**: Provides centralized error handling.
        - **`git/`**: Git-related utilities.
        - **`inventory.ts`**: Utilities for generating project inventories.
- **`tests/`**: Contains end-to-end tests.

## 3. Significant Files

- **`src/tenex.ts`**: The main entry point of the CLI application. It initializes the `commander` program and registers all the available commands.
- **`package.json`**: Defines project metadata, dependencies, and scripts.
- **`src/agents/AgentRegistry.ts`**: Manages the registration and publishing of agents.
- **`src/commands/agent/index.ts`**: The entry point for the `agent` command and its subcommands.
- **`src/llm/router.ts`**: Likely responsible for routing requests to different LLMs.
- **`src/nostr/ndkClient.ts`**: Initializes and configures the Nostr client.

## 4. Architectural Insights

- **Command-Based Architecture:** The application is structured around a set of commands, each with a specific responsibility. This makes the CLI easy to extend and maintain.
- **Agent-Based System:** The concept of "agents" is central to the application. These agents appear to be autonomous or semi-autonomous entities that can perform tasks.
- **LLM Integration:** The use of `multi-llm-ts` suggests that the application can interact with various LLMs, and the `src/llm` directory confirms this.
- **Nostr Protocol:** The integration with the Nostr protocol suggests that the application may be used for decentralized communication or data exchange.
- **Event-Driven:** The presence of `src/events` and `src/event-handler` directories suggests an event-driven architecture, where different parts of the application communicate through events.

## 5. High-Complexity Modules

The following modules are identified as potentially complex due to their central role and the nature of the functionality they provide:

- **`src/agents`**: The core logic of the agents, their execution, and lifecycle management. See [context/agents.md](context/agents.md) for a detailed explanation.
- **`src/llm`**: The abstraction layer for interacting with multiple LLMs, including routing, configuration, and tool usage. See [context/llm.md](context/llm.md) for a detailed explanation.
- **`src/nostr`**: The implementation of the Nostr protocol, including client management, event publishing, and task handling. See [context/nostr.md](context/nostr.md) for a detailed explanation.
- **`src/commands`**: The command definitions and their interactions with the rest of the system. See [context/commands.md](context/commands.md) for a detailed explanation.
- **`src/conversations`**: The management of conversation state, persistence, and synchronization. See [context/conversations.md](context/conversations.md) for a detailed explanation.

