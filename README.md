# TENEX CLI

TENEX Command Line Interface - A Nostr-based agent orchestration system.

## Installation

```bash
npm install @tenex/cli
```

## Development Setup

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type checking
bun run typecheck

# Linting
bun run lint

# Build
bun run build
```

## Scripts

- `bun run build` - Build the project
- `bun test` - Run all tests
- `bun test:unit` - Run unit tests only
- `bun test:integration` - Run integration tests
- `bun test:e2e` - Run end-to-end tests
- `bun test:coverage` - Run tests with coverage
- `bun run typecheck` - Check TypeScript types
- `bun run lint` - Lint the codebase
- `bun run lint:fix` - Auto-fix linting issues

## Project Structure

```
src/
├── agents/         # Agent system and execution
├── commands/       # CLI commands
├── conversations/  # Conversation management
├── daemon/         # Background processes
├── events/         # Nostr event definitions
├── lib/           # Core libraries
├── llm/           # LLM integration
├── logging/       # Logging utilities
├── nostr/         # Nostr protocol integration
├── prompts/       # Prompt management
├── services/      # Core services
├── tools/         # Tool system
├── tracing/       # Execution tracing
└── utils/         # Utility functions
```

## Documentation

See the `documentation/` directory for detailed documentation:

- [Agent Execution Architecture](documentation/agent-execution-architecture.md)
- [Event-Driven Architecture](documentation/event-driven-architecture.md)
- [Prompt System Architecture](documentation/prompt-system-architecture.md)
- [Tool System Architecture](documentation/tool-system-architecture.md)

## License

ISC