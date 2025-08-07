# TENEX Backend Service Inventory

## Overview
TENEX backend provides multi-agent AI workflow orchestration with comprehensive testing infrastructure and conversational logging capabilities.

## Core Services

### Agent Execution System (`src/agents/`)
- **Agent Registry** - Manages and loads built-in and custom agents
- **Agent Executor** - Handles agent execution with LLM integration
- **Orchestrator Workflows** - Routes tasks between specialized agents
- **Built-in Agents**: Orchestrator, Executor, Planner, Project Manager

### LLM Integration (`src/llm/`)
- **Multi-LLM Support** - Interface for various LLM providers
- **Tool Plugin System** - Extensible tool execution framework
- **Request/Response Management** - Handles LLM communications
- **Call Logging** - Comprehensive LLM interaction tracking

### Conversation Management (`src/conversations/`)
- **Conversation Manager** - Manages multi-agent conversations
- **Phase Management** - Tracks conversation phases (CHAT, PLAN, EXECUTE, etc.)
- **State Persistence** - Conversation state storage and recovery
- **Metrics Collection** - Performance and usage analytics

### Tool System (`src/tools/`)
- **Tool Registry** - Available tools for agent execution
- **Core Tools**: Shell execution, file operations, project analysis
- **Tool Executor** - Safe tool execution with validation
- **Tool Plugin Architecture** - Extensible tool framework

## Test Infrastructure

### Test Utilities (`src/test-utils/`)
- **🎭 Conversational Logger** - Transforms raw JSON test output into natural dialog format
  - Emojis and visual formatting for easy scanning
  - Timing information and phase transitions
  - Natural language tool execution descriptions
  - Agent reasoning and decision-making visualization
- **Mock LLM Service** - Deterministic E2E testing with scenario support
- **Mock Factories** - Common object creation for tests  
- **Test Persistence Adapter** - In-memory storage for testing
- **E2E Test Harness** - Complete test environment setup
- **Conversational Setup Helpers** - Easy conversational logging integration

### E2E Test Coverage
- **Agent Error Recovery** - Multi-agent error handling scenarios
- **Orchestrator Workflows** - Complete CHAT→PLAN→EXECUTE→VERIFICATION flows
- **Concurrency Testing** - Multiple conversation handling
- **Performance Testing** - Timeout and resource management
- **State Persistence** - Conversation recovery and consistency

## Infrastructure

### Configuration (`src/services/`)
- **Config Service** - Environment and runtime configuration
- **Project Context** - Project-specific settings and state
- **MCP Service** - Model Context Protocol integration

### Logging & Tracing (`src/logging/`, `src/tracing/`)
- **Execution Logger** - Structured agent execution logging
- **Tracing Context** - Request/conversation tracing
- **Performance Monitoring** - Execution time and resource tracking

### Nostr Integration (`src/nostr/`)
- **NDK Client** - Nostr protocol integration
- **Event Publishing** - Agent responses and state updates
- **Network Resilience** - Connection management and retry logic

## Development Tools

### Conversational Test Output
Enable natural dialog-style test output with:
```bash
DEBUG=true bun test ./tests/e2e/
```

This transforms raw JSON:
```json
MockLLM: Matched response {
  "agents": ["executor"], 
  "phase": "execute",
  "reason": "Default routing"
}
```

Into conversational format:
```
🎯 [0s] Orchestrator: "I'll route this to executor in execute phase - Default routing"
🤔 [0s] Executor is thinking...
🔄 [1s] Executor: "Passing control to planner - task completed"
```

### Test Scenarios
- **Routing Decisions** - Orchestrator routing logic testing
- **Error Recovery** - Tool failure and recovery scenarios
- **Workflow Integration** - End-to-end agent coordination
- **Performance Benchmarks** - Timeout and resource limits

## Deployment

### Port Usage
- Development server typically runs on port 3000
- Test environments use dynamic port allocation
- Production deployment configured via environment variables

### Environment Variables
- `DEBUG=true` - Enables conversational test logging
- `NODE_ENV` - Development/production environment
- LLM provider configurations (API keys, endpoints)

## Recent Additions
- **PHASES Constants Refactor** (2025-01-07) - Centralized phase constants to prevent inline string usage
  - Updated all files to use `PHASES.EXECUTE` instead of `"execute"` strings
  - Enhanced type safety and maintainability across orchestrator, agents, and tools
  - Improved consistency in phase references throughout the codebase
- **Conversational Logger** (2025-01-07) - Natural dialog test output format
- **Enhanced E2E Testing** - Comprehensive multi-agent workflow coverage
- **Mock LLM Improvements** - Better scenario matching and context tracking
- **Test Infrastructure Overhaul** - Improved reliability and debugging experience
