# Git Worktree Support

## Overview

TENEX agents can work in isolated git worktrees, enabling parallel development on different features without conflicts.

## Usage

### Creating a Worktree

When delegating work, specify the `branch` parameter:

```typescript
delegate({
    delegations: [{
        recipient: "developer",
        prompt: "Implement the new feature",
        branch: "feature-new-thing",  // Creates worktree
        phase: "implementation"
    }],
    mode: "wait"
})
```

This will:
1. Create a new worktree at `~/tenex/{project}/../feature-new-thing/`
2. Create branch from your current branch
3. Track metadata (creator, conversation, timestamps)
4. Execute delegated agent in the new worktree
5. Prompt for cleanup when agent completes

### Worktree Lifecycle

**Creation:**
- Automatic via delegate_phase with branch parameter
- Worktree is sibling to main project directory
- Metadata stored in `~/tenex/{project}/worktrees.json`

**Cleanup:**
- AgentSupervisor prompts creator when task completes
- Options: MERGE, DELETE, or KEEP
- Metadata tracks merged/deleted state

### Architecture

**Directory Structure:**
```
~/tenex/
  my-project/          # Main worktree (e.g., main branch)
  feature-branch/      # Additional worktree
  another-feature/     # Another worktree
  worktrees.json       # Metadata
```

**Event Flow:**
1. delegate tool adds ["branch", "name"] tag to delegation event
2. Event handler extracts branch tag
3. Event handler resolves workingDirectory from branch
4. ExecutionContext includes both projectPath (base) and workingDirectory (worktree)
5. Agent operates in worktree

**Metadata:**
```typescript
{
  "feature-branch": {
    "path": "/Users/you/tenex/feature-branch",
    "branch": "feature-branch",
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
- `src/utils/git/initializeGitRepo.ts` - Git worktree operations
- `src/utils/git/worktree.ts` - Metadata tracking
- `src/tools/implementations/delegate.ts` - Worktree creation
- `src/event-handler/reply.ts` - Working directory resolution
- `src/agents/execution/AgentSupervisor.ts` - Cleanup validation
