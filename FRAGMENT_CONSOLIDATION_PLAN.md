# Fragment Consolidation Plan

## Current State: 20 Fragment Files, Major Overlaps

You're absolutely right - the problem isn't necessarily the builder system, but that fragments have become overly scattered and redundant. Here's what we found:

### Major Issues Identified

1. **Three fragments all saying "specialists can't modify things"**:
   - `expertise-boundaries.ts`
   - `domain-expert-guidelines.ts` 
   - `phase.ts` (phase constraints)

2. **Three separate reasoning fragments for essentially the same thing**:
   - `agent-reasoning.ts`
   - `orchestrator-reasoning.ts`
   - `expert-reasoning.ts`

3. **Two separate tool listing fragments**:
   - `agent-tools.ts`
   - `mcp-tools.ts`

4. **Unused fragment still registered**:
   - `tool-use.ts` - Never actually used in any prompt!

5. **Scattered orchestrator/specialist logic**:
   - Almost every fragment has `if (isOrchestrator)` checks
   - Should be handled at a higher level

## Proposed Consolidation

### From 20 files to 8-10 core fragments:

#### 1. **Identity & Role** (Consolidate 4 → 1)
- Merge: `agent-common.ts`, `expertise-boundaries.ts`, `domain-expert-guidelines.ts`, parts of `agentFragments.ts`
- Into: `agent-identity.ts`
```typescript
export const agentIdentityFragment = {
  id: "agent-identity",
  template: (ctx) => {
    if (ctx.agent.isOrchestrator) {
      return ""; // Orchestrator has no identity
    }
    return `
You are ${ctx.agent.name}. ${ctx.agent.role}

${ctx.agent.instructions}

## Your Role
- You are a domain expert providing recommendations
- You cannot directly modify system state
- Use tools to gather information and provide analysis
- Call complete() to hand off implementation tasks
`;
  }
};
```

#### 2. **Available Tools** (Consolidate 3 → 1)
- Merge: `agent-tools.ts`, `mcp-tools.ts`, `tool-use.ts`
- Into: `available-tools.ts`
```typescript
export const availableToolsFragment = {
  id: "available-tools",
  template: (ctx) => {
    const allTools = [
      ...ctx.agent.tools,
      ...ctx.mcpTools
    ];
    return `
## Available Tools
${allTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Remember: Execute tools sequentially, not in parallel.
`;
  }
};
```

#### 3. **Reasoning Instructions** (Consolidate 3 → 1)
- Merge: All three reasoning fragments
- Into: `reasoning-instructions.ts`
```typescript
export const reasoningFragment = {
  id: "reasoning",
  template: (ctx) => {
    const tag = ctx.agent.isOrchestrator ? "routing_analysis" : "thinking";
    return `Use <${tag}> tags to show your reasoning process.`;
  }
};
```

#### 4. **Phase Management** (Keep separate but clarify)
- Keep: `phase-definitions.ts` (static definitions)
- Keep: `phase.ts` (dynamic constraints)
- Keep: `agent-completion-guidance.ts` (phase-specific guidance)
- But clarify: These are injected at different times for good reasons

#### 5. **Multi-Agent Context** (Keep as is)
- Keep: `available-agents.ts`
- This is clean and focused

#### 6. **Orchestrator Routing** (Keep as is)
- Keep: `orchestrator-routing.ts`
- This is orchestrator-specific and complex enough to warrant its own file

#### 7. **Project Context** (Keep as is)
- Keep: `project.ts` (inventory)
- Keep: `project-md.ts` (PROJECT.md for project-manager)
- These serve distinct purposes

#### 8. **Special Context** (Keep as is)
- Keep: `voice-mode.ts`
- Keep: `referenced-article.ts`
- Keep: `retrieved-lessons.ts`
- These are conditional and specific

### Fragments to Delete

1. **Delete `tool-use.ts`** - Unused and redundant
2. **Delete `expertise-boundaries.ts`** - Merge into identity
3. **Delete `domain-expert-guidelines.ts`** - Merge into identity
4. **Delete `agent-common.ts`** - Merge into identity
5. **Delete `expert-reasoning.ts`** - Merge into single reasoning fragment

### Simplified Builder Usage

Instead of complex conditional logic within fragments:

```typescript
// src/prompts/utils/systemPromptBuilder.ts
function buildMainSystemPrompt(options: BuildSystemPromptOptions): string {
  const builder = new PromptBuilder();
  
  if (options.agent.isOrchestrator) {
    // Orchestrator-specific fragments only
    builder
      .add("phase-definitions", {})
      .add("available-agents", { agents: options.availableAgents })
      .add("orchestrator-routing", {})
      .add("reasoning", { agent: options.agent });
  } else {
    // Specialist-specific fragments only
    builder
      .add("agent-identity", { agent: options.agent })
      .add("phase-definitions", {})
      .add("available-agents", { agents: options.availableAgents })
      .add("available-tools", { 
        agent: options.agent, 
        mcpTools: options.mcpTools 
      })
      .add("reasoning", { agent: options.agent })
      .add("retrieved-lessons", { ... });
      
    // Conditional additions
    if (options.agent.slug === 'project-manager') {
      builder.add("project-md", { ... });
    }
    
    if (isVoiceMode(options.triggeringEvent)) {
      builder.add("voice-mode", {});
    }
  }
  
  return builder.build();
}
```

## Benefits of This Approach

1. **50% fewer fragment files** (20 → 10)
2. **Clear separation** between orchestrator and specialist paths
3. **No more scattered `isOrchestrator` checks** in fragments
4. **Single source of truth** for each concept
5. **Builder system remains useful** for conditional assembly
6. **Easy to understand** what each agent type gets

## Migration Strategy

### Phase 1: Consolidate Redundant Fragments (Week 1)
1. Create new consolidated fragments
2. Update `systemPromptBuilder.ts` to use them
3. Test with one agent type

### Phase 2: Remove Old Fragments (Week 1-2)
1. Delete old fragment files
2. Update imports
3. Test all agent types

### Phase 3: Simplify Builder Logic (Week 2)
1. Separate orchestrator and specialist paths clearly
2. Remove conditional logic from fragments
3. Move all conditionals to builder level

## Conclusion

The fragment system itself is fine - it's just gotten messy. By consolidating redundant fragments and clarifying the separation between agent types, we can keep the benefits of modularity while drastically reducing complexity.

This isn't a rewrite - it's a cleanup. Most of the code can be reused, just reorganized.