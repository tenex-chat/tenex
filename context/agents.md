# Agents Module

## Overview

The `src/agents` module is the core of the TENEX application, responsible for defining and managing the agents that perform tasks. It includes the logic for agent execution, lifecycle management, and the registration of built-in and custom agents.

## Key Components

- **`AgentRegistry.ts`**: A singleton class that manages the registration and lifecycle of all agents. It allows for publishing, unpublishing, and republishing agents.

- **`AgentExecutor.ts`**: The main class responsible for executing an agent's reasoning loop. It takes an agent, a conversation, and a set of tools, and then orchestrates the interaction between the LLM and the tools to accomplish a task.

- **`built-in/`**: This directory contains the definitions of the built-in agents provided by TENEX:
    - **`executor.ts`**: An agent that executes a single task.
    - **`planner.ts`**: An agent that creates a plan for a complex task but does not execute it.
    - **`project-manager.ts`**: An agent that manages the entire lifecycle of a project, from planning to execution.

- **`execution/`**: This directory contains the core logic for the agent execution loop, including:
    - **`ReasonActLoop.ts`**: Implements the ReAct (Reason and Act) pattern for agent execution.
    - **`ToolStreamHandler.ts`**: Handles the streaming of tool outputs.
    - **`StreamStateManager.ts`**: Manages the state of streaming operations during tool execution.
    - **`TerminationHandler.ts`**: Handles graceful termination of agent execution.
    - **`ToolRepetitionDetector.ts`**: Detects and prevents infinite loops in tool usage.

- **`types.ts`**: Defines the data structures and types used throughout the agents module, such as `Agent`, `AgentExecution`, and `Tool`.
