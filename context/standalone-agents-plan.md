# Plan for Project-Independent Agent Conversations

This document outlines a comprehensive plan for enabling agent conversations outside of project contexts in TENEX. This will allow for standalone agent functionality, such as trying out agents before installing them and interacting with global agents.

## Phased Implementation

The implementation is broken down into four phases to deliver value incrementally and reduce risk.

### Phase 1: Core Infrastructure Changes

This phase focuses on laying the groundwork for standalone agent conversations by creating parallel infrastructure that doesn't interfere with existing project-based workflows.

*   **Key components:**
    *   `StandaloneConversationManager`: A new manager for conversations that are not associated with a project.
    *   `StandaloneAgentResolver`: A resolver for finding and instantiating agents that are not part of a project. (Note: A `StandaloneAgentResolver` already exists in the codebase, so this task will involve reviewing and potentially adapting it.)
*   **Persistence:**
    *   Initially, conversations will be stored in-memory only to simplify the initial implementation.
    *   Later, a persistence layer can be added (e.g., using a local database or Nostr events).

### Phase 2: New CLI Commands

This phase will introduce new CLI commands to allow users to interact with standalone agents.

*   **Commands:**
    *   `tenex agent chat <agent_id>`: Start a conversation with a global agent.
    *   `tenex agent try <agent_definition_id>`: Start a temporary conversation with a new instance of an agent from a definition.
*   **Implementation details:**
    *   These commands will use the new `StandaloneConversationManager` and `StandaloneAgentResolver`.

### Phase 3: Standalone Agent Execution Model

This phase will implement the execution model for standalone agents, enabling them to respond to user messages.

*   **Execution flow:**
    *   User messages will be sent directly to the agent's pubkey using NDK subscriptions.
    *   This bypasses the project-based orchestrator routing.
*   **Agent capabilities:**
    *   Agents will be able to operate in both project and standalone modes.
    *   This will be achieved through progressive enhancement, where agents have a baseline of functionality in standalone mode and enhanced capabilities when in a project context.

### Phase 4: Enhanced Features and Marketplace Integration

This phase will add advanced features and integrate with the agent marketplace.

*   **Features:**
    *   **Global Agent Registry:** A central registry for all available global agents.
    *   **Nostr Discovery:** The ability to discover and interact with agents from the Nostr network.
*   **Marketplace integration:**
    *   This will allow users to easily find, try, and install agents from a marketplace.

## Guiding Principles

*   **Reusability:** Leverage existing components whenever possible to reduce development time and complexity.
*   **Simplicity:** Start with simple solutions (e.g., in-memory persistence) and add complexity as needed.