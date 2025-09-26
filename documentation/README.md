# TENEX Backend Architecture Documentation

## Overview

This documentation provides comprehensive technical details about the TENEX backend architecture, a sophisticated multi-agent orchestration system built on Nostr protocol foundations. TENEX enables autonomous AI agents to collaborate on complex tasks through phase-based workflows, intelligent routing, and robust state management.

## Table of Contents

### Core Systems

#### 1. [Workflow Management Architecture](./workflow-management-architecture.md)
The high-level workflow orchestration system that controls the entire lifecycle of task execution. Implements phase-based multi-agent coordination with invisible orchestrator pattern, quality gates, and deterministic execution guarantees.

#### 2. [Phase Management Architecture](./phase-management-architecture.md)
The sophisticated state machine that governs conversation lifecycle through seven distinct phases (chat, brainstorm, plan, execute, verification, chores, reflection). Ensures quality, completeness, and learning across all agent interactions.

#### 3. [Conversation Management Architecture](./conversation-management-architecture.md)
The foundational infrastructure that orchestrates multi-agent interactions, maintains state consistency, and enables coherent task execution. Combines event sourcing principles with phase-based workflow orchestration.

### Agent Systems

#### 4. [Agent Execution Architecture](./agent-execution-architecture.md)
The core execution framework that manages agent lifecycle, message building, tool execution, and response streaming. Provides the runtime environment for all agent operations through the unified ReasonActLoop implementation.

#### 5. [Agent Context Management Internals](./agent-context-management-internals.md)
Deep technical analysis of how agents maintain and utilize context across conversations. Covers memory management, context windows, state persistence, and cross-conversation learning mechanisms.

#### 6. [Orchestrator Routing Architecture](./orchestrator-routing-architecture.md)
The intelligent routing system that coordinates multi-agent collaboration. Implements the invisible orchestrator pattern with dynamic agent selection, phase-aware routing, and error recovery.

#### 7. [Routing System Design](./routing-system-redesign.md)
Complete routing system design and implementation plan. Details the core principles of orchestrator as silent router, phase outputs, automatic quality control, and organic user communication.

### Execution Infrastructure

#### 8. [Streaming and State Management Architecture](./streaming-state-management-architecture.md)
Critical component handling real-time LLM response streaming, tool execution coordination, and state consistency during agent interactions. Ensures reliable, low-latency communication.

### Tool and Integration Systems

#### 9. [Tool System Architecture](./tool-system-architecture.md)
Type-safe, composable infrastructure for agent capabilities. Bridges agent intentions with concrete actions through comprehensive tools and MCP integration with validation and error handling.

#### 10. [MCP Integration Architecture](./mcp-integration-architecture.md)
Model Context Protocol integration enabling dynamic tool loading from external servers. Provides seamless adapter layer between MCP tools and TENEX's internal tool system.

### Infrastructure Components

#### 11. [Event-Driven Architecture](./event-driven-architecture.md)
The Nostr-based event system that forms the communication backbone. Handles event routing, subscription management, and distributed state synchronization across the system.

#### 12. [Daemon Process Management Architecture](./daemon-process-management-architecture.md)
Process lifecycle management for long-running services. Handles daemon spawning, monitoring, graceful shutdown, and crash recovery for system stability.

#### 13. [LLM Routing Architecture](./llm-routing-architecture.md)
Intelligent model selection and request routing system. Manages multiple LLM providers, handles failover, rate limiting, and optimizes model selection based on task requirements.

### Support Systems

#### 14. [Prompt System Architecture](./prompt-system-architecture.md)
Sophisticated compositional engine for constructing context-aware system prompts. Uses fragment-based approach with priority ordering, conditional inclusion, and runtime composition for consistent agent behavior.

#### 15. [Learning System Internals](./learning-system-internals.md)
Comprehensive analysis of the distributed learning infrastructure. Enables agents to capture, store, retrieve, and apply lessons learned across conversations for continuous improvement.

#### 16. [Tracing and Observability Architecture](./tracing-observability-architecture.md)
Comprehensive execution flow tracking, debugging capabilities, and structured logging. Implements hierarchical context propagation for detailed insight into system behavior and performance.

#### 18. [Execution Queue Mutex System](./execution-queue-mutex-system.md)
Project-wide synchronization mechanism ensuring only one conversation per project can execute at a time. Prevents resource conflicts, maintains state consistency, and provides fair queuing with transparent wait times.

