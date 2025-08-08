# Daemon and Process Management Architecture

## Executive Summary

The Daemon and Process Management system is the foundational runtime infrastructure of TENEX, enabling autonomous multi-project operation through Nostr event monitoring and intelligent process orchestration. This architecture provides the critical capability for TENEX to monitor multiple projects simultaneously, spawning dedicated project instances in response to Nostr events while maintaining process isolation and resource management.

## Table of Contents

1. [Introduction](#introduction)
2. [Core Architecture](#core-architecture)
3. [Component Deep Dive](#component-deep-dive)
4. [Event Flow and Processing](#event-flow-and-processing)
5. [Process Lifecycle Management](#process-lifecycle-management)
6. [Integration Points](#integration-points)
7. [Configuration and Initialization](#configuration-and-initialization)
8. [Security and Isolation](#security-and-isolation)
9. [Error Handling and Recovery](#error-handling-and-recovery)
10. [Performance Considerations](#performance-considerations)
11. [Deployment Patterns](#deployment-patterns)
12. [Monitoring and Observability](#monitoring-and-observability)
13. [Future Considerations](#future-considerations)
14. [Appendix: Open Questions](#appendix-open-questions)

## Introduction

### Purpose

The Daemon system serves as the runtime orchestrator for TENEX, providing:

1. **Event-Driven Activation**: Monitors Nostr network for relevant events and automatically spawns project instances
2. **Process Isolation**: Ensures each project runs in its own isolated subprocess with dedicated resources
3. **Lifecycle Management**: Handles project initialization, execution, monitoring, and cleanup
4. **Resource Optimization**: Prevents duplicate processes and manages system resources efficiently

### Architecture Philosophy

The daemon follows several key architectural principles:

- **Event-Driven Architecture**: All actions are triggered by Nostr events
- **Process Isolation**: Each project runs in complete isolation from others
- **Graceful Degradation**: Failures in one project don't affect others
- **Lazy Initialization**: Projects are only initialized when actually needed
- **Clean Separation of Concerns**: Clear boundaries between monitoring, management, and execution

## Core Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        TENEX Daemon                          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐    │
│  │   Event      │   │   Process    │   │   Project    │    │
│  │   Monitor    │──▶│   Manager    │◀──│   Manager    │    │
│  └──────────────┘   └──────────────┘   └──────────────┘    │
│         │                   │                   │            │
│         ▼                   ▼                   ▼            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    NDK Client                        │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                    │
└─────────│────────────────────────────────────────────────────┘
          │
          ▼
    Nostr Network
```

### Component Responsibilities

1. **EventMonitor** (`src/daemon/EventMonitor.ts`)
   - Subscribes to Nostr events from whitelisted pubkeys
   - Filters events for project-relevant tags
   - Triggers project spawning for unhandled events

2. **ProcessManager** (`src/daemon/ProcessManager.ts`)
   - Manages subprocess lifecycle for project instances
   - Tracks running processes and their states
   - Handles graceful and forced shutdowns
   - Prevents duplicate process spawning

3. **ProjectManager** (`src/daemon/ProjectManager.ts`)
   - Initializes new projects from Nostr events
   - Manages project configuration and structure
   - Handles git repository cloning and setup
   - Fetches and installs agent and MCP definitions

## Component Deep Dive

### EventMonitor

The EventMonitor is the entry point for all daemon activity, implementing a sophisticated event filtering and routing system.

#### Key Responsibilities

1. **Subscription Management**
   ```typescript
   async start(whitelistedPubkeys: string[]): Promise<void> {
       const filter: NDKFilter = {
           authors: whitelistedPubkeys,
           limit: 0,  // Real-time subscription
       };
       
       this.subscription = getNDK().subscribe(filter, {
           closeOnEose: false,  // Keep subscription open
           groupable: false,    // Prevent event batching
       });
   }
   ```

2. **Event Filtering**
   - Extracts project identifiers from "a" tags (NIP-33 parameterized replaceable events)
   - Validates tag format: `kind:pubkey:identifier`
   - Reconstructs naddr for project lookup

3. **Process Triggering**
   - Checks if project is already running via ProcessManager
   - Ensures project exists locally via ProjectManager
   - Spawns new process if needed

#### Event Processing Flow

```
Nostr Event Received
        │
        ▼
Extract Project Tag ("a" tag)
        │
        ▼
Parse Project Identifier
        │
        ▼
Is Project Running? ──Yes──▶ Ignore Event
        │No
        ▼
Ensure Project Exists
        │
        ▼
Spawn Project Process
```

### ProcessManager

The ProcessManager provides robust subprocess orchestration with careful lifecycle management.

#### Process Information Tracking

```typescript
interface ProcessInfo {
    process: ChildProcess;    // Node.js child process
    projectPath: string;       // Absolute path to project
    startedAt: Date;          // Process start timestamp
}
```

#### Key Features

1. **Process Spawning**
   - Uses Bun runtime for improved performance
   - Inherits stdio for direct output streaming
   - Non-detached processes for proper cleanup

2. **Health Monitoring**
   ```typescript
   async isProjectRunning(projectId: string): Promise<boolean> {
       // Uses process.kill(pid, 0) to check if process exists
       // Automatically cleans up dead process entries
   }
   ```

3. **Graceful Shutdown**
   - Sends SIGTERM for graceful shutdown
   - Waits 5 seconds for process to exit
   - Falls back to SIGKILL if necessary

4. **Resource Management**
   - Maintains Map of active processes
   - Cleans up on process exit
   - Provides running project inventory

### ProjectManager

The ProjectManager handles the complex initialization and configuration of TENEX projects.

#### Project Initialization Flow

```
Fetch Project from Nostr (NDKProject)
            │
            ▼
    Clone Repository (if URL provided)
    OR Create New Directory
            │
            ▼
    Initialize Git Repository
            │
            ▼
    Create .tenex Directory Structure
            │
            ▼
    Save Project Configuration
            │
            ▼
    Fetch and Install Agent Definitions
            │
            ▼
    Fetch and Install MCP Servers
            │
            ▼
    Load Agent Registry
            │
            ▼
    Set Project Context
            │
            ▼
    Republish Agent Profiles
            │
            ▼
    Run LLM Configuration Wizard (if needed)
```

#### Key Operations

1. **Project Data Transformation**
   ```typescript
   interface ProjectData {
       identifier: string;      // From "d" tag
       pubkey: string;         // Project owner
       naddr: string;          // Nostr address encoding
       title: string;          // Human-readable name
       description?: string;   // Project description
       repoUrl?: string;       // Git repository URL
       hashtags: string[];     // From "t" tags
       agentEventIds: string[]; // From "agent" tags
       mcpEventIds: string[];  // From "mcp" tags
   }
   ```

2. **Directory Structure**
   ```
   project-root/
   ├── .tenex/
   │   ├── config.json       # Project configuration
   │   ├── agents.json       # Agent registry
   │   ├── agents/           # Agent definitions
   │   └── mcp-servers/      # MCP server installations
   └── .gitignore           # Ensures .tenex is ignored
   ```

3. **Capability Installation**
   - Fetches agent definitions from Nostr events
   - Generates kebab-case slugs for agents
   - Installs MCP servers with dependencies
   - Maintains event ID references

## Event Flow and Processing

### Complete Event Processing Pipeline

```
1. Nostr Event Published
        │
2. NDK Subscription Receives Event
        │
3. EventMonitor.handleEvent()
        │
4. Extract "a" tag (project reference)
        │
5. Parse project identifier
        │
6. ProcessManager.isProjectRunning()
        │
        ├─Yes─▶ Drop Event (already handled)
        │
        └─No──▶ ProjectManager.ensureProjectExists()
                    │
                    ├─Exists──▶ Return project path
                    │
                    └─New─────▶ Initialize project
                                    │
                                    ▼
                        ProcessManager.spawnProjectRun()
                                    │
                                    ▼
                        Execute: bun run tenex.ts project run
                                    │
                                    ▼
                        Project instance handles events
```

### Event Tag Processing

The system processes NIP-33 parameterized replaceable event tags:

```typescript
// "a" tag format: kind:pubkey:identifier
// Example: "30078:abc123def456:my-project"

private extractProjectIdentifier(aTag: string): string | undefined {
    const parts = aTag.split(":");
    if (parts.length >= 3) {
        return parts[2];  // The identifier portion
    }
    return undefined;
}
```

## Process Lifecycle Management

### Spawn Lifecycle

```
1. Check for existing process
2. Construct CLI command
3. Spawn child process with inherited stdio
4. Register process in tracking Map
5. Attach exit and error handlers
6. Process runs independently
```

### Shutdown Lifecycle

```
1. Receive shutdown signal (SIGTERM/SIGINT/SIGHUP)
2. Stop EventMonitor subscription
3. Iterate all running processes
4. Send SIGTERM to each process
5. Wait up to 5 seconds for graceful exit
6. Force kill (SIGKILL) if still running
7. Clean up process tracking
8. Shutdown NDK connection
9. Exit daemon process
```

### Process Exit Handling

```typescript
child.on("exit", (code, signal) => {
    logger.info("Project process exited", {
        projectId: id,
        code,      // Exit code (0 = success)
        signal,    // Signal that caused exit
    });
    this.processes.delete(id);  // Clean up tracking
});
```

## Integration Points

### NDK Client Integration

The daemon integrates deeply with the NDK (Nostr Development Kit) client:

1. **Singleton Pattern**: Uses shared NDK instance via `getNDK()`
2. **Subscription Management**: Real-time event subscriptions
3. **Event Fetching**: Retrieves project and capability definitions
4. **Clean Shutdown**: Properly closes connections on exit

### Project Context Integration

The daemon initializes the ProjectContext which is used throughout TENEX:

```typescript
// ProjectManager sets up the context
setProjectContext(project: NDKProject, agents: Map<string, Agent>)

// Project run command uses the context
const projectCtx = getProjectContext();
```

### Agent Registry Integration

The ProjectManager integrates with the Agent Registry system:

1. Creates AgentRegistry instance
2. Loads agents from project
3. Ensures agent definitions are saved
4. Republishes agent profiles to Nostr

### MCP Service Integration

Projects spawned by the daemon initialize MCP services:

1. ProjectManager installs MCP servers during initialization
2. Project run command initializes mcpService
3. MCP servers are available to agents during execution

## Configuration and Initialization

### Daemon Command Options

```typescript
daemon
  .option("-w, --whitelist <pubkeys>", "Comma-separated list of whitelisted pubkeys")
  .option("-c, --config <path>", "Path to config file")
  .option("-p, --projects-path <path>", "Path to projects directory")
```

### Configuration Loading

1. **Global Configuration**: Loaded from specified path or default
2. **Whitelisted Pubkeys**: From CLI args or config file
3. **LLM Configurations**: Checked for completeness
4. **Interactive Setup**: Runs if configuration incomplete

### Project Configuration

Each project maintains its own configuration:

```typescript
interface TenexConfig {
    description?: string;
    repoUrl?: string;
    projectNaddr: string;  // Required for project identity
}
```

## Security and Isolation

### Process Isolation

1. **Separate Processes**: Each project runs in its own OS process
2. **Resource Isolation**: Memory and CPU isolated by OS
3. **Filesystem Isolation**: Each project has its own directory
4. **No Shared State**: Processes communicate only via Nostr

### Security Considerations

1. **Whitelisted Pubkeys**: Only events from trusted sources
2. **No Privilege Escalation**: Child processes inherit daemon privileges
3. **Input Validation**: Project identifiers and tags validated
4. **Git Operations**: Repository URLs should be validated

### Resource Limits

Current implementation does not enforce resource limits but considerations include:

1. **Process Count**: No limit on concurrent projects
2. **Memory Usage**: Unbounded per project
3. **CPU Usage**: No throttling implemented
4. **Disk Usage**: No quota enforcement

## Error Handling and Recovery

### Error Categories

1. **Event Processing Errors**
   ```typescript
   this.subscription.on("event", (event: NDKEvent) => {
       this.handleEvent(event).catch((error) => {
           logger.error("Error handling event", { error, event: event.id });
           // Error logged but doesn't stop monitoring
       });
   });
   ```

2. **Project Initialization Errors**
   - Git clone failures
   - Missing project definitions
   - Agent fetch failures
   - Configuration errors

3. **Process Management Errors**
   - Spawn failures
   - Unexpected exits
   - Cleanup failures

### Recovery Strategies

1. **Automatic Retry**: Events naturally retry as new events arrive
2. **Process Cleanup**: Dead processes removed from tracking
3. **Graceful Degradation**: Individual failures don't affect system
4. **Logging**: Comprehensive error logging for debugging

## Performance Considerations

### Current Performance Characteristics

1. **Event Processing**: Single-threaded event loop
2. **Process Spawning**: Sequential project initialization
3. **Memory Usage**: Grows with number of projects
4. **Network Usage**: Continuous Nostr subscription

### Optimization Opportunities

1. **Event Batching**: Could batch related events
2. **Process Pooling**: Pre-spawn processes for faster startup
3. **Caching**: Cache project definitions and capabilities
4. **Resource Limits**: Implement per-project resource quotas

### Scalability Limits

1. **Process Count**: OS-dependent process limits
2. **Memory**: Limited by system RAM
3. **File Descriptors**: Each process consumes file descriptors
4. **Network Connections**: NDK connection limits

## Deployment Patterns

### Single Daemon, Multiple Projects

```
Daemon Process
    ├── Project A Process
    ├── Project B Process
    └── Project C Process
```

**Characteristics**:
- Single point of monitoring
- Efficient resource usage
- Simple deployment

### Multi-Daemon Deployment

```
Daemon 1 (Whitelist A)
    └── Projects for User A

Daemon 2 (Whitelist B)
    └── Projects for User B
```

**Characteristics**:
- User isolation
- Independent failure domains
- Higher resource usage

### Containerized Deployment

```
Docker Container
    └── Daemon
        └── Project Processes
```

**Considerations**:
- Process management within container
- Volume mounts for project data
- Network configuration for Nostr

## Monitoring and Observability

### Current Monitoring Capabilities

1. **Structured Logging**
   - Winston logger with contextual information
   - Process lifecycle events
   - Error tracking

2. **Process Status**
   ```typescript
   getRunningProjects(): Array<{
       id: string;
       path: string;
       startedAt: Date;
   }>
   ```

3. **Event Metrics** (via logs)
   - Events received
   - Projects spawned
   - Process exits

### Monitoring Gaps

1. **Metrics Export**: No Prometheus/OpenTelemetry integration
2. **Health Checks**: No HTTP health endpoint
3. **Resource Tracking**: No per-project resource monitoring
4. **Event Latency**: No event processing time tracking

### Recommended Monitoring

1. **System Metrics**
   - Daemon uptime
   - Active project count
   - Event processing rate
   - Error rate

2. **Project Metrics**
   - Project lifespan
   - Event handling success rate
   - Resource consumption
   - Crash frequency

## Future Considerations

### Architectural Improvements

1. **Event Queue System**
   - Implement event queue for reliability
   - Support event replay
   - Handle event bursts

2. **Process Pool Management**
   - Pre-spawn processes for faster startup
   - Implement warm standby processes
   - Resource-based scaling

3. **Distributed Daemon**
   - Support daemon clustering
   - Load balancing across daemons
   - Shared state management

### Feature Enhancements

1. **Dynamic Configuration**
   - Hot reload of whitelist
   - Runtime configuration changes
   - Per-project overrides

2. **Advanced Process Management**
   - Process health checks
   - Automatic restart policies
   - Resource quotas and limits

3. **Enhanced Monitoring**
   - OpenTelemetry integration
   - Custom metrics export
   - Distributed tracing

### Security Enhancements

1. **Sandboxing**
   - Container/VM isolation per project
   - Capability-based security
   - Network isolation

2. **Rate Limiting**
   - Event processing rate limits
   - Per-pubkey quotas
   - Burst protection

## Appendix: Open Questions

Based on the analysis of the daemon system, several architectural questions remain:

### 1. Process Lifecycle Questions

**Q: What happens when a project process crashes unexpectedly?**
- Currently, the process is removed from tracking but not restarted
- Should there be automatic restart logic with backoff?
- How should persistent failures be handled?

**Q: How are long-running projects managed?**
- No timeout or resource limits currently
- Should projects have maximum lifetimes?
- How to handle memory leaks in long-running processes?

### 2. Event Handling Questions

**Q: How are event bursts handled?**
- Current system processes events sequentially
- Could overwhelm the system with many simultaneous events
- Should implement queue or rate limiting?

**Q: What about event ordering and consistency?**
- Events processed in order received, not timestamp order
- Could lead to out-of-order processing
- Should implement event ordering guarantees?

### 3. Resource Management Questions

**Q: How to prevent resource exhaustion?**
- No limits on number of concurrent projects
- Each project can consume unlimited resources
- Should implement resource quotas per project or globally?

**Q: What about disk space management?**
- Projects can clone large repositories
- No cleanup of old/unused projects
- Should implement storage quotas or cleanup policies?

### 4. Security Questions

**Q: How to validate repository URLs?**
- Currently clones any URL in project definition
- Could be security risk (malicious repos)
- Should implement URL validation or sandboxing?

**Q: What about secret management?**
- Projects may need API keys or secrets
- Currently no secure secret distribution
- Should integrate with secret management system?

### 5. Operational Questions

**Q: How to handle daemon upgrades?**
- Currently requires stopping all projects
- No zero-downtime upgrade path
- Should implement rolling upgrade capability?

**Q: What about multi-region deployment?**
- Single daemon instance model
- No geographic distribution support
- Should support distributed daemon architecture?

### 6. Performance Questions

**Q: What is the practical limit for concurrent projects?**
- Depends on system resources
- No benchmarking data available
- Should establish and document limits

**Q: How does the system perform under load?**
- No load testing performed
- Unknown behavior under stress
- Should implement load testing and profiling

---

## Conclusion

The Daemon and Process Management system provides the critical runtime infrastructure for TENEX's multi-project operation. Through careful separation of concerns between event monitoring, process management, and project initialization, the system achieves reliable autonomous operation while maintaining process isolation and resource efficiency.

The architecture successfully handles the complexity of distributed event processing, dynamic project initialization, and subprocess lifecycle management. However, several areas for improvement have been identified, particularly around resource management, monitoring, and operational capabilities.

This documentation serves as the authoritative reference for understanding and extending the daemon system, providing the foundation for future enhancements and operational deployments of TENEX.