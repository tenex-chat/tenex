# Changelog

All notable changes to this project will be documented in this file.

## v0.8.0 (2025-10-01)
- Version bump to 0.8.0
- Added comprehensive RAG (Retrieval-Augmented Generation) tools using LanceDB
- Enhanced agent capabilities with semantic memory and knowledge persistence
- Improved embedding provider configuration with `tenex setup embed` command
- Refactored service architecture following clean code principles
- Enhanced error handling and validation across the platform
- Commit of pending changes for release
- Updated tool registry and documentation

## [Unreleased]

### Added - 2025-01-30
- **New Configuration Option: `telemetry.chunks`**
  - Added `telemetry.chunks.enabled` to control LLM chunk-level telemetry publishing
  - Added `telemetry.chunks.publishToNostr` for optional Nostr event publishing of chunk data
  - Chunks are published as OpenTelemetry spans with hierarchical structure:
    - Each LLM stream gets a parent span (linked by conversation.id)
    - Each chunk within the stream becomes a child span
    - Spans are linked across agent turns for full RAL execution tracing
  - This enables detailed observability into LLM streaming behavior and chunk-level performance
  - Configuration example:
    ```json
    {
      "telemetry": {
        "chunks": {
          "enabled": true,
          "publishToNostr": false
        }
      }
    }
    ```

### Changed - 2025-01-18
- **BREAKING: Configuration Architecture Refactored**
  - All configuration now centralized through `ConfigService`
  - `config.json` and `llms.json` are now **global-only** (stored in `~/.tenex/`)
  - Only `mcp.json` remains at project level (`{project}/.tenex/mcp.json`)
  - Removed singleton pattern - ConfigService now exports `config` instance
  - Added `config.getConfigPath(subdir?)` for centralized path construction
  - All `~/.tenex` path construction now goes through ConfigService
  - **Migration Required**: Users must manually move project-level `config.json` and `llms.json` to `~/.tenex/`
  - Updated 28+ files to use new `config` import pattern
  - LLM configuration CLI (`tenex llm`) is now global-only (removed `--project` flag)

### Removed - 2025-01-25
- Removed `write_context_file` tool from the tool registry - this tool was unused and maintained project context that is now handled differently
- Removed `PROJECT.md` system prompt fragment (30-project-md.ts) - project context is now managed through other mechanisms
- Cleaned up all references to these deprecated components from the codebase

## 0.6.0 - 2025-01-19

- **New**: Ask tool — `Ask(content, suggestions?)` — for agent-to-human question escalation. This feature introduces `kind:31337` events for questions, which include `suggestion` tags for predefined replies. The UI renders these suggestions as buttons, and user replies are sent as `kind:1111` events.