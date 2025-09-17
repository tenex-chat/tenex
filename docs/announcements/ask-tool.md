Title: New "Ask" tool
Date: 2025-09-17

We have added a new "Ask" tool that lets agents escalate questions to the user and pause execution until a response is received.

Key points:
- API: Ask(content: string, suggestions?: string[])
- Supports open-ended, yes/no, and multiple-choice questions.
- Uses the existing delegate service so the agent waits for a reply before continuing.
- Nostr encoding: the question is stored in the event content; each suggestion is encoded as a separate ['suggestion', '...'] tag.
- UX: web clients should render suggestion tags as interactive buttons. When a user clicks a suggestion, the client publishes a kind:1111 reply event (same mechanics as a standard reply).

If you have any questions about how to integrate or test the Ask tool, ask the executor-coordinator or contact the project manager.