# Brainstorming Phase: Swappable Moderator Concept

This document outlines a proposed feature for a new, moderated brainstorming workflow.

## 1. Core Concept: Swappable Moderator

The central idea is to introduce a "moderator" agent role specifically for the `BRAINSTORM` phase.

*   **Swappable Moderators:** A project can contain multiple moderator agents. Each moderator can have a unique style (e.g., collaborative, democratic, inquisitive), allowing the user to choose the best fit for a given session.
*   **Single Point of Contact:** During a brainstorming session, all messages from all participants (including the user) are routed exclusively through the currently selected moderator agent.

## 2. Proposed Workflow

1.  **Initiation:** When the `BRAINSTORM` phase begins, the user selects a moderator agent.
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