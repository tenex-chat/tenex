# Agents Module

## Overview

The `src/agents` module is the core of the TENEX application, responsible for defining and managing the agents that perform tasks. It includes the logic for agent execution, lifecycle management, and the registration of agents from Nostr events.

## Key Components

- **`AgentRegistry.ts`**: A singleton class that manages the registration and lifecycle of all agents. It allows for publishing, unpublishing, and republishing agents.

- **Agent Definitions**: All agents are now defined via NDKAgentDefinition events (kind 4199) fetched from Nostr. There are no built-in agents - all agents are treated uniformly and fetched the same way.

- **`execution/`**: This directory contains the core logic for the agent execution loop, including:
    - **`AgentExecutor.ts`**: The main class responsible for executing an agent's reasoning loop. It takes an agent, a conversation, and a set of tools, and then orchestrates the interaction between the LLM and the tools to accomplish a task.
    - **`ReasonActLoop.ts`**: Implements the ReAct (Reason and Act) pattern for agent execution.
    - **`ToolStreamHandler.ts`**: Handles the streaming of tool outputs.
    - **`StreamStateManager.ts`**: Manages the state of streaming operations during tool execution.
    - **`TerminationHandler.ts`**: Handles graceful termination of agent execution.


- **`constants.ts`**: Defines constants and default tool assignments used throughout the agents module.

- **`utils.ts`**: Utility functions for agent operations.

- **`types.ts`**: Defines the data structures and types used throughout the agents module, such as `AgentInstance`, `AgentConfig`, and `ToolCall`.

## Agent Management

### Project Manager Selection

The Project Manager (PM) agent is dynamically determined as the **first agent** listed in the NDKProject event's `agent` tags. This means the order of agent tags in the project definition is significant - the first agent reference becomes the PM for that project.

Example NDKProject event structure:
```
tags: [
  ["agent", "pm-event-id"],      // This agent becomes the PM
  ["agent", "executor-event-id"], 
  ["agent", "planner-event-id"]
]
```

The PM has special privileges such as access to the `shell` tool and the ability to coordinate other agents through phase delegation.

### Agent Loading

Agents are loaded from:
1. **Nostr Events**: NDKAgentDefinition events (kind 4199) containing agent specifications
2. **Local Registry**: JSON files in `.tenex/agents/` directory for offline development

All agents receive the same default tool set, which can be augmented by tool requirements specified in their definition events via `["tool", "tool-name"]` tags.
