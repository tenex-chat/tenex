# Critical Issue: Bun Module Mocking Limitations

**Date**: January 2, 2025  
**Severity**: High  
**Impact**: Testing Infrastructure

## Problem

The current testing infrastructure faces significant challenges with Bun's module mocking capabilities, particularly when testing components with complex dependency chains like `ProjectManager` and `ProcessManager`.

### Specific Issues

1. **Module Mock Order Dependency**
   - Mocks must be defined before any imports that use them
   - This creates issues with complex dependency chains
   - Example: `ProjectManager` imports `child_process` indirectly through multiple layers

2. **Promisify Pattern Incompatibility**
   - Node's `util.promisify` doesn't work well with Bun's mock system
   - Async functions created via promisify bypass mock implementations
   - This affects testing of git operations, file system operations, etc.

3. **Deep Dependency Mocking**
   - Components like `AgentRegistry`, `ConfigService` have deep import chains
   - Mocking these requires mocking entire dependency trees
   - This makes tests brittle and hard to maintain

### Failed Attempts

1. Tried mocking `node:child_process` module - bypassed by promisify
2. Tried mocking `node:util` promisify - didn't intercept actual calls
3. Tried spying on global exec - not accessible in module scope

### Impact on Testing

- Cannot properly test git clone operations in ProjectManager
- Cannot test concurrent access scenarios reliably
- Cannot isolate external command execution
- Reduces confidence in error handling paths

## Proposed Solutions

### Short Term (Recommended)

1. **Create Test Doubles**
   ```typescript
   // Create injectable dependencies
   interface IGitOperations {
     clone(url: string, path: string): Promise<void>;
     init(path: string): Promise<void>;
   }
   
   // Inject into ProjectManager constructor
   constructor(
     projectsPath?: string,
     private gitOps: IGitOperations = new GitOperations()
   ) {}
   ```

2. **Use Environment-Based Testing**
   - Create actual test repositories for integration tests
   - Use temp directories with real git operations
   - Skip unit tests that require complex mocking

3. **Separate Integration Tests**
   - Move tests requiring real external operations to integration suite
   - Use Docker containers for isolated testing environments
   - Accept longer test execution times for thorough coverage

### Long Term

1. **Migrate to Vitest**
   - Better module mocking support
   - Compatible with most Bun features
   - More mature mocking ecosystem

2. **Refactor for Testability**
   - Extract all external operations into injectable services
   - Use dependency injection consistently
   - Avoid direct module imports for external operations

3. **Abstract External Operations**
   - Create abstraction layer for all file system operations
   - Create abstraction layer for all process operations
   - Make these swappable at runtime

## Recommendation

For immediate progress, implement injectable dependencies for critical components:

1. Extract git operations into `GitService`
2. Extract file operations into enhanced `FileSystemService`
3. Make these services injectable into components
4. Create simple in-memory implementations for testing

This approach will:
- Improve testability immediately
- Not require major refactoring
- Allow gradual migration
- Maintain backward compatibility

## Example Implementation

```typescript
// services/git/GitService.ts
export interface IGitService {
  clone(url: string, dest: string): Promise<void>;
  init(path: string): Promise<void>;
  // ... other git operations
}

export class GitService implements IGitService {
  async clone(url: string, dest: string): Promise<void> {
    const { stdout, stderr } = await execAsync(`git clone "${url}" "${dest}"`);
    // ... implementation
  }
}

// In tests
class MockGitService implements IGitService {
  async clone(url: string, dest: string): Promise<void> {
    // Mock implementation
  }
}

const projectManager = new ProjectManager(
  tempDir,
  new MockGitService()
);
```

## Action Items

1. Refactor ProjectManager to use injectable GitService
2. Refactor ProcessManager to use injectable ProcessService
3. Update tests to use mock implementations
4. Document testing patterns for other developers
5. Consider long-term migration strategy