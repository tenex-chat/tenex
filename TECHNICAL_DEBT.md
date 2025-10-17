# TENEX Technical Debt Report

**Generated**: 2025-10-17
**Context**: Post major refactor to unified daemon architecture (commit c5b8936)

## Executive Summary

The recent refactor successfully implemented a unified daemon architecture with lazy project loading, replacing the previous process-per-project model. However, the migration is **incomplete** and has introduced several categories of technical debt that need attention.

**Critical Issues**: 3
**High Priority**: 2
**Medium Priority**: 4
**Low Priority**: 2

---

## 1. CRITICAL ISSUES

### 1.1 Legacy Files Not Removed or Properly Deprecated

**Location**: `src/daemon/`

**Issue**: The refactor renamed old files to `legacy-*` prefix but these files are still in the codebase:
- `src/daemon/legacy-EventMonitor.ts` (was `EventMonitor.ts`)
- `src/daemon/legacy-ProcessManager.ts` (was `ProcessManager.ts`)

**Impact**:
- Confuses developers about which files to use
- Tests still reference old files (`src/daemon/__tests__/EventMonitor.test.ts`, `src/daemon/__tests__/ProcessManager.test.ts`)
- Increases codebase size unnecessarily

**Files affected**:
- `src/daemon/legacy-EventMonitor.ts`
- `src/daemon/legacy-ProcessManager.ts`
- `src/daemon/__tests__/EventMonitor.test.ts`
- `src/daemon/__tests__/EventMonitor.ndk.test.ts`
- `src/daemon/__tests__/ProcessManager.test.ts`

**Recommendation**:
Either completely remove legacy files or document them as deprecated with a clear migration path. If tests depend on them, update tests first.

---

### 1.2 Incomplete "project run" Command Migration

**Location**: The `tenex project run` command appears to have been removed but there's no clear replacement.

**Evidence**:
- Git status shows `src/commands/project/run.ts` deleted
- No import references to `project run` command exist
- ARCHITECTURE_ANALYSIS.md still documents `tenex project run` as a key entry point (lines 13-64)

**Impact**:
- Developers can't run single projects standalone for testing
- Documentation is out of sync with reality
- Loss of backwards compatibility

**Recommendation**:
Decision needed:
1. Keep `project run` for testing/debugging single projects
2. Or fully commit to daemon-only mode and update all docs

---

### 1.3 TypeScript Compilation Memory Issues

**Issue**: Running `npx tsc --noEmit` results in heap out of memory error.

**Evidence**:
```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

**Impact**:
- Cannot validate types across codebase
- May indicate circular dependencies or type explosion
- Blocks CI/CD type checking

**Recommendation**:
1. Increase Node heap size in package.json scripts: `NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit`
2. Investigate potential circular imports or complex type recursion
3. Consider splitting tsconfig for incremental builds

---

## 2. HIGH PRIORITY ISSUES

### 2.1 Dual Context Management Pattern

**Location**: `src/services/ProjectContext.ts` and `src/daemon/ProjectContextManager.ts`

**Issue**: The codebase now has TWO ways to access project context:
1. **Global singleton** (`setProjectContext()` / `getProjectContext()`) - legacy
2. **AsyncLocalStorage** via `projectContextStore` - new unified daemon approach
3. **ProjectContextManager** - manages multiple contexts

**Evidence** (ProjectContext.ts:296-310):
```typescript
export function getProjectContext(): ProjectContext {
  // First try to get from AsyncLocalStorage (daemon mode)
  const asyncContext = projectContextStore.getContext();
  if (asyncContext) {
    return asyncContext;
  }

  // Fallback to global variable (single project mode)
  if (!projectContext) {
    throw new Error(
      "ProjectContext not initialized..."
    );
  }
  return projectContext;
}
```

**Impact**:
- Confusing for developers - which pattern to use?
- Potential bugs from mixing patterns
- Hard to reason about which context is active
- Global state pollution (ProjectContextManager.ts:102 sets `global.projectContext`)

**Recommendation**:
1. Choose one pattern (recommend AsyncLocalStorage for multi-project support)
2. Deprecate global singleton pattern
3. Update all call sites to use new pattern
4. Remove `global.projectContext` hack

---

### 2.2 Unstaged Refactor Changes

**Status**: Multiple critical files have modifications but aren't committed:

```
M src/agents/AgentRegistry.ts
M src/commands/daemon.ts
M src/commands/debug/index.ts
M src/commands/mcp/server.ts
M src/conversations/services/ConversationCoordinator.ts
M src/services/ProjectContext.ts
M src/test-utils/e2e-setup.ts
```

**Impact**:
- Unclear what changes belong to the refactor
- Risk of losing work
- Difficult to review changes

**Recommendation**: Commit these changes immediately or stash them if they're experimental.

---

## 3. MEDIUM PRIORITY ISSUES

### 3.1 EventRouter Context Switching Pattern

**Location**: `src/daemon/EventRouter.ts:274`

**Issue**: Manual context switching for each event:
```typescript
this.projectManager.switchContext(projectId);
```

**Concern**:
- Prone to race conditions if multiple events arrive simultaneously
- No clear guarantee that context is properly isolated
- Mixing global state with AsyncLocalStorage

**Recommendation**:
Fully commit to AsyncLocalStorage pattern wrapped in `projectContextStore.run()` calls instead of manual switching.

---

### 3.2 Processed Events Deduplication (✅ RESOLVED)

**Status**: FIXED - Legacy system removed

**Solution Implemented**:
- Removed legacy `src/commands/run/processedEventTracking.ts`
- Removed legacy `src/commands/run/SubscriptionManager.ts`
- Removed root-level `.tenex/processed-events.json`
- EventRouter now sole authority for per-project deduplication
- Location: `.tenex/projects/{projectId}/processed-events.json`
- Features: Debounced persistence (5s), 10k event limit per project

---

### 3.3 AgentRegistry Constructor Inconsistency

**Location**: `src/agents/AgentRegistry.ts`

**Issue**: AgentRegistry constructor was changed:
- ProjectRuntime.ts:68: `new AgentRegistry(this.projectPath)` - passes projectPath
- EventRouter.ts:122: `new AgentRegistry()` - no arguments

**Impact**: Inconsistent initialization may cause bugs.

**Recommendation**: Standardize constructor signature and document when projectPath is needed.

---

### 3.4 Documentation Out of Sync

**Files**:
- `ARCHITECTURE_ANALYSIS.md` - Documents old "project run" architecture extensively
- `ANALYSIS_SUMMARY.md` - References removed components

**Impact**:
- New developers will be confused
- Architecture decisions can't be traced
- Migration path unclear

**Recommendation**:
1. Update architecture docs to reflect unified daemon
2. Add migration guide from old to new architecture
3. Document which features were preserved vs removed

---

## 4. LOW PRIORITY ISSUES

### 4.1 Unused Imports in Debug Command

**Location**: `src/commands/debug/index.ts:10`

```typescript
// import { ensureProjectInitialized } from "@/utils/projectInitialization";  // Removed - using daemon
```

**Recommendation**: Remove commented-out imports.

---

### 4.2 Global Type Pollution

**Location**: `src/daemon/ProjectContextManager.ts:102, 171`

```typescript
(global as any).projectContext = context;
```

**Issue**: Using global object for backwards compatibility is a code smell.

**Recommendation**: Deprecate this pattern in favor of proper dependency injection.

---

## 5. ARCHITECTURAL CONCERNS

### 5.1 Mixed Singleton Patterns

The codebase has multiple singleton patterns:
- **Module-level variables**: `projectContext` in ProjectContext.ts
- **getInstance() pattern**: `SchedulerService.getInstance()`
- **getDaemon() pattern**: Creates on first call
- **Global object pollution**: `(global as any).projectContext`

**Recommendation**: Standardize on one pattern (preferably dependency injection or proper singleton class).

---

### 5.2 Unclear Separation: Daemon vs ProjectRuntime

**Issue**: Responsibilities between Daemon, ProjectRuntime, and EventRouter overlap:
- Who owns lifecycle management?
- Who handles subscriptions?
- Who manages context switching?

**Evidence**:
- Daemon has `handleIncomingEvent()` but delegates to runtime
- ProjectRuntime has inactivity timer but Daemon tracks runtimes
- EventRouter also manages contexts

**Recommendation**: Create clear responsibility boundaries with documentation.

---

## 6. TESTING GAPS

### 6.1 Legacy Test Files

Test files still reference old architecture:
- `src/daemon/__tests__/EventMonitor.test.ts`
- `src/daemon/__tests__/ProcessManager.test.ts`

**Status**: These test the legacy files, not the new unified daemon.

**Recommendation**:
1. Update tests for new architecture
2. Add tests for Daemon, ProjectRuntime, EventRouter
3. Add integration tests for multi-project scenarios

---

### 6.2 No Type Safety Validation

As shown in 1.3, type checking doesn't run due to memory issues.

**Recommendation**: Fix memory issue and add type checking to CI/CD.

---

## 7. MIGRATION CHECKLIST

To complete the unified daemon refactor:

### Phase 1: Clean Up (1-2 days)
- [ ] Remove or properly deprecate `legacy-*` files
- [ ] Update or remove legacy tests
- [ ] Commit all unstaged changes with proper messages
- [ ] Fix TypeScript memory issue
- [ ] Remove unused imports and comments

### Phase 2: Fix Critical Bugs (2-3 days)
- [ ] Resolve dual context management pattern
- [ ] Standardize AgentRegistry constructor

### Phase 3: Architecture Polish (3-5 days)
- [ ] Document new daemon architecture clearly
- [ ] Add migration guide from old to new
- [ ] Standardize singleton patterns
- [ ] Remove global object pollution
- [ ] Define clear component responsibilities
- [ ] Add comprehensive tests for new architecture

### Phase 4: Documentation (1-2 days)
- [ ] Update ARCHITECTURE_ANALYSIS.md
- [ ] Update ANALYSIS_SUMMARY.md
- [ ] Add inline code documentation
- [ ] Document breaking changes
- [ ] Create troubleshooting guide

---

## 8. RISK ASSESSMENT

### High Risk Areas

1. **Context Management** - Multiple patterns may cause subtle bugs in production
2. **Event Deduplication** - Unclear which system is active
3. **Type Safety** - Cannot validate types, may have hidden errors

### Medium Risk Areas

1. **Legacy Code** - May accidentally use old code paths
2. **Testing** - Insufficient coverage of new architecture
3. **Documentation** - Developers may implement based on outdated docs

### Low Risk Areas

1. **Code Style** - Minor issues like unused imports
2. **Naming** - Some inconsistencies but not critical

---

## 9. RECOMMENDATIONS SUMMARY

### Immediate Actions (This Week)

1. **Commit all unstaged changes** - Don't lose work
2. **Fix TypeScript memory issue** - Blocks validation
3. **Remove or deprecate legacy files** - Prevents confusion
4. **Update architecture docs** - Critical for team alignment

### Short Term (Next 2 Weeks)

1. **Standardize context management** - Choose one pattern
2. **Add daemon integration tests** - Validate multi-project scenarios
3. **Document component responsibilities** - Clear boundaries

### Long Term (Next Month)

1. **Refactor to dependency injection** - Remove global state
2. **Comprehensive test coverage** - All new components
3. **Performance profiling** - Validate memory usage with many projects
4. **Migration guide** - For any external users

---

## 10. TECHNICAL DEBT METRICS

### Code Quality
- **Duplicated Logic**: Medium (2 deduplication systems, 2 context patterns)
- **Code Smells**: High (global state, mixed patterns, commented code)
- **Test Coverage**: Unknown (tests not updated for new architecture)
- **Documentation**: Low (out of sync with code)

### Maintainability Score: 6/10

**Strengths**:
- New architecture is conceptually cleaner
- Good separation of concerns in theory
- Lazy loading implemented correctly

**Weaknesses**:
- Incomplete migration
- Mixed patterns confuse intent
- Lack of validation (type checking broken)
- Documentation debt

---

## 11. CONCLUSION

The unified daemon refactor represents a significant architectural improvement, moving from process-per-project to a more efficient single-process model. However, **the migration is incomplete and has accumulated technical debt that needs addressing before this architecture can be considered stable**.

**Key Takeaway**: The new code works, but coexists with legacy patterns creating confusion and potential bugs. A focused cleanup effort (1-2 weeks) would dramatically improve code quality and maintainability.

**Priority Order**:
1. Fix type checking (unblocks validation)
2. Commit unstaged changes (preserve work)
3. Remove legacy files (reduce confusion)
4. Standardize patterns (improve maintainability)
5. Update documentation (align team)

**Estimated Cleanup Effort**: 7-10 engineering days to reach "clean" state.
