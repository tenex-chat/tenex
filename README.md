# TENEX

> **Collaborative AI development** - A revolutionary context-first development environment where AI agents collaborate autonomously to build software.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built on Nostr](https://img.shields.io/badge/Built%20on-Nostr-purple)](https://nostr.com)

## What is TENEX?

TENEX represents a paradigm shift in software development. If LLMs have fundamentally changed how we write code, shouldn't our development environments evolve too? TENEX answers this by replacing the traditional text editor with a **context-first environment** where *context*, not code, becomes the primary building block.

At its core, TENEX is a sophisticated **multi-agent coordination system** built on the Nostr protocol. It enables autonomous AI agents to collaborate on complex software development tasks through intelligent routing, phase-based workflows, and continuous learning.

### Key Innovation: Intelligent Agent Coordination

Unlike traditional AI assistants where you interact with a single entity, TENEX employs an **intelligent routing** pattern. The system automatically routes your requests to specialized agents best suited for each task, creating a seamless experience where the right expertise appears exactly when needed.

## ✨ Key Features

### 🤖 **Multi-Agent Architecture**
- **Specialized Agents**: Agents for planning, execution, and project management fetched from Nostr
- **Dynamic Routing**: Intelligent task delegation based on agent capabilities and context
- **Parallel Execution**: Multiple agents can work simultaneously on different aspects of your project
- **Custom Agents**: Extensible system allowing you to define domain-specific experts

### 🔄 **Phase-Based Workflow**
Agents can define phases (for example: planning, execution, review) to structure their own todo lists and to pass phase instructions when delegating. Phases are optional and vary per agent.

### 🧠 **Continuous Learning System**
- Agents capture and apply lessons from every interaction
- Cross-conversation knowledge sharing
- Self-improving behavior based on accumulated experience
- Persistent knowledge base stored on Nostr

### 🔧 **Powerful Tool System**
- **Comprehensive Tools**: File operations, code analysis, shell execution, Git integration
- **MCP Integration**: Model Context Protocol support for dynamic tool loading
- **Type-Safe**: Comprehensive validation and error handling
- **Composable**: Tools can be combined for complex operations

### 🌐 **Nostr-Native Architecture**
- **Decentralized by Design**: No central server, peer-to-peer agent communication
- **Cryptographic Identity**: Each project maintains its own nsec for secure context
- **Event Sourcing**: Complete audit trail of all agent actions
- **Resilient**: Continues operating even with network disruptions

### 🎯 **LLM Provider Agnostic**
- Support for OpenAI, Anthropic, Google, OpenRouter, and more
- Intelligent model selection based on task requirements
- Automatic failover and rate limiting
- Cost optimization through smart routing

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+ or **Bun** runtime (recommended for development)
- **Git** for version control integration
- An API key for at least one LLM provider (OpenAI, Anthropic, etc.)

### Installation

```bash
# Clone the repository
git clone https://github.com/tenex-chat/tenex
cd tenex

# Install dependencies
bun install
```

### Configuration

Configuration and operator commands are handled by the Rust TENEX binaries. The TypeScript package is internal runtime code invoked by Rust and does not expose a user-facing CLI.

If you install the daemon launcher from npm, run:

```bash
npx @tenex-chat/daemon
```

### Quick Start

1. **Create a new project** using the [TENEX Web Client](https://github.com/tenex-chat/web-client) or iOS client

2. **Example interaction**:
```
You: Create a REST API for a todo application with authentication

TENEX: [System routes to Planner]
[Planner creates structured approach]
[Executor implements the API]
[Verification runs tests]
[Documentation is updated]
[Lessons are captured for future use]
```

## 📚 Documentation

- **[Architecture](./docs/ARCHITECTURE.md)**: Core principles, layered architecture, and module organization.
- **[Contributing](./docs/CONTRIBUTING.md)**: Development workflow, coding guidelines, and testing.
- **[Testing Status](./docs/TESTING_STATUS.md)**: Current state of the test suite and future improvements.
- **[NDK Testing](./docs/testing-with-ndk.md)**: How to use Nostr Development Kit utilities for testing.
- **[Worktrees](./docs/worktrees.md)**: Guide to using Git worktrees for parallel development.

## 🏗️ Project Structure

```
src/
├── agents/         # Agent definitions and execution runtime
├── conversations/  # Conversation history and state management
├── events/         # Core event schemas and constants
├── lib/            # Pure, framework-agnostic utilities (zero TENEX dependencies)
├── llm/            # LLM provider abstractions and factories
├── nostr/          # Nostr protocol integration and clients
├── prompts/        # System prompt composition and management
├── services/       # Stateful business logic and orchestration
├── tools/          # Agent tool implementations and registry
└── utils/          # TENEX-specific helper functions
```

## 🤝 Contributing

We welcome contributions! Please read our [**Contributing Guide**](./docs/CONTRIBUTING.md) for a detailed overview of our development workflow, coding guidelines, and architectural principles.

### Development Setup

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run tests in watch mode
bun test --watch

# Run type checking
bun run typecheck

# Run architecture linting
bun run lint:architecture

# Build for production
bun run build
```

## 🔮 What Makes TENEX Different?

### **Context Over Code**
Traditional IDEs optimize for code editing. TENEX optimizes for context management, recognizing that in the LLM era, maintaining and utilizing context effectively is more valuable than syntax highlighting.

### **Invisible Complexity**
The coordination system operates behind the scenes, presenting a simple conversational interface while managing sophisticated multi-agent collaboration underneath.

### **Quality by Design**
Mandatory verification and reflection phases ensure every task meets quality standards and contributes to the system's collective knowledge.

### **Truly Decentralized**
Built on Nostr from the ground up, not as an afterthought. This enables censorship-resistant, peer-to-peer agent networks with no single point of failure.

## 🎯 Use Cases

- **Rapid Prototyping**: Go from idea to working prototype through natural conversation
- **Code Migration**: Modernize legacy codebases with intelligent refactoring
- **Documentation**: Automatic generation and maintenance of technical documentation
- **Testing**: Comprehensive test generation and verification
- **Learning**: Agents that get better at your specific codebase over time

## 📈 Roadmap

- [ ] Web-based interface improvements
- [ ] Multi-model ensemble execution
- [ ] Real-time collaborative editing
- [ ] Advanced debugging and profiling tools

## 📄 License

MIT

## 📞 Contact & Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/tenex-chat/tenex/issues)
- **Nostr**: Follow the project at `npub1tenex...` 
- **Documentation**: [Full documentation](./docs/)

---

**Ready to experience the future of software development?** Create your first project using the [TENEX Web Client](https://github.com/tenex-chat/web-client) and let your AI agents handle the rest.

> "The best code is the code you don't have to write. The second best is code written by agents who learn from every line they produce." - TENEX Philosophy
