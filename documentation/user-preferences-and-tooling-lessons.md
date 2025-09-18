# User Preferences and Tooling Lessons

## Overview

This document captures lessons learned from user interactions and tooling implementations within the TENEX system. These lessons help guide future development decisions and ensure consistent handling of common patterns and requirements.

## User Preference Patterns

### Development Philosophy

Users consistently prefer clean, modern code implementations without backwards compatibility concerns. Key patterns observed:

- **No Backwards Compatibility**: Users explicitly reject maintaining old interfaces or deprecated methods
- **Clean Refactoring**: Preference for breaking changes that improve code quality over maintaining compatibility
- **Direct Implementation**: Favor modifying existing code directly rather than creating wrapper layers
- **Feature-Based Organization**: Organize code by features rather than technical layers

### Code Quality Standards

- **Remove Unused Variables**: Refactor out unused variables rather than prefixing with underscore
- **No TODOs**: Implement functionality immediately rather than leaving technical debt
- **Direct Library Usage**: Use libraries like NDK directly without unnecessary abstraction layers
- **Modern Patterns Only**: Avoid legacy approaches and deprecated methods

## Tooling Implementation Lessons

### Context Separation: Exclude Active Thread from 'Other Threads'

**Lesson**: When preparing LLM context, ensure the active conversation thread is explicitly filtered out from the list of 'other' or 'related' threads to prevent context duplication.

**Context**: The ThreadWithMemoryStrategy was sending the same thread to the LLM twice: once as the active thread and again within the 'other threads' block. This was caused by failing to exclude the active thread's root ID from the collection of 'other threads' before formatting.

**Implementation Pattern**:
```typescript
// Filter out the active thread from other threads before formatting
const otherThreads = allThreads.filter(thread => 
  thread.rootEventId !== activeThreadRootId
);
```

**Category**: Architecture

**Tags**: `context-management`, `llm-prompting`, `bug-fix`

**Files Affected**: `src/agents/execution/strategies/ThreadWithMemoryStrategy.ts`

**Impact**: Prevents redundant context in LLM prompts, keeps context clean and focused, and avoids confusion from duplicate thread information.

### Nostr URI Parsing (`report_read` tool)

**Lesson**: When parsing Nostr URIs in the format `nostr:naddr1...`, extract the `naddr1...` portion for proper processing.

**Context**: The `report_read` tool needs to handle both direct `naddr1` identifiers and full `nostr:` URIs. Users may provide either format.

**Implementation Pattern**:
```typescript
// Extract naddr1 from nostr: URI if present
const naddr = nostrUri.startsWith('nostr:') 
  ? nostrUri.substring(6) 
  : nostrUri;
```

**Files Affected**: `src/tools/implementations/report_read.ts`

**Impact**: Ensures consistent handling of Nostr entity references regardless of user input format.

### Task Scheduling System Integration

**Lesson**: Task scheduling should integrate seamlessly with existing agent workflows and phase management.

**Context**: The task scheduling system was implemented with careful consideration for:
- Integration with existing agent execution patterns
- Proper error handling and validation
- Clear separation of concerns between scheduling and execution
- Consistent tool interface patterns

**Key Components**:
- `schedule_task.ts` - Create scheduled tasks
- `schedule_task_cancel.ts` - Cancel existing tasks  
- `schedule_tasks_list.ts` - List scheduled tasks
- `SchedulerService.ts` - Core scheduling logic

**Best Practices**:
- Use existing validation patterns from other tools
- Maintain consistent error messaging
- Follow established tool parameter naming conventions
- Integrate with existing logging and monitoring systems

### Phase Management Consistency

**Lesson**: Tool implementations should respect the current phase context and workflow state.

**Context**: Tools like `phase_remove.ts` need to integrate with the phase management system while maintaining clean interfaces.

**Implementation Considerations**:
- Respect phase transition rules
- Provide clear feedback about phase state changes
- Maintain consistency with existing phase management patterns
- Handle edge cases gracefully (e.g., removing non-existent phases)

## Nostr Integration Patterns

### Event Publishing Standards

**Lesson**: Standardize tag key prefixes for consistency across the codebase.

**Proposed Standards**:
- Use `agent-*` prefix for agent-related tags
- Document tag naming conventions clearly
- Validate tag formats at publish time
- Consider relay truncation handling for very long tags

**Files to Review**:
- `src/nostr/AgentPublisher.ts`
- Event handling and parsing code
- Tag validation utilities

### Relay Truncation Handling

**Lesson**: Some relays truncate very long tags in kind:0 (metadata) events, requiring robust handling.

**Requirements**:
- Detect when tags have been truncated
- Implement fallback strategies for complete data retrieval
- Ensure graceful degradation when complete data unavailable
- Add monitoring for truncation events

**Investigation Areas**:
- Tag length limits across different relay implementations
- Fallback mechanisms for retrieving complete metadata
- Client-side validation of tag completeness

## Tool Development Guidelines

### Parameter Validation

**Lesson**: Implement consistent validation patterns across all tools.

**Standards**:
- Use Zod schemas for parameter validation
- Provide clear error messages for invalid inputs
- Handle edge cases explicitly
- Validate required vs optional parameters consistently

### Error Handling

**Lesson**: Tools should provide informative error messages and handle failure gracefully.

**Patterns**:
- Return structured error responses
- Include context about what failed and why
- Suggest corrective actions where possible
- Log errors appropriately for debugging

### Integration Testing

**Lesson**: Tools benefit from comprehensive integration tests that cover real-world usage patterns.

**Approach**:
- Test with actual Nostr event flows
- Validate integration with NDK
- Test error conditions and edge cases
- Include performance considerations

## Architecture Decision Records

### NDK Usage Pattern

**Decision**: Use NDK directly without creating abstraction layers.

**Rationale**: 
- Users explicitly prefer direct library usage
- Reduces complexity and maintenance burden
- Avoids unnecessary type wrapping
- Maintains clear separation of concerns

**Impact**: All Nostr operations should use NDK APIs directly with minimal wrapper logic.

### Testing Strategy

**Decision**: Focus on integration tests that exercise real workflows rather than extensive unit test mocking.

**Rationale**:
- Real-world usage patterns are more valuable than isolated unit behavior
- Integration tests catch interface changes and breaking changes
- Reduces test maintenance burden
- Aligns with user preference for working implementations

## Future Considerations

### Standardization Needs

1. **Tag Key Prefixes**: Implement consistent `agent-*` prefixing across all agent-related tags
2. **URI Parsing**: Standardize Nostr URI handling patterns across tools
3. **Error Response Format**: Establish consistent error response structure
4. **Validation Patterns**: Create reusable validation utilities for common parameter types

### Monitoring and Observability

1. **Relay Performance**: Monitor tag truncation rates across different relays
2. **Tool Usage**: Track which tools are used most frequently
3. **Error Patterns**: Identify common failure modes for proactive handling
4. **Performance Metrics**: Measure tool execution times and resource usage

### Documentation Standards

1. **Tool Documentation**: Establish consistent format for documenting tool capabilities
2. **Integration Guides**: Create guides for common integration patterns
3. **Troubleshooting**: Document common issues and solutions
4. **Best Practices**: Maintain up-to-date best practice guides

## Questions for Future Investigation

1. How can we better detect and handle relay-specific limitations?
2. What metrics would be most valuable for understanding tool usage patterns?
3. How can we automate validation of tag key naming conventions?
4. What additional tooling would improve the development experience?

---

*This document should be updated as new lessons are learned and patterns emerge from user interactions and system evolution.*