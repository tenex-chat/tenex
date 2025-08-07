# LLM Module

## Overview

The `src/llm` module provides an abstraction layer for interacting with various Large Language Models (LLMs). It handles model selection, configuration, and the routing of requests to the appropriate LLM backend. This module is essential for the agent execution loop, as it provides the interface for the agents to communicate with the LLMs.

## Key Components

- **`router.ts`**: The central component of the LLM module. It contains the logic for selecting the best LLM for a given task based on the provided criteria, such as the required capabilities (e.g., tool use, code generation) and the user's preferences.

- **`models.ts`**: Defines the supported LLM models and their capabilities. This file is used by the `router.ts` to make decisions about which model to use.

- **`selection/`**: This directory contains the logic for the LLM selection process, including the `ModelSelector` class, which implements the model selection algorithm.

- **`ui/`**: This directory contains the user interface components for managing LLM configurations.

- **`types.ts`**: Defines the data structures and types used throughout the LLM module, such as `LLMConfig`, `Model`, and `ModelCapabilities`.
