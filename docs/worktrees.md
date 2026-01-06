# Git Worktree Support

## Overview

TENEX agents can work in isolated git worktrees, enabling parallel development on different features without conflicts.

## Usage

### Creating a Worktree

When delegating work, specify the `branch` parameter on a delegation:

```typescript
delegate({
    delegations: [
        {
            recipient: "developer",
            prompt: "Implement the new feature",
            branch: "feature/new-thing", // Creates worktree
            phase: "implementation",     // Optional, if the agent defines phases
        }
    ]
})
```

This will:
1. Add a `branch` tag to the delegation event
2. Create a new worktree at `<projectBasePath>/.worktrees/feature_new-thing/` if needed
3. Execute the delegated agent in the worktree
4. Leave cleanup to standard git workflows (merge/remove)

### Branch Name Sanitization

Branch names with slashes are sanitized for directory names:
- `feature/new-thing` → `.worktrees/feature_new-thing/`
- `bugfix/issue/123` → `.worktrees/bugfix_issue_123/`

### Worktree Lifecycle

**Creation:**
- Automatic via `delegate` with a `branch` parameter
- Worktrees are created in `.worktrees/` subdirectory (gitignored)
- Metadata helpers exist for `~/.tenex/projects/<dTag>/worktrees.json`, but runtime tracking is not wired by default

**Cleanup:**
- Manual via git commands or merge tools
- Metadata helpers can record merged/deleted state if you wire them into tooling

### Architecture

**Directory Structure:**
```
<projectsBase>/<dTag>/            # Normal git repository (default branch checked out)
    .git/                        # Standard git directory
    .worktrees/                  # All worktrees (gitignored)
      feature_new-thing/         # feature/new-thing → feature_new-thing
        .git                     # File pointing to main .git/worktrees/
        src/
        ...
      bugfix_issue_123/          # bugfix/issue/123 → bugfix_issue_123
        .git
        src/
        ...
    .gitignore                   # Includes .worktrees automatically
    src/
    ...
```

This is a standard git repository with worktrees in a dedicated subdirectory:
- The project root has the default branch (main/master) checked out
- Feature branches live in `.worktrees/{sanitized_branch}/`
- The `.worktrees/` directory is automatically added to `.gitignore`
- All standard git commands work normally in each worktree
- Agents don't need to know implementation details - they just work in their worktree

**Event Flow:**
1. `delegate` publishes a delegation event with a `branch` tag (if provided)
2. `ExecutionContextFactory` resolves workingDirectory:
   - No branch tag → use project root
   - With branch tag → use `.worktrees/{sanitized_branch}/`
3. If the worktree does not exist, it is created on demand
4. ExecutionContext includes both projectBasePath (root) and workingDirectory (worktree)
5. Agent operates in worktree

**Metadata format (if you wire tracking helpers):**
```typescript
{
  "feature/new-thing": {
    "path": "<projectsBase>/<dTag>/.worktrees/feature_new-thing",
    "branch": "feature/new-thing",
    "createdBy": "agent-pubkey",
    "conversationId": "conversation-id",
    "parentBranch": "main",
    "createdAt": 1234567890,
    "mergedAt": null,
    "deletedAt": null
  }
}
```

## Implementation Details

See:
- `src/utils/git/worktree.ts` - Git worktree operations, sanitizeBranchName()
- `src/utils/git/initializeGitRepo.ts` - Repository initialization
- `src/utils/git/gitignore.ts` - Automatic .gitignore management
- `src/tools/implementations/delegate.ts` - Delegation branch tagging
- `src/agents/execution/ExecutionContextFactory.ts` - Working directory resolution
