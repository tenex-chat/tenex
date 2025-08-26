# Brainstorming Phase: Swappable Moderator Concept

This document outlines a proposed feature for a new, moderated brainstorming workflow.

## 1. Core Concept: Swappable Moderator

The central idea is to introduce a "moderator" agent role specifically for the `BRAINSTORM` phase.

*   **Swappable Moderators:** A project can contain multiple moderator agents. Each moderator can have a unique style (e.g., collaborative, democratic, inquisitive), allowing the user to choose the best fit for a given session.
*   **Single Point of Contact:** During a brainstorming session, all messages from all participants (including the user) are routed exclusively through the currently selected moderator agent.

## 2. Proposed Workflow

1.  **Initiation:** When the `BRAINSTORM` phase begins, a moderator agent is selected.
2.  **User Input:** All user messages are sent directly to the moderator.
3.  **Agent Prompting:** The moderator chooses which agents (a subset or all participants) to prompt based on the current context. This is a synchronous, parallel process that does not involve Nostr events. Agents respond directly and synchronously to the moderator.
4.  **Response Evaluation:** The moderator evaluates the collected agent responses against its own internal criteria (e.g., creativity, relevance, fairness).
5.  **Publishing Decision:** The moderator decides which agent responses should be published to the wider group.
6.  **Event Publishing:** The recommended approach is for all agents to provide their response as a pre-signed Nostr event. The moderator then simply publishes the events from the chosen agent(s). This preserves the identity and signature of the original authoring agent.

## 3. Open Questions & Challenges

### a) Bypassing Standard Conversation Flow

A mechanism is needed to bypass the current conversational input/output flows to accommodate this specialized, moderator-centric workflow.

### b) Facilitating Agent-to-Agent Brainstorming

The primary goal is to foster direct agent-to-agent collaboration, with the user acting as just another participant.

*   **The Challenge:** How can the moderator decide when and how to share agent responses with other agents to stimulate further discussion without creating an unmanageable firehose of messages?
*   **Proposed Gating Mechanism:** To manage the flow, the following process is suggested:
    1.  When the moderator publishes an agent's response, it immediately and synchronously prompts all other participating agents with that same response.
    2.  The prompt would ask the other agents a targeted question, such as: "Do you have something extremely valuable to add, or do you strongly disagree with the point being made?"
    3.  This creates a structured and manageable way for agents to build upon or challenge each other's ideas, preventing chaotic, free-for-all communication.

## 4. Proposed Solutions for Out-of-Band Communication

To address the challenge of enabling synchronous, off-the-record communication between the moderator and other agents, the following architectural patterns have been proposed by the researcher:

### a) Direct Execution Service (Recommended)

This approach involves creating a new, internal service that allows the moderator agent to directly invoke the execution logic of other agents.

*   **How it works:** The moderator would call a function like `agentExecutionService.getCompletion(agent, prompt)`, which would synchronously return the agent's response without publishing any Nostr events.
*   **Pros:**
    *   Reuses existing agent execution logic.
    *   Low implementation complexity.
    *   Provides a clear and direct communication path.
*   **Cons:**
    *   Creates a tighter coupling between the moderator and the execution logic.

### b) Internal Event Bus

This pattern introduces a private, in-memory event bus for internal agent communication.

*   **How it works:** The moderator would dispatch an event (e.g., `REQUEST_FOR_IDEAS`) onto the internal bus. Participating agents would listen for these events and publish their responses (e.g., `IDEA_RESPONSE`) back to the same bus. The moderator would then collect all responses.
*   **Pros:**
    *   Highly decoupled architecture.
*   **Cons:**
    *   Increased complexity in setup and management.
    *   Potential for race conditions if not managed carefully.

### c) Centralized Agent RPC Manager

This hybrid approach establishes a single manager to handle all internal agent-to-agent Remote Procedure Calls (RPC).

*   **How it works:** The moderator would make a request to the `RPCManager` (e.g., `rpcManager.getCompletionFrom(agent, prompt)`). The manager would then handle the underlying communication with the target agent and return the result.
*   **Pros:**
    *   Centralized control and observability.
*   **Cons:**
    *   Can become a performance bottleneck.
    *   Adds another layer of indirection.

### d) Threaded Replies with Re-signing (User-proposed)

This user-proposed solution leverages the existing Nostr event structure in a novel way, keeping brainstorming side-chatter off the main conversation root.

*   **How it works:**
    1.  Instead of a fully out-of-band process, agents publish their responses as standard Nostr events. However, they `e`-tag the *triggering event* (the moderator's prompt) rather than the root of the conversation. This effectively places all suggestions into a side-thread.
    2.  The moderator uses the standard `delegate()` tool and is notified once all agents have published their threaded replies.
    3.  The moderator evaluates the side-thread and chooses the best response, returning only the `event id` of its choice.
    4.  A specialized brainstorm handler then fetches the chosen event, and requests the original authoring agent to *re-sign* it. This is a cryptographic operation that does not involve a new LLM call.
    5.  During the re-signing, the `e`-tag is modified to point to the main conversation root, which "promotes" the chosen reply into the primary discussion flow.

*   **Pros:**
    *   Requires minimal changes to the existing agent delegation and publishing flow.
    *   Increases transparency by allowing the human user to see all proposed ideas, not just the one selected by the moderator. This could provide inspiration and learning opportunities.

*   **Cons:**
    *   Publishes all potential responses to the Nostr network, which may be considered noisy.

*   **Viability Analysis (Researcher's Findings):**
    *   **Conclusion:** This approach is highly viable and can be implemented securely.
    *   **Core Principle:** The key is the separation of concerns between an LLM generating content (thinking) and the agent's independent module for cryptographically signing events (proving identity).
    *   **Implementation:** Because signing is a separate cryptographic function, a new event can be created with the same content but a modified `e`-tag. The original agent can then be requested to sign this new event, which does **not** require a new LLM call. The agent's identity is securely preserved on the "promoted" event.