#### 19. [User Preferences and Tooling Lessons](./user-preferences-and-tooling-lessons.md)
Captured lessons learned from user interactions and tooling implementations. Documents development patterns, Nostr integration standards, and best practices for tool development within the TENEX ecosystem.

## Architecture Principles

### Core Design Philosophy

1. **Event-Driven Foundation**: All state changes originate from Nostr events, providing immutable audit trail and natural distribution
2. **Phase-Based Quality Control**: Mandatory progression through verification and reflection phases ensures systematic quality
3. **Invisible Orchestration**: Routing complexity hidden from users while maintaining deterministic execution
4. **Type-Safe Composition**: Strong typing throughout with runtime validation for robustness
5. **Graceful Degradation**: System continues operating with reduced capability rather than failing completely

### Key Architectural Patterns

- **Event Sourcing**: State derived from event stream for auditability and recovery
- **Repository Pattern**: Clean separation between business logic and persistence
- **Builder Pattern**: Complex object construction with fluent interfaces
- **Strategy Pattern**: Unified execution through ReasonActLoop
- **Observer Pattern**: Event-driven communication between components
- **State Machine**: Deterministic phase transitions and workflow control

## System Capabilities

### Multi-Agent Orchestration
- Parallel and sequential agent execution
- Dynamic agent selection based on capabilities
- Automatic handoff and context preservation
- Conflict resolution for shared resources

### Quality Assurance
- Mandatory verification phase after execution
- Automated testing from user perspective
- Documentation updates in chores phase
- Learning capture in reflection phase

### Resilience and Recovery
- Crash recovery through event reconstruction
- Atomic state persistence with rollback
- Automatic retry with exponential backoff
- Self-correcting routing behavior

### Performance Optimization
- Streaming responses for real-time feedback
- Parallel tool execution
- Intelligent caching strategies
- Memory-efficient state management

## Integration Points

### External Systems
- **Nostr Protocol**: Decentralized communication layer
- **Multiple LLM Providers**: OpenAI, Anthropic, Google, etc.
- **MCP Servers**: Dynamic tool integration
- **File System**: Project access and persistence
- **Git**: Version control integration

### Internal Interfaces
- Clean boundaries between subsystems
- Well-defined contracts and interfaces
- Consistent error handling patterns
- Unified logging and tracing

## Development Guidelines

### Adding New Components

1. **New Agents**: Implement Agent interface, register in project context
2. **New Tools**: Create tool definition, add to registry, assign to agents
3. **New Execution Logic**: Modify the ReasonActLoop implementation if needed
4. **New Phases**: Update phase definitions, transition rules, and constraints

### Best Practices

- Always maintain type safety with proper validation
- Include comprehensive error handling and recovery
- Add tracing context for observability
- Write deterministic, testable code
- Document architectural decisions and trade-offs

## Known Limitations

1. **Scale**: Single-node architecture limits horizontal scaling
2. **Context Windows**: LLM token limits constrain conversation length
3. **State Size**: Large conversations impact memory and performance
4. **Network Dependency**: Requires reliable connection to Nostr relays
5. **Tool Isolation**: Limited sandboxing for tool execution

## Future Directions

### Planned Enhancements
- Distributed state management across nodes
- Advanced caching and performance optimizations
- Enhanced security and sandboxing
- Real-time collaboration features
- Plugin architecture for extensibility

### Research Areas
- Multi-model ensemble execution
- Automatic tool generation from specifications
- Cross-conversation knowledge graphs
- Predictive routing optimization
- Self-improving prompt generation

## Getting Started

To understand the system architecture:

1. Start with [Workflow Management](./workflow-management-architecture.md) for the high-level overview
2. Read [Agent Execution](./agent-execution-architecture.md) to understand agent operations
3. Explore [Phase Management](./phase-management-architecture.md) for workflow control
4. Study [Tool System](./tool-system-architecture.md) for capability implementation
5. Review [Event-Driven Architecture](./event-driven-architecture.md) for communication patterns

## Contributing

When contributing to the architecture:

1. Maintain consistency with existing patterns
2. Update relevant documentation
3. Consider backward compatibility
4. Add appropriate tests
5. Include tracing and error handling

## Questions and Support

For architectural questions or clarifications:
- Review the "Questions and Uncertainties" sections in each document
- Consult the implementation code for definitive behavior
- Engage with the development team for design decisions

---

*This documentation represents the current state of the TENEX backend architecture. As the system evolves, these documents will be updated to reflect changes and improvements.*