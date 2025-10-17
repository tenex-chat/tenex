# TENEX Architecture Documentation - Complete Index

## Overview

This directory contains comprehensive architectural analysis of the TENEX multi-agent orchestration system. These documents provide a complete understanding of how the system currently works and identify areas for improvement.

## Documents Included

### 1. ANALYSIS_SUMMARY.md (8 KB)
**Start here for quick understanding**
- Executive summary of all findings
- Key findings on 6 architectural topics
- Critical constraints and design decisions
- Quick reference links
- Recommended next steps

**When to read**: First stop for understanding the big picture

---

### 2. ARCHITECTURE_ANALYSIS.md (18 KB)
**Comprehensive deep dive (11 sections)**

| Section | Focus | Key Content |
|---------|-------|-------------|
| 1. tenex project run | Entry point flow | 8-step initialization process |
| 2. Event routing | Subscription system | 5 concurrent NDK subscriptions |
| 3. Project context | State management | ProjectContext singleton pattern |
| 4. Multiple projects | Process model | Process-per-project architecture |
| 5. Daemon/Projects/Agents | Relationships | Hierarchical data flow |
| 6. 24010 events | Status publishing | Ephemeral status event contents |
| 7. Agent execution | LLM operations | AgentExecutor with streaming |
| 8. Components | System overview | Storage, singletons, services |
| 9. Unified approach | Improvement areas | Current limitations & solutions |
| 10. Dependencies | Constraints | NDK, PM identification, ordering |
| 11. Next steps | Roadmap | Phase 1-3 implementation plan |

**When to read**: Deep understanding needed, debugging architecture issues

---

### 3. ARCHITECTURE_DIAGRAMS.md (15 KB)
**Visual ASCII diagrams (6 diagrams)**

| Diagram | Purpose | Key Insight |
|---------|---------|-------------|
| 1. Multi-process architecture | System overview | Parent daemon spawning child processes |
| 2. Event processing pipeline | Data flow | 7-step event to execution pipeline |
| 3. ProjectContext initialization | State creation | 3-step context setup process |
| 4. Kind 24010 event structure | Event format | Status event tags and contents |
| 5. Daemon command flow | Daemon startup | Initialization sequence |
| 6. Current vs Proposed | Comparison | Multi-process vs unified daemon |

**When to read**: Visual understanding needed, architectural decisions

---

### 4. ARCHITECTURE_CODE_REFERENCE.md (11 KB)
**Detailed code location reference**

| Section | Purpose |
|---------|---------|
| Entry Points | File locations for CLI commands |
| Core Components | Daemon components with line counts |
| Event Handling Pipeline | Event routing components |
| Agent Management | AgentRegistry, execution, types |
| Project Context | ProjectContext and services |
| Conversations | Conversation management |
| LLM & Operations | LLM services and tracking |
| Nostr Integration | NDK integration points |
| Storage | Persistence layers |
| Tool System | Tool registry and implementations |
| Data Flow Entry Points | 3 critical data flow chains |
| Key Constants | Event kinds and service constants |
| Service Initialization Order | 11 steps for "project run", 7 for daemon |
| File Organization | Directory responsibility map |

**When to read**: Finding code locations, understanding module organization

---

## Quick Navigation

### By Use Case

**Understanding System Architecture**
1. Start: ANALYSIS_SUMMARY.md
2. Diagrams: ARCHITECTURE_DIAGRAMS.md (diagram 1)
3. Details: ARCHITECTURE_ANALYSIS.md (sections 1-7)

**Implementing Changes**
1. Constraints: ARCHITECTURE_ANALYSIS.md (section 10)
2. Design: ARCHITECTURE_ANALYSIS.md (section 9)
3. Code Reference: ARCHITECTURE_CODE_REFERENCE.md
4. Diagrams: ARCHITECTURE_DIAGRAMS.md (diagrams 5-6)

**Debugging Event Flow**
1. Pipeline: ARCHITECTURE_DIAGRAMS.md (diagram 2)
2. Event routing: ARCHITECTURE_ANALYSIS.md (section 6)
3. Code: ARCHITECTURE_CODE_REFERENCE.md (Data Flow Entry Points)

**Multi-Project Scaling**
1. Current approach: ARCHITECTURE_ANALYSIS.md (section 4)
2. Relationships: ARCHITECTURE_ANALYSIS.md (section 5)
3. Unified design: ARCHITECTURE_ANALYSIS.md (section 9)
4. Comparison: ARCHITECTURE_DIAGRAMS.md (diagram 6)

