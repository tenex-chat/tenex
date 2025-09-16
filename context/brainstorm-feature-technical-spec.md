
# TENEX Brainstorming Feature: Technical Deep Dive

This document provides a detailed technical explanation of the multi-agent brainstorming feature in the TENEX project. It covers the end-to-end workflow, from the initial event trigger to the handling of follow-up replies.

## 1. Core Concept

The brainstorming feature is designed as a **stateless, synchronous orchestration**. It enables a designated "moderator" agent to gather and evaluate responses from multiple "participant" agents in a single, coordinated workflow. The entire process is managed by a new, stateless `BrainstormService`, ensuring a clean separation of concerns and no replication of state.

## 2. The Triggering Event: `kind:11`

The entire workflow is initiated by a specific `nostr` event structure:

- **Kind:** `11` (Chat Message)
- **Tags:**
    - `["mode", "brainstorm"]`: This is the primary tag that the system uses to identify the event as a brainstorm request.
    - `["p", "<moderator_pubkey>"]`: The pubkey of the agent designated as the moderator. The system uses the **first** `p` tag for this role.
    - `["participant", "<agent_1_pubkey>"]`: The pubkey of a participating agent.
    - `["participant", "<agent_2_pubkey>"]`: There can be multiple `participant` tags.
- **Content:** The text content of the event serves as the initial prompt for all participating agents.
- **Event ID:** The `id` of this root `kind:11` event is used as the unique identifier for the entire brainstorming session.

## 3. Phase 1: The Synchronous Orchestration (`BrainstormService.start`)

This phase is handled entirely within a single, synchronous execution of the `BrainstormService.start(event)` method.

**Step 1: Detection and Routing**
- The main event loop (in `src/commands/run/SubscriptionManager.ts`) receives the incoming event.
- It performs a preliminary check for the `["mode", "brainstorm"]` tag.
- **Crucially**, if this tag is found, the system **bypasses** the standard `AgentRouter` logic. It directly instantiates `BrainstormService` and calls the `start(event)` method, then stops further processing for this event.

**Step 2: Parsing**
- Inside `start()`, the service uses the newly added methods in `AgentEventDecoder` (`getModerator` and `getParticipants`) to parse the event tags and identify the pubkeys for the moderator and all participant agents.

**Step 3: Parallel Response Generation**
- The service uses `Promise.all` to run the following logic for all participants concurrently:
    a. It retrieves the `AgentInstance` for the participant.
    b. It calls the refactored `agentExecutor.prepareLLMRequest()` method. This new, decoupled method prepares the full context for the agent (system prompt, conversation history, the initial brainstorm prompt) and returns a structured `LLMCompletionRequest` object.
    c. It then makes a **direct, awaited call** to `llmService.complete()` using the prepared request.
    d. The raw string response from the LLM is collected in an in-memory array.
- This process avoids the overhead of the full `AgentExecutor.execute()` lifecycle (tools, streaming, publishing) and is highly efficient.

**Step 4: Moderation**
- Once all participant responses are collected, the `BrainstormService` constructs a new, single-purpose prompt for the moderator's LLM.
- This prompt instructs the moderator to evaluate the numbered responses and reply with a structured **JSON object**: `{"chosen_option": 1, "reason": "..."}`.
- The service makes another direct call to `llmService.complete()` for the moderator.
- The returned string is safely parsed using `JSON.parse()`, making the choice detection robust and reliable.

**Step 5: Publishing Results**
- The service loops through the in-memory responses.
- For each response, it instantiates `AgentPublisher` with the participant agent's identity to ensure the event is **signed by the original author**.
- The **winning response** is published as a standard `kind:1` reply to the root `kind:11` event.
- All other responses are also published as `kind:1` replies, but with an additional `["not-chosen"]` tag.
- The `start()` method then completes. No state is persisted within the service itself.

## 4. Phase 2: Asynchronous Follow-Up (`BrainstormService.handleFollowUp`)

This phase handles replies that occur *after* the initial brainstorm is complete.

**Step 1: Detection and Routing**
- A user or agent publishes a standard `kind:1` reply to any of the events from the just-completed brainstorm session (e.g., replying to the winning answer).
- This event is received by the standard `src/event-handler/reply.ts` handler.
- **Crucially:** Inside `reply.ts`, before any agent execution, it uses the `ConversationResolver` to walk up the event thread and find the root event.
- It checks if the root event has the `["mode", "brainstorm"]` tag.
- If it does, it knows this is a follow-up in a brainstorm context. It calls `brainstormService.handleFollowUp(event)` and **stops** the standard reply processing.

**Step 2: Follow-Up Moderation**
- The `handleFollowUp()` method constructs a new prompt for the original moderator's LLM. This prompt includes the context (original prompt, winning answer) and the new reply, asking, "Is this follow-up valuable enough to be added to the conversation?"
- It makes a direct call to `llmService.complete()`.

**Step 3: Conditional Publishing**
- If the moderator's LLM responds affirmatively, the `handleFollowUp()` method uses `AgentPublisher` to publish the new reply.
- If the moderator deems it not valuable, the service does nothing, effectively filtering out low-value chatter.

## 5. Key Architectural Components

- **`BrainstormService.ts` (New):** A stateless service that acts as the central orchestrator for the entire workflow.
- **`AgentExecutor.ts` (Refactored):** Now contains a decoupled `prepareLLMRequest()` method, making it a reusable utility for preparing LLM context without triggering a full execution.
- **`SubscriptionManager.ts` & `reply.ts` (Modified):** These event handlers now act as the primary routing points, detecting brainstorm-related events and delegating them to the `BrainstormService`.
- **`AgentEventDecoder.ts` (Modified):** Enhanced with specific utility functions (`getModerator`, `getParticipants`) for parsing the brainstorm event structure.

## 6. Visual Flow

This diagram illustrates the V4 architecture:

```mermaid
graph TD
    subgraph "Event Handling"
        A[nostr:event kind:11] --> B(src/event-handler/SubscriptionManager.ts);
        I[nostr:event kind:1<br/>(reply)] --> J(src/event-handler/reply.ts);
    end

    subgraph "Services"
        C(src/services/BrainstormService.ts);
        D(src/agents/execution/AgentExecutor.ts);
        E(src/llm/service.ts)
    end
    
    subgraph "Nostr Network"
        F[Published Initial Responses]
        K[Published Follow-Up]
    end

    B -- "Detects 'brainstorm'<br/>Delegates to start()" --> C;
    C -- "For each participant:<br/>1. prepareLLMRequest()" --> D;
    D -- "Returns LLMRequest" --> C;
    C -- "2. complete(request)" --> E;
    E -- "Returns LLMResponse" --> C;
    C -- "For moderator:<br/>complete(moderation_prompt)" --> E;
    C -- "Publishes results" --> F;

    J -- "Detects brainstorm thread<br/>Delegates to handleFollowUp()" --> C;
    C -- "Moderates follow-up via LLM" --> E;
    C -- "Conditionally Publishes" --> K;
```
