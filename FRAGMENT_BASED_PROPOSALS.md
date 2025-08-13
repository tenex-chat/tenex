# Fragment-Based System Prompt Proposals

You're right - fragments provide valuable reusability and single-source-of-truth benefits. The problem isn't fragments themselves, but the over-complicated machinery around them. Let's keep fragments but drastically simplify everything else.

## Proposal 1: Fragments as Simple Constants

**Core Idea**: Fragments are just exported constants. No registry, no builder, no classes.

```typescript
// src/prompts/fragments.ts
export const AGENT_IDENTITY = (agent: AgentInstance) => 
  !agent.isOrchestrator ? `You are ${agent.name}. ${agent.role}\n\n${agent.instructions}` : '';

export const PHASE_DEFINITIONS = `
## Conversation Phases
- CHAT: General discussion and exploration
- PLAN: Creating implementation strategies  
- EXECUTE: Writing and modifying code
- REVIEW: Analyzing results and improvements
`;

export const INVENTORY_INSTRUCTIONS = (phase: Phase) => `
## Project Inventory
The project structure is documented in INVENTORY.md. 
${phase === 'EXECUTE' ? 'Reference it to understand file locations before making changes.' : ''}
`;

export const MULTI_AGENT_SETUP = (agents: AgentInstance[]) => `
## Available Agents
${agents.map(a => `- ${a.slug}: ${a.role}`).join('\n')}
You can hand off tasks to specialized agents when appropriate.
`;

export const ORCHESTRATOR_ROUTING = `
Analyze requests and output ONLY JSON:
{"agents": ["agent-slug"], "phase": "PHASE", "reason": "explanation"}
`;

// src/prompts/buildPrompt.ts
import * as fragments from './fragments';

export function buildSystemPrompt(
  agent: AgentInstance,
  phase: Phase,
  agents: AgentInstance[]
): string {
  if (agent.isOrchestrator) {
    return [
      fragments.PHASE_DEFINITIONS,
      fragments.MULTI_AGENT_SETUP(agents),
      fragments.ORCHESTRATOR_ROUTING
    ].join('\n\n');
  }
  
  return [
    fragments.AGENT_IDENTITY(agent),
    fragments.PHASE_DEFINITIONS,
    fragments.INVENTORY_INSTRUCTIONS(phase),
    fragments.MULTI_AGENT_SETUP(agents),
    // ... other fragments
  ].filter(Boolean).join('\n\n');
}
```

**Benefits**:
- Dead simple - fragments are just functions
- Easy to find and modify
- No magic registration
- TypeScript gives you autocomplete
- Can still compose and reuse

**Drawbacks**:
- Less dynamic (but do you need that?)
- Need to import fragments explicitly

## Proposal 2: Fragments as Objects (No Registry)

**Core Idea**: Fragments are objects with metadata, but no global registry. Just import what you need.

```typescript
// src/prompts/fragments/types.ts
interface Fragment {
  id: string;
  content: (context: any) => string;
  onlyFor?: 'orchestrator' | 'specialist' | 'all';
}

// src/prompts/fragments/identity.ts
export const identityFragment: Fragment = {
  id: 'identity',
  onlyFor: 'specialist',
  content: (ctx) => `You are ${ctx.agent.name}. ${ctx.agent.role}\n\n${ctx.agent.instructions}`
};

// src/prompts/fragments/inventory.ts
export const inventoryFragment: Fragment = {
  id: 'inventory',
  onlyFor: 'specialist',
  content: (ctx) => {
    const inventory = readInventory();
    return `## Project Structure\n${inventory}`;
  }
};

// src/prompts/fragments/multiAgent.ts
export const multiAgentFragment: Fragment = {
  id: 'multi-agent',
  onlyFor: 'all',
  content: (ctx) => `
## Multi-Agent System
Available agents: ${ctx.agents.map(a => a.slug).join(', ')}
Use complete() to hand off to another agent when needed.
`
};

// src/prompts/buildPrompt.ts
import { identityFragment } from './fragments/identity';
import { inventoryFragment } from './fragments/inventory';
import { multiAgentFragment } from './fragments/multiAgent';
// ... import others

const SPECIALIST_FRAGMENTS = [
  identityFragment,
  inventoryFragment,
  multiAgentFragment,
  // ... others
];

const ORCHESTRATOR_FRAGMENTS = [
  multiAgentFragment,
  routingFragment,
  // ... others
];

