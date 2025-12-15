# Git Worktree Support

## Overview

TENEX agents can work in isolated git worktrees, enabling parallel development on different features without conflicts.

## Usage

### Creating a Worktree

When delegating work to a phase, specify the `branch` parameter:

```typescript
delegate_phase({
    phase: "implementation",
    recipients: ["developer"],
    prompt: "Implement the new feature",
    branch: "feature/new-thing"  // Creates worktree
})
```

This will:
1. Create a new worktree at `~/tenex/{project}/.worktrees/feature_new-thing/`
2. Create branch from your current branch
3. Track metadata (creator, conversation, timestamps)
4. Execute delegated agent in the new worktree
5. Prompt for cleanup when agent completes

### Branch Name Sanitization

Branch names with slashes are sanitized for directory names:
- `feature/new-thing` → `.worktrees/feature_new-thing/`
- `bugfix/issue/123` → `.worktrees/bugfix_issue_123/`

### Worktree Lifecycle

**Creation:**
- Automatic via delegate_phase with branch parameter
- Worktrees are created in `.worktrees/` subdirectory (gitignored)
- Metadata stored in `~/tenex/{project}/worktrees.json`

**Cleanup:**
- AgentSupervisor prompts creator when task completes
- Options: MERGE, DELETE, or KEEP
- Metadata tracks merged/deleted state

### Architecture

**Directory Structure:**
```
~/tenex/
  my-project/                    # Normal git repository (default branch checked out)
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
    worktrees.json               # Metadata
```

This is a standard git repository with worktrees in a dedicated subdirectory:
- The project root has the default branch (main/master) checked out
- Feature branches live in `.worktrees/{sanitized_branch}/`
- The `.worktrees/` directory is automatically added to `.gitignore`
- All standard git commands work normally in each worktree
- Agents don't need to know implementation details - they just work in their worktree

**Event Flow:**
1. delegate_phase adds ["branch", "name"] tag to delegation event
2. Event handler extracts branch tag
3. ExecutionContextFactory resolves workingDirectory:
   - No branch tag → use project root
   - With branch tag → use `.worktrees/{sanitized_branch}/`
4. ExecutionContext includes both projectBasePath (root) and workingDirectory (worktree)
5. Agent operates in worktree

**Metadata:**
```typescript
{
  "feature/new-thing": {
    "path": "/Users/you/tenex/my-project/.worktrees/feature_new-thing",
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
- `src/tools/implementations/delegate_phase.ts` - Worktree creation
- `src/agents/execution/ExecutionContextFactory.ts` - Working directory resolution
- `src/agents/execution/AgentSupervisor.ts` - Cleanup validation