**Understanding Agent Execution**
1. AgentRouter: ARCHITECTURE_CODE_REFERENCE.md (search "AgentRouter")
2. Execution: ARCHITECTURE_ANALYSIS.md (section 7)
3. Event handling: ARCHITECTURE_ANALYSIS.md (section 6)

---

## Key Architectural Insights

### The Three-Layer Architecture

```
Layer 1: DAEMON (Process Management)
  ↓ spawns child processes
Layer 2: PROJECT LISTENER (Event Coordination)
  ↓ routes events
Layer 3: AGENT EXECUTION (LLM Operations)
  ↓ publishes responses
```

### The Event Journey

```
Nostr Network
  ↓
EventMonitor (daemon)
  ↓
ProcessManager (spawn if needed)
  ↓
SubscriptionManager (5 subscriptions)
  ↓
EventHandler (route by kind)
  ↓
AgentRouter (select agents)
  ↓
AgentExecutor (LLM call)
  ↓
AgentPublisher (back to Nostr)
```

### Critical Components by Responsibility

| Responsibility | Primary Component | File |
|----------------|-------------------|------|
| Process spawning | ProcessManager | daemon/ProcessManager.ts |
| Nostr listening | EventMonitor | daemon/EventMonitor.ts |
| Event routing | EventHandler | event-handler/index.ts |
| Agent management | AgentRegistry | agents/AgentRegistry.ts |
| Project state | ProjectContext | services/ProjectContext.ts |
| Status publishing | StatusPublisher | services/status/StatusPublisher.ts |

---

## Terminology Guide

| Term | Definition | File |
|------|-----------|------|
| **ProjectContext** | Global singleton holding project state | services/ProjectContext.ts |
| **AgentRegistry** | Per-project registry of all agents | agents/AgentRegistry.ts |
| **AgentInstance** | In-memory agent with signer and LLM | agents/types.ts |
| **SubscriptionManager** | Creates NDK subscriptions (5 concurrent) | commands/run/SubscriptionManager.ts |
| **EventHandler** | Routes events by kind | event-handler/index.ts |
| **AgentRouter** | Determines target agents for event | event-handler/AgentRouter.ts |
| **PM (Project Manager)** | First agent in project tags | services/ProjectContext.ts |
| **Conversation** | Thread of events linked by e-tags | conversations/types.ts |
| **Kind 24010** | Ephemeral status event (agents/models/tools) | services/status/StatusPublisher.ts |

---

## Document Statistics

| Document | Size | Sections | Code Examples |
|----------|------|----------|----------------|
| ANALYSIS_SUMMARY | 8 KB | 8 | 2 diagrams |
| ARCHITECTURE_ANALYSIS | 18 KB | 11 | 10+ code snippets |
| ARCHITECTURE_DIAGRAMS | 15 KB | 6 | 6 ASCII diagrams |
| ARCHITECTURE_CODE_REFERENCE | 11 KB | 18 | 30+ tables |
| **Total** | **52 KB** | **43** | **Rich visual content** |

---

## How These Documents Were Created

1. **Static Analysis**: Grep/Glob search of 69,000+ lines of TypeScript
2. **Code Reading**: Manual review of critical files
3. **Flow Tracing**: Following data from entry points to outputs
4. **Verification**: Cross-referencing components and dependencies
5. **Documentation**: Structured synthesis into 4 complementary docs

---

## For Maintenance

These documents should be updated when:

- [ ] New event kinds are added
- [ ] Subscription filters change
- [ ] ProjectContext initialization changes
- [ ] Agent execution flow changes
- [ ] Storage model changes
- [ ] New services are added
- [ ] Daemon startup sequence changes

---

## Contact & Questions

If unclear on any architectural aspect:

1. Check relevant section in ARCHITECTURE_ANALYSIS.md
2. Look up code locations in ARCHITECTURE_CODE_REFERENCE.md
3. Review visual flow in ARCHITECTURE_DIAGRAMS.md
4. Start with section 5 (Daemon/Projects/Agents relationship) for multi-project understanding

---

**Generated**: Oct 17, 2024
**Codebase Size**: 69,125 lines of TypeScript
**Analysis Coverage**: Complete architectural deep dive
