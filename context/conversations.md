# Conversations Module

## Overview

The `src/conversations` module is responsible for managing the state and flow of conversations between users and agents. It handles the persistence of conversations, the synchronization of agent context, and the tracking of execution time.

## Key Components

- **`ConversationManager.ts`**: The main class that manages the lifecycle of conversations. It provides methods for creating, retrieving, and updating conversations.

- **`persistence/`**: This directory contains the logic for persisting conversations to storage. It includes a `FileSystemAdapter` that saves conversations to the local filesystem.

- **`types.ts`**: Defines the data structures and types used throughout the conversations module, such as `Conversation`, `Message`, and `AgentContext`.

- **`phases.ts`**: Defines the different phases of a conversation, such as `CHAT`, `PLAN`, and `EXECUTE`.

- **`executionTime.ts`**: A utility for tracking the execution time of different parts of the conversation.