export function buildSystemPrompt(agent: AgentInstance, context: PromptContext): string {
  const fragments = agent.isOrchestrator ? ORCHESTRATOR_FRAGMENTS : SPECIALIST_FRAGMENTS;
  
  return fragments
    .filter(f => f.onlyFor === 'all' || f.onlyFor === (agent.isOrchestrator ? 'orchestrator' : 'specialist'))
    .map(f => f.content(context))
    .filter(Boolean)
    .join('\n\n');
}
```

**Benefits**:
- Fragments have structure but no complex machinery
- Explicit imports (no magic)
- Easy to see what fragments each agent type uses
- Can add metadata without complexity

**Drawbacks**:
- Need to maintain fragment lists
- Some duplication in imports

## Proposal 3: Fragment Collections

**Core Idea**: Group related fragments together in collections. No registry, just organized exports.

```typescript
// src/prompts/fragments/core.ts
export const CoreFragments = {
  phaseDefinitions: () => `
    ## Phases
    - CHAT: Discussion
    - PLAN: Strategy  
    - EXECUTE: Implementation
  `,
  
  projectContext: (project: NDKProject) => `
    ## Project: ${project.title}
    Owner: ${project.pubkey}
  `
};

// src/prompts/fragments/specialist.ts
export const SpecialistFragments = {
  identity: (agent: AgentInstance) => `
    You are ${agent.name}. ${agent.role}
    ${agent.instructions}
  `,
  
  boundaries: (agent: AgentInstance) => `
    ## Your Expertise
    Stay within your domain: ${agent.role}
    Hand off tasks outside your expertise.
  `,
  
  inventory: () => {
    const inv = readInventory();
    return inv ? `## Project Structure\n${inv}` : '';
  }
};

// src/prompts/fragments/orchestrator.ts
export const OrchestratorFragments = {
  routing: () => `Output JSON only: {"agents": [...], "phase": "...", "reason": "..."}`,
  
  agentList: (agents: AgentInstance[]) => `
    ## Available Agents
    ${agents.map(a => `${a.slug}: ${a.role}`).join('\n')}
  `
};

// src/prompts/fragments/shared.ts
export const SharedFragments = {
  multiAgent: (agents: AgentInstance[]) => `
    ## Multi-Agent System
    You're part of a team. Available agents:
    ${agents.map(a => `- ${a.slug}: ${a.role}`).join('\n')}
  `,
  
  tools: (tools: Tool[]) => `
    ## Available Tools
    ${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}
  `
};

// src/prompts/buildPrompt.ts
import { CoreFragments } from './fragments/core';
import { SpecialistFragments } from './fragments/specialist';
import { OrchestratorFragments } from './fragments/orchestrator';
import { SharedFragments } from './fragments/shared';

export function buildOrchestratorPrompt(context: PromptContext): string {
  return [
    CoreFragments.phaseDefinitions(),
    OrchestratorFragments.agentList(context.agents),
    SharedFragments.multiAgent(context.agents),
    OrchestratorFragments.routing()
  ].filter(Boolean).join('\n\n');
}

export function buildSpecialistPrompt(agent: AgentInstance, context: PromptContext): string {
  return [
    SpecialistFragments.identity(agent),
    CoreFragments.phaseDefinitions(),
    CoreFragments.projectContext(context.project),
    SpecialistFragments.inventory(),
    SpecialistFragments.boundaries(agent),
    SharedFragments.multiAgent(context.agents),
    SharedFragments.tools(agent.tools)
  ].filter(Boolean).join('\n\n');
}
```

**Benefits**:
- Fragments organized by purpose
- No registration needed
- Clear what's shared vs specific
- Easy to find related fragments
- Simple functions, no classes

**Drawbacks**:
- Less flexible for dynamic composition
- Need to know which collection to look in

## Proposal 4: Template Literals with Fragments

**Core Idea**: Use template literals for the main structure, call fragment functions for reusable parts.

```typescript
// src/prompts/fragments/index.ts
export const fragments = {
  phaseDefinitions: () => PHASE_DEFINITIONS_CONST,
  
  inventory: (phase: Phase) => {
    const inv = readInventory();
    if (!inv) return '';
    return `## Project Inventory
${inv}
${phase === 'EXECUTE' ? 'Use this to understand the codebase structure.' : ''}`;
  },
  
  multiAgentContext: (agents: AgentInstance[], currentAgent: AgentInstance) => `
## Multi-Agent System
You are ${currentAgent.name}, part of a team with:
${agents.filter(a => a.slug !== currentAgent.slug).map(a => `- ${a.slug}: ${a.role}`).join('\n')}

Call complete() with targetAgent when you need to hand off.`,
  
  tools: (tools: Tool[]) => {
    if (!tools.length) return '';
    return `## Your Tools
${tools.map(t => `- ${t.name}: ${t.description}
  ${t.promptFragment || ''}`).join('\n\n')}`;
  }
};

