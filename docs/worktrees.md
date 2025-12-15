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
    branch: "feature-new-thing"  // Creates worktree
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

**Directory Structure (Bare Repository Pattern):**
```
~/tenex/
  my-project/
    .bare/               # Bare git repository (database only)
    main/                # Worktree for main branch
      .git               # File pointing to ../.bare/worktrees/main
      src/
      ...
    feature-branch/      # Worktree for feature branch
      .git               # File pointing to ../.bare/worktrees/feature-branch
      src/
      ...
    worktrees.json       # Metadata
```

This follows the standard git bare repository pattern where:
- The `.bare/` directory contains the git database (objects, refs, etc.)
- Each branch has its own worktree directory with a `.git` file pointing to the bare repo
- All standard git commands work normally in each worktree
- Agents don't need to know about bare repos - they just work in their worktree

**Event Flow:**
1. delegate_phase adds ["branch", "name"] tag to delegation event
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
- `src/utils/worktree/metadata.ts` - Metadata tracking
- `src/tools/implementations/delegate_phase.ts` - Worktree creation
- `src/event-handler/reply.ts` - Working directory resolution
- `src/agents/execution/AgentSupervisor.ts` - Cleanup validation
