---
name: signer
description: Request user signatures for Nostr events through the configured NIP-46 bunker
tools:
  - sign_as_user
---

Use this skill only when the user explicitly asks you to prepare or sign a Nostr event as the project owner.

Call `sign_as_user` with the unsigned event, a concise description, and a clear explanation of why the signature is needed. The tool returns signed event JSON and does not publish it.