// src/prompts/templates.ts
import { fragments as f } from './fragments';

export function buildSpecialistPrompt(
  agent: AgentInstance,
  context: PromptContext
): string {
  return `
You are ${agent.name}. ${agent.role}

${agent.instructions}

${f.phaseDefinitions()}

Current Phase: ${context.phase}

${f.inventory(context.phase)}

${f.multiAgentContext(context.agents, agent)}

${f.tools(agent.tools)}

## Guidelines
- Stay within your expertise
- Be helpful and thorough
- Call complete() when done
`.trim();
}

export function buildOrchestratorPrompt(context: PromptContext): string {
  return `
You are the Orchestrator, responsible for routing conversations to the right agents.

${f.phaseDefinitions()}

## Available Agents
${context.agents.map(a => `- ${a.slug}: ${a.role}`).join('\n')}

## Your Task
Analyze each request and decide which agent(s) should handle it.

Output ONLY valid JSON:
{
  "agents": ["agent-slug"],
  "phase": "PHASE_NAME", 
  "reason": "Brief explanation"
}
`.trim();
}
```

**Benefits**:
- See the overall structure immediately
- Fragments for truly reusable parts only
- Natural reading flow
- Easy to modify structure

**Drawbacks**:
- Template strings can get long
- Mixing template and function calls

## Proposal 5: Simplified Builder (No Registry)

**Core Idea**: Keep a builder for conditional logic, but make it dead simple. No registry, no priorities.

```typescript
// src/prompts/SimplePromptBuilder.ts
export class SimplePromptBuilder {
  private parts: string[] = [];
  
  add(content: string | (() => string)): this {
    const result = typeof content === 'function' ? content() : content;
    if (result?.trim()) {
      this.parts.push(result);
    }
    return this;
  }
  
  addIf(condition: boolean, content: string | (() => string)): this {
    if (condition) {
      this.add(content);
    }
    return this;
  }
  
  build(): string {
    return this.parts.join('\n\n');
  }
}

// src/prompts/fragments.ts - Simple functions, no objects
export const agentIdentity = (agent: AgentInstance) => 
  `You are ${agent.name}. ${agent.role}\n\n${agent.instructions}`;

export const inventory = () => {
  const inv = readInventory();
  return inv ? `## Project Structure\n${inv}` : '';
};

export const multiAgent = (agents: AgentInstance[]) => `
## Team Members
${agents.map(a => `- ${a.slug}: ${a.role}`).join('\n')}
`;

// src/prompts/buildPrompt.ts
import { SimplePromptBuilder } from './SimplePromptBuilder';
import * as f from './fragments';

export function buildSystemPrompt(
  agent: AgentInstance,
  context: PromptContext
): string {
  const builder = new SimplePromptBuilder();
  
  return builder
    .addIf(!agent.isOrchestrator, () => f.agentIdentity(agent))
    .add(f.phaseDefinitions)
    .addIf(!agent.isOrchestrator, f.inventory)
    .add(() => f.multiAgent(context.agents))
    .addIf(agent.isOrchestrator, f.orchestratorRouting)
    .addIf(!agent.isOrchestrator, () => f.agentTools(agent.tools))
    .addIf(agent.slug === 'project-manager', readProjectMd)
    .build();
}
```

**Benefits**:
- Simple, understandable builder
- Conditional logic is clear
- No magic or hidden behavior
- Fragments are just functions

**Drawbacks**:
- Still using a builder (but much simpler)

## My Recommendation: Proposal 3 (Fragment Collections)

This gives you the best balance:
- Fragments are organized and discoverable
- No complex machinery (no registry, no builder)
- Clear separation between orchestrator/specialist/shared fragments
- Just functions returning strings
- Easy to understand and modify

You get the reusability benefits of fragments without any of the complexity. The entire system would be maybe 200-300 lines of code instead of 2000+.

## What You'd Keep vs Delete

**Keep**:
- Fragment concept (but as simple functions)
- Separation of concerns (different fragments for different purposes)
- Single source of truth for instructions

**Delete**:
- FragmentRegistry
- PromptBuilder with priorities
- Fragment validation
- Complex template functions
- Registration system
- Most of the type definitions

## Migration Path

1. Start by creating the new fragment collections alongside existing system
2. Replace one agent type at a time
3. Once working, delete the old system entirely
4. Total migration: ~1 week