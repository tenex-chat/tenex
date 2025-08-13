# REAL Cleanup Plan

## Current State (Broken)
- Build is broken because consolidated fragments are missing
- Original redundant fragments are deleted
- Code references non-existent fragments

## What We Actually Want

### Fragments to KEEP AS-IS (they're fine):
- `phase-definitions.ts` - Shared phase definitions
- `project.ts` - Inventory context
- `project-md.ts` - PROJECT.md content
- `orchestrator-routing.ts` - Orchestrator-specific routing
- `retrieved-lessons.ts` - Lessons
- `voice-mode.ts` - TTS guidelines
- `referenced-article.ts` - Article content
- `inventory.ts` - LLM prompts for inventory generation
- `execute-task-prompt.ts` - Special CLI use case

### Fragments with Problems:
- `agentFragments.ts` - Has `if (isOrchestrator)` checks
- `available-agents.ts` - Has `if (isOrchestrator)` checks
- `phase.ts` - Phase constraints (mostly for specialists)
- `agent-completion-guidance.ts` - Only for specialists

## The RIGHT Solution

### Option 1: Two Main Fragments
```typescript
// specialist-prompt.ts - Everything a specialist needs
export const specialistPromptFragment = {
  id: "specialist-prompt",
  template: ({ agent, project, tools, mcpTools }) => `
    # Your Identity
    Your name: ${agent.name}
    Your role: ${agent.role}
    
    ${agent.instructions}
    
    ## Your Role as Domain Expert
    - You provide recommendations only
    - You cannot modify system state
    - Use complete() to hand off tasks
    
    ## Available Tools
    ${formatAllTools(tools, mcpTools)}
    
    ## Reasoning
    Use <thinking> tags before any action...
  `
}

// orchestrator-prompt.ts - Everything an orchestrator needs  
export const orchestratorPromptFragment = {
  id: "orchestrator-prompt",
  template: ({ project }) => `
    ## Project Context
    Title: ${project.title}
    
    ## Your Role
    You are an invisible message router...
    
    ## Reasoning
    Use <routing_analysis> tags...
  `
}
```

Then in systemPromptBuilder:
```typescript
if (agent.isOrchestrator) {
  builder
    .add("orchestrator-prompt", { project })
    .add("orchestrator-routing-instructions", {})
    .add("available-agents", { agents });
} else {
  builder
    .add("specialist-prompt", { agent, project, tools, mcpTools })
    .add("phase-definitions", {})
    .add("retrieved-lessons", { ... });
}
```

### Option 2: Fix Existing Fragments
Remove ALL `if (isOrchestrator)` checks from fragments and make the builder smart:

```typescript
// In systemPromptBuilder.ts
if (agent.isOrchestrator) {
  // Only add orchestrator-relevant fragments
  builder
    .add("orchestrator-identity", { ... })
    .add("orchestrator-routing-instructions", {})
    .add("orchestrator-reasoning", {});
} else {
  // Only add specialist-relevant fragments
  builder
    .add("specialist-identity", { ... })
    .add("specialist-guidelines", { ... })
    .add("specialist-tools", { ... })
    .add("specialist-reasoning", {});
}
```

## My Recommendation: Option 2

Fix the existing structure properly:
1. Create clean, single-purpose fragments with NO conditionals
2. Let systemPromptBuilder handle ALL the orchestrator vs specialist logic
3. Keep shared fragments truly shared (no agent type checks)