# Changelog

All notable changes to this project will be documented in this file.

## 0.6.0 - 2025-01-19

- **New**: Ask tool — `Ask(content, suggestions?)` — for agent-to-human question escalation. This feature introduces `kind:31337` events for questions, which include `suggestion` tags for predefined replies. The UI renders these suggestions as buttons, and user replies are sent as `kind:1111` events.