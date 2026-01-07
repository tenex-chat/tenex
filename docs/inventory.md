# Modules:
* AgentSystem: Manages the lifecycle, loading, registry, and execution of AI agents.
* ToolSystem: Centralized registry and factory for creating AI SDK-compatible tools, including dynamic and MCP tools.
* ConversationSystem: Manages conversation state, persistence, message routing, and RAL (Reason-Act Loop) cycles.
* NostrIntegration: Handles all Nostr protocol interactions, event encoding/decoding, and publishing.
* ProjectManagement: Manages project context, including agent assignments, reports, and lessons learned.
* ReportSystem: Handles creation, reading, and listing of NDKArticle reports for documentation and knowledge sharing.
* ConfigService: Manages global and project-specific configurations.
* Monitoring: Provides telemetry and tracing capabilities using OpenTelemetry and Jaeger.

# Relationships
* AgentSystem depends on NostrIntegration for communication and persistence.
* AgentSystem depends on ToolSystem for agent capabilities.
* ConversationSystem depends on AgentSystem for agent identity and execution context.
* ConversationSystem depends on NostrIntegration for message transport and storage.
* ProjectManagement acts as the root context, holding references to AgentRegistry, MCPManager, and other core services.
* ReportSystem integrates with ProjectManagement to associate reports with projects and agents.

# Technologies
* Nostr (NDK): The backbone communication and storage layer.
* AI SDK (Vercel): Used format for tools and LLM interactions.
* OpenTelemetry / Jaeger: For distributed tracing and debugging.
* TypeScript / Node.js: Core runtime environment.

# Organization
* The project follows a service-oriented architecture where core functionalities are encapsulated in services (e.g., `DynamicToolService`, `ReportService`, `RALRegistry`).
* `ProjectContext` serves as a central hub for accessing these services within the context of a running project.
* Agents are first-class citizens, defined by NDK events and loaded into an in-memory `AgentRegistry`.
* Conversations are event streams on Nostr, but state is locally managed and cached by `ConversationStore`.
* The `RAL` (Reason-Act Loop) pattern is central to agent execution, managing the cycle of thought, action, and observation.

# High-complexity modules

## RALRegistry (Reason-Act Loop)
Manages the state of agent executions. It handles the "Reason-Act Loop," ensuring that only one execution cycle is active per agent per conversation at a time. It manages delegation tracking (pending and completed delegations), injection of messages (user or system) into running loops, and maintains the state of execution (e.g., streaming status, abort controllers). It is critical for the correct sequencing of agent behaviors and the reliability of the conversation flow.

## ConversationStore
Serves as the single source of truth for conversation state. It persists messages to disk (JSON), hydrates from Nostr events, and manages the structure of the conversation, including metadata, phases, and todo lists. It handles the complexity of deriving message roles (user vs. assistant), formatting messages with attribution (e.g., `[@sender -> @recipient]`), and filtering messages based on RAL cycles to present the correct context to the LLM.

## DynamicToolService
Enables the system to load and reload tools at runtime without restarting. It watches a specific directory for changes, compiles/loads TypeScript tool definitions on the fly, and exposes them to the agent system. This allows for rapid iteration on tools and the addition of new capabilities dynamically. It handles file watching, debouncing, and secure loading of tool code.

## MCPManager
Integrates the Model Context Protocol (MCP) to allow agents to use external tools exposed by MCP servers. It manages the lifecycle of MCP clients, discovers tools and resources from connected servers, and bridges them into the internal tool system. This creates an extensible architecture where the agent's capabilities can expand beyond the core codebase.

## AgentPublisher & Event Encoding
Abstracts the complexity of the Nostr protocol. It handles the encoding of high-level agent intents (completion, delegation, tool use, error) into specific Nostr event structures (tags, content formats). It ensures that all events are properly signed, traced (OpenTelemetry context injection), and linked to the correct conversation and project contexts. This module hides the low-level details of NIPs from the rest of the application logic.
