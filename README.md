# TENEX

> **Orchestrate the orchestrators** - A revolutionary context-first development environment where AI agents collaborate autonomously to build software.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built on Nostr](https://img.shields.io/badge/Built%20on-Nostr-purple)](https://nostr.com)

## What is TENEX?

TENEX represents a paradigm shift in software development. If LLMs have fundamentally changed how we write code, shouldn't our development environments evolve too? TENEX answers this by replacing the traditional text editor with a **context-first environment** where *context*, not code, becomes the primary building block.

At its core, TENEX is a sophisticated **multi-agent orchestration system** built on the Nostr protocol. It enables autonomous AI agents to collaborate on complex software development tasks through intelligent routing, phase-based workflows, and continuous learning.

### Key Innovation: Invisible Orchestration

Unlike traditional AI assistants where you interact with a single entity, TENEX employs an **invisible orchestrator** pattern. The orchestrator silently routes your requests to specialized agents best suited for each task, creating a seamless experience where the right expertise appears exactly when needed.

## ✨ Key Features

### 🤖 **Multi-Agent Architecture**
- **Specialized Agents**: Built-in agents for orchestration, planning, execution, and project management
- **Dynamic Routing**: Intelligent task delegation based on agent capabilities and context
- **Parallel Execution**: Multiple agents can work simultaneously on different aspects of your project
- **Custom Agents**: Extensible system allowing you to define domain-specific experts

### 🔄 **Phase-Based Workflow**
Every interaction follows a structured lifecycle ensuring quality and completeness:
1. **Chat** → Initial conversation and understanding
2. **Brainstorm** → Creative exploration and ideation
3. **Plan** → Structured approach definition
4. **Execute** → Implementation and tool usage
5. **Verification** → Quality assurance and testing
6. **Chores** → Documentation and maintenance
7. **Reflection** → Learning capture and improvement

### 🧠 **Continuous Learning System**
- Agents capture and apply lessons from every interaction
- Cross-conversation knowledge sharing
- Self-improving behavior based on accumulated experience
- Persistent knowledge base stored on Nostr

### 🔧 **Powerful Tool System**
- **Built-in Tools**: File operations, code analysis, shell execution, Git integration
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

- **Node.js** 18+ or **Bun** runtime
- **Git** for version control integration
- An API key for at least one LLM provider (OpenAI, Anthropic, etc.)

### Installation

```bash
# Clone the repository
git clone https://github.com/tenex-chat/tenex
cd tenex

# Install dependencies
bun install

# Configure your LLM provider
bun run setup:llm

# Start TENEX
bun run tenex
```

### Quick Start

1. **Create a new project** using the [TENEX Web Client](https://github.com/tenex-chat/web-client) or iOS client

2. **Example interaction**:
```
You: Create a REST API for a todo application with authentication

TENEX: [Orchestrator routes to Planner]
[Planner creates structured approach]
[Executor implements the API]
[Verification runs tests]
[Documentation is updated]
[Lessons are captured for future use]
```

## 📚 Documentation

### Architecture Guides
- [Workflow Management](./documentation/workflow-management-architecture.md) - High-level system overview
- [Agent Execution](./documentation/agent-execution-architecture.md) - How agents operate
- [Phase Management](./documentation/phase-management-architecture.md) - Workflow control system
- [Tool System](./documentation/tool-system-architecture.md) - Capability implementation
- [Learning System](./documentation/learning-system-internals.md) - Continuous improvement mechanics

### Developer Documentation
For detailed technical documentation, see the [documentation](./documentation/) directory.

## 🏗️ Project Structure

```
src/
├── agents/         # Agent system and execution
├── commands/       # CLI commands
├── conversations/  # Conversation management
├── daemon/         # Background processes
├── events/         # Nostr event definitions
├── llm/           # LLM provider integration
├── nostr/         # Nostr protocol layer
├── prompts/       # Prompt composition system
├── tools/         # Tool implementations
└── utils/         # Utility functions
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Run tests
bun test

# Type checking
bun run typecheck

# Linting
bun run lint

# Build
bun run build
```

## 🔮 What Makes TENEX Different?

### **Context Over Code**
Traditional IDEs optimize for code editing. TENEX optimizes for context management, recognizing that in the LLM era, maintaining and utilizing context effectively is more valuable than syntax highlighting.

### **Invisible Complexity**
The orchestrator operates behind the scenes, presenting a simple conversational interface while managing sophisticated multi-agent choreography underneath.

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

MIT - see [LICENSE](LICENSE) file for details

## 📞 Contact & Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/tenex-chat/tenex/issues)
- **Nostr**: Follow the project at `npub1tenex...` 
- **Documentation**: [Full documentation](https://docs.tenex.chat)

---

**Ready to experience the future of software development?** Create your first project using the [TENEX Web Client](https://github.com/tenex-chat/web-client) and let your AI agents handle the rest.

> "The best code is the code you don't have to write. The second best is code written by agents who learn from every line they produce." - TENEX Philosophy