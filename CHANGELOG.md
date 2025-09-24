# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2025-01-25

### Removed
- Removed `write_context_file` tool from the tool registry - this tool was unused and maintained project context that is now handled differently
- Removed `PROJECT.md` system prompt fragment (30-project-md.ts) - project context is now managed through other mechanisms
- Cleaned up all references to these deprecated components from the codebase

## 0.6.0 - 2025-01-19

- **New**: Ask tool — `Ask(content, suggestions?)` — for agent-to-human question escalation. This feature introduces `kind:31337` events for questions, which include `suggestion` tags for predefined replies. The UI renders these suggestions as buttons, and user replies are sent as `kind:1111` events.