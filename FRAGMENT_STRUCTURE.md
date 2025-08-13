# Fragment Structure with Priority Prefixes

## The New Naming Convention

Each fragment is now prefixed with its priority number, making it immediately clear:
1. **Order of inclusion** in the prompt
2. **Either/or relationships** (same number = choose one)
3. **Purpose grouping** (similar priorities = related functionality)

## Fragment Organization

### Priority 01 - Identity (EITHER/OR)
```
01-orchestrator-identity.ts    OR    01-specialist-identity.ts
```
The FIRST thing in any prompt - who the agent is.

### Priority 10 - Early Context
```
10-phase-definitions.ts         (SHARED - both use)
10-referenced-article.ts        (CONDITIONAL - if article exists)
```
Core definitions and context that come early.

### Priority 15 - Available Agents (EITHER/OR)
```
15-orchestrator-available-agents.ts    OR    15-specialist-available-agents.ts
```
Who else is in the system - different view for orchestrator vs specialist.

### Priority 20 - Phase & Mode Context
```
20-phase-constraints.ts         (SHARED - both use)
20-phase-context.ts            (SHARED - both use)
20-voice-mode.ts               (CONDITIONAL - if voice mode)
```
Current phase information and special modes.

### Priority 24 - Lessons
```
24-retrieved-lessons.ts         (SHARED - both use)
```
Past learnings from the system.

### Priority 25 - Core Capabilities (EITHER/OR)
```
25-orchestrator-routing.ts     OR    25-specialist-tools.ts
```
Orchestrator gets routing instructions, specialists get tools.

### Priority 30 - Project Context
```
30-project-inventory.ts         (SHARED - both use)
30-project-md.ts                (CONDITIONAL - project-manager only)
```
Project-specific information.

### Priority 35 - Completion Guidance
```
35-specialist-completion-guidance.ts    (SPECIALIST ONLY)
```
When to use the complete() tool.

### Priority 85 - Reasoning Format (EITHER/OR)
```
85-orchestrator-reasoning.ts    OR    85-specialist-reasoning.ts
```
How to structure thinking/analysis - near the end so it's fresh.

### Priority 90+ - Special Purpose
```
90-execute-task-prompt.ts       (CLI direct execution)
90-inventory-generation.ts      (Internal LLM prompts)
```
Special-case fragments not part of normal agent prompts.

## Key Benefits

1. **Visual Clarity**: You can see the structure just from filenames
2. **No Ambiguity**: Same priority = choose one based on agent type
3. **Easy Maintenance**: Adding a fragment? Pick the right priority range
4. **Self-Documenting**: The number tells you when it appears in the prompt

## Usage in systemPromptBuilder

The builder now clearly shows the either/or pattern:

```typescript
if (agent.isOrchestrator) {
    builder
        .add("01-orchestrator-identity", {...})     // Priority 01
        .add("15-orchestrator-available-agents", {...}) // Priority 15
        .add("25-orchestrator-routing", {...})       // Priority 25
        .add("85-orchestrator-reasoning", {...});    // Priority 85
} else {
    builder
        .add("01-specialist-identity", {...})        // Priority 01
        .add("15-specialist-available-agents", {...})    // Priority 15
        .add("25-specialist-tools", {...})           // Priority 25
        .add("85-specialist-reasoning", {...});      // Priority 85
}
```

The matching priorities make it crystal clear these are alternatives!