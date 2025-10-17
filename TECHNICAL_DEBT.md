# TENEX Technical Debt Report

**Generated**: 2025-10-17
**Context**: Post major refactor to unified daemon architecture (commit c5b8936)

## Executive Summary

The recent refactor successfully implemented a unified daemon architecture with lazy project loading, replacing the previous process-per-project model. The context management refactoring has been completed, resolving the dual context pattern issue.

**Critical Issues**: 1 (2 resolved)
**High Priority**: 0 (2 resolved)
**Medium Priority**: 2 (2 resolved)
**Low Priority**: 0 (2 resolved)

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

### 1.2 Incomplete "project run" Command Migration ✅ RESOLVED

**Status**: RESOLVED - Documentation cleanup completed. Outdated architecture docs removed.

**Resolution**:
- Removed outdated architecture documentation files
- System now uses unified daemon architecture exclusively
- No standalone `project run` command needed

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

### 2.1 Unstaged Refactor Changes

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

### 3.1 AgentRegistry Constructor Inconsistency

**Location**: `src/agents/AgentRegistry.ts`

**Issue**: AgentRegistry constructor was changed:
- ProjectRuntime.ts:68: `new AgentRegistry(this.projectPath)` - passes projectPath
- EventRouter.ts:122: `new AgentRegistry()` - no arguments

**Impact**: Inconsistent initialization may cause bugs.

**Recommendation**: Standardize constructor signature and document when projectPath is needed.

---

### 3.2 Documentation Out of Sync ✅ RESOLVED

**Status**: RESOLVED - Outdated architecture documentation removed.

**Resolution**:
- Deleted 5 outdated root-level architecture files (ARCHITECTURE_*.md, ANALYSIS_*.md)
- Deleted 2 obsolete proposal files from docs/ folder
- Kept current documentation in documentation/ folder
- README.md and CHANGELOG.md remain accurate

**Remaining Documentation**:
- `documentation/` folder contains current architecture docs (18 files)
- `README.md` - High-level overview
- `CHANGELOG.md` - Version history

---

## 4. ARCHITECTURAL CONCERNS

### 4.1 Unclear Separation: Daemon vs ProjectRuntime

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

## 5. TESTING GAPS

### 5.1 Legacy Test Files

Test files still reference old architecture:
- `src/daemon/__tests__/EventMonitor.test.ts`
- `src/daemon/__tests__/ProcessManager.test.ts`

**Status**: These test the legacy files, not the new unified daemon.

**Recommendation**:
1. Update tests for new architecture
2. Add tests for Daemon, ProjectRuntime, EventRouter
3. Add integration tests for multi-project scenarios

---

### 5.2 No Type Safety Validation

As shown in 1.3, type checking doesn't run due to memory issues.

**Recommendation**: Fix memory issue and add type checking to CI/CD.

---

## 6. MIGRATION CHECKLIST

To complete the unified daemon refactor:

### Phase 1: Clean Up (1-2 days)
- [ ] Remove or properly deprecate `legacy-*` files
- [ ] Update or remove legacy tests
- [ ] Commit all unstaged changes with proper messages
- [ ] Fix TypeScript memory issue
- [ ] Remove unused imports and comments

### Phase 2: Architecture Polish (3-5 days)
- [ ] Document new daemon architecture clearly
- [ ] Add migration guide from old to new
- [ ] Standardize AgentRegistry constructor
- [ ] Define clear component responsibilities
- [ ] Add comprehensive tests for new architecture

### Phase 3: Documentation (1-2 days)
- [ ] Update ARCHITECTURE_ANALYSIS.md
- [ ] Update ANALYSIS_SUMMARY.md
- [ ] Add inline code documentation
- [ ] Document breaking changes
- [ ] Create troubleshooting guide

---

## 7. RISK ASSESSMENT

### High Risk Areas

1. **Type Safety** - Cannot validate types, may have hidden errors
2. **Testing** - Insufficient coverage of new architecture
3. **Documentation** - Developers may implement based on outdated docs

### Medium Risk Areas

1. **Legacy Code** - May accidentally use old code paths
2. **AgentRegistry** - Constructor inconsistency may cause bugs

### Low Risk Areas

1. **Code Style** - Minor issues
2. **Naming** - Some inconsistencies but not critical

---

## 8. RECOMMENDATIONS SUMMARY

### Immediate Actions (This Week)

1. **Commit all unstaged changes** - Don't lose work
2. **Fix TypeScript memory issue** - Blocks validation
3. **Remove or deprecate legacy files** - Prevents confusion
4. **Update architecture docs** - Critical for team alignment

### Short Term (Next 2 Weeks)

1. **Add daemon integration tests** - Validate multi-project scenarios
2. **Document component responsibilities** - Clear boundaries
3. **Standardize AgentRegistry constructor** - Clear initialization

### Long Term (Next Month)

1. **Comprehensive test coverage** - All new components
2. **Performance profiling** - Validate memory usage with many projects
3. **Migration guide** - For any external users

---

## 9. TECHNICAL DEBT METRICS

### Code Quality
- **Duplicated Logic**: Low (single context pattern, single deduplication system)
- **Code Smells**: Medium (some legacy code, missing tests)
- **Test Coverage**: Unknown (tests not updated for new architecture)
- **Documentation**: Low (out of sync with code)

### Maintainability Score: 7.5/10

**Strengths**:
- New architecture is conceptually cleaner
- Good separation of concerns
- Lazy loading implemented correctly
- **Single context management pattern (AsyncLocalStorage)**
- **No global state pollution**

**Weaknesses**:
- Legacy test files remain
- Lack of validation (type checking broken)
- Documentation debt
- AgentRegistry constructor inconsistency

---

## 10. CONCLUSION

The unified daemon refactor has made significant progress. The context management pattern has been cleaned up, removing global state pollution and simplifying to a single AsyncLocalStorage-based approach.

**Completed**:
- ✅ Single context management pattern (AsyncLocalStorage)
- ✅ Removed global state pollution
- ✅ CLI commands fixed to work with new pattern
- ✅ Single deduplication system

**Remaining Work**:
- Legacy files and tests need updating
- Documentation needs synchronization
- Type checking needs fixing
- AgentRegistry constructor needs standardization

**Priority Order**:
1. Fix type checking (unblocks validation)
2. Commit context management changes (preserve work)
3. Remove legacy files (reduce confusion)
4. Update documentation (align team)
5. Standardize AgentRegistry constructor

**Estimated Remaining Effort**: 3-5 engineering days to reach "clean" state.
