
# Project Name: TENEX

## 1. Core Concept

TENEX is a multi-agent development environment designed to build software through the collaboration of AI agents. It operates on the Nostr protocol, creating a decentralized and context-aware system where human developers guide high-level strategy while autonomous agents handle the low-level implementation tasks.

The fundamental shift is from traditional coding in a text editor to managing and providing context to a team of AI agents who write the code.

## 2. Key Features

*   **Multi-Agent Architecture:** The system is composed of specialized AI agents, each with a distinct role (e.g., Planner, Executor, Project Manager, human-replica).
*   **Invisible Orchestrator:** A central component that intelligently routes user requests and agent responses to the most appropriate agent, creating a seamless workflow.
*   **Phase-Based Workflow:** Every development task follows a structured, cyclical process:
    1.  **CHAT:** Requirements gathering and clarification.
    2.  **BRAINSTORM:** Idea exploration and refinement.
    3.  **PLAN:** Architectural design and technical specification.
    4.  **EXECUTE:** Code implementation and review.
    5.  **VERIFICATION:** Functional testing from an end-user perspective.
    6.  **CHORES:** Cleanup, documentation, and maintenance.
    7.  **REFLECTION:** Agents learn from the completed task to improve future performance.
*   **Conversation Restart:** When a conversation reaches its natural conclusion (the `END` phase), it is not permanently closed. If the user provides a new message, a new conversation is automatically started from the `CHAT` phase, preserving the full history and context. This ensures a seamless and continuous user experience.
*   **Continuous Learning:** Agents are designed to learn from every interaction, building a persistent knowledge base that improves their effectiveness over time.
*   **Nostr-Native:** Built on the Nostr protocol, ensuring communication is decentralized, secure, and censorship-resistant.
*   **LLM Agnostic:** Supports multiple Large Language Model providers, including OpenAI, Anthropic, and Google.
*   **Agent Presence & Identification (User-defined requirement):**
    *   **Online Status:** Agent online status must be determined by querying for `kind:24010` status events with a `since` filter of one minute ago. The `a` tag of the status event must be compared with the project's tag ID to ensure the status applies to the correct project.
    *   **Agent ID Format:** When returning agent information, the agent's `npub` must be used instead of their public key.
    *   **Agent Self-Knowledge:** Agents must be explicitly informed of their own `npub` as part of their core identity prompt.

## 3. Guiding Principles

*   **Context is King:** The primary role of the human user is to provide clear and comprehensive context. The agents' success is directly tied to the quality of this context.
*   **Human as Orchestrator:** The user acts as a high-level director, making strategic decisions and guiding the AI team, rather than writing code line-by-line.
*   **Automation of Toil:** The goal is to automate the repetitive and tedious aspects of software development, freeing up human developers to focus on creative and strategic challenges.

## 4. Technical Stack (Inferred from README)

*   **Runtime:** Node.js / Bun
*   **Protocol:** Nostr
*   **Version Control:** Git

## 5. Project Goals (Inferred from README)

*   To create a new paradigm for software development that is more efficient and powerful than traditional methods.
*   To leverage the power of multiple, specialized AI agents to tackle complex programming tasks.
*   To build a system that is robust, decentralized, and continuously improves itself.
