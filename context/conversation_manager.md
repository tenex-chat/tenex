### Report: The TENEX Conversation Manager

This report provides a comprehensive overview of the `ConversationManager`, a critical component in the TENEX system. It covers its role in state management, context building for AI agents, data persistence, and its interaction with other parts of the application.

---

#### 1. High-Level Overview

The `ConversationManager` is the central hub for creating, managing, and persisting the state of all conversations within a project. It serves as the single source of truth for the entire lifecycle of a user's request, from the initial message to the final output.

Its primary responsibilities are:

*   **State Management:** Tracking the complete history of messages, the current phase of work, and the individual context for each participating agent.
*   **Context Building:** Preparing the specific history and instructions (the "prompt") that an AI agent needs to perform its task.
*   **Persistence:** Saving conversations to the filesystem so that state is not lost between application restarts.
*   **System Interaction:** Serving as the interface between Nostr events, agent logic, and the persistence layer.

---

#### 2. State Management: The `Conversation` Object

The core of the manager's state is the `Conversation` object. Each conversation is an instance of this object, held in an in-memory `Map`. Here’s a breakdown of its key properties:

*   **`id`**: A unique identifier for the conversation, derived from the ID of the initial Nostr event.
*   **`title`**: A human-readable title for the conversation.
*   **`history`**: This is the **single source of truth** for a conversation. It is an ordered array of `NDKEvent` objects representing every message from the user and all participating agents.
*   **`phase`**: The current stage of the conversation (e.g., `chat`, `plan`, `execute`). The manager controls phase transitions via the `updatePhase` method.
*   **`agentStates`**: This is a `Map` that is crucial for multi-agent context management. It maps an agent's slug (e.g., "project-manager") to its `AgentState`, which contains details like the last message the agent has processed.
*   **`phaseTransitions`**: A detailed log of every phase change, providing a rich audit trail.
*   **`executionTime`**: An object that tracks the cumulative time agents spend actively working on the conversation.

---

#### 3. Context Building for Agents

The most complex and vital function of the `ConversationManager` is building the message history for an agent. This process ensures that each agent receives a tailored, complete, and coherent history, enabling it to act with full awareness of the conversation's flow.

The process involves:

1.  **Identifying the Agent's State**: It retrieves the agent's `AgentState` to determine which messages it has already seen.
2.  **Building Historical Context**: It formats past messages differently based on the sender (the agent's own messages, user messages, or other agents' messages).
3.  **Providing "Messages While You Were Away"**: If there are new messages since the agent was last active, the manager creates a special summary block.
4.  **Injecting Phase Instructions**: A message is added to inform the agent of the current `PHASE` of the conversation and its goals.
5.  **Adding the Triggering Event**: The final message in the context is the specific event that triggered this action.
6.  **Updating State**: After building the context, the manager updates the agent's state to ensure it doesn't see the same messages again.

---

#### 4. Persistence via `FileSystemAdapter`

The `ConversationManager` ensures that no data is lost by using a persistence adapter. The default implementation is the `FileSystemAdapter`.

*   **Location**: It stores all data within the project's `.tenex/conversations/` directory.
*   **Serialization**: When a conversation is saved, the `Conversation` object is serialized into a JSON file. This process involves converting maps to objects and `NDKEvent`s to strings.
*   **Loading**: When the application starts, the adapter reads the JSON files, validates them, and reconstructs the full `Conversation` objects in memory.
*   **Metadata**: To speed up the listing of conversations, a central `metadata.json` file is maintained with a lightweight summary of each conversation.
*   **Archiving**: The adapter also supports archiving and restoring conversations.

---

#### 5. Interactions with Other Systems

The `ConversationManager` is deeply integrated with other parts of the TENEX system:

*   **Nostr**: It is fundamentally event-driven, creating and updating conversations based on `NDKEvent`s. It can also fetch and inline the content of `nostr:` URIs found in messages, enriching the context for agents.
*   **Agents**: It relies on the `ProjectContext` to get a list of all available agents and their properties.
*   **Orchestrator Agent**: It has a special method to build a structured summary of the conversation's history for the orchestrator, which helps it make routing decisions.
*   **Execution Queue**: It is designed to work with an `ExecutionQueueManager` to handle concurrent operations and ensure safe access to shared resources like the filesystem.
