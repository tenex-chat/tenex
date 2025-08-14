# Test Suite Health Issues

**Severity:** Medium  
**Date:** 2025-08-14  
**Status:** Requires Investigation

## Summary
Multiple test failures detected in the utils module test suite that require investigation and fixing.

## Details

### Failing Tests (13 total)
1. **fetchAgentDefinition** - Agent fetching test failure
2. **formatLessonsForAgent** - Multiple formatting tests failing
3. **Logger tests** - Several logger functionality tests failing including:
   - Convenience methods
   - Agent logger creation
   - Scoped logger creation
   - Conversation flow logging

### Impact
- Test coverage metrics are unreliable
- CI/CD pipelines may fail unexpectedly
- Potential bugs in production code not caught by tests

### Recommended Actions
1. Investigate root cause of logger test failures
2. Fix mock setup for NDK-related tests (agent fetching)
3. Update lesson formatter tests to match current implementation
4. Ensure all tests run in isolation without side effects

### Technical Notes
- Tests are using bun:test framework
- Some failures appear to be mock/stub setup issues
- Logger tests may have console spy configuration problems

## Priority
Medium - Tests should be fixed but application still builds and core functionality appears intact.