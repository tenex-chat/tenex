# Simplified System Prompt Architecture Proposals

## The Problem: Over-Engineering

You're right - the current system is overcomplicated. For what is essentially "build a string with some conditional parts", we have:
- A fragment registry with 20+ fragments
- A builder pattern with priorities and conditions  
- Multiple injection points across 4+ files
- Separate caching metadata system
- Complex message role attribution logic

This is classic over-engineering. Let's go back to basics.

## Proposal 1: Just Functions (Radical Simplification)

**Core Idea**: Replace the entire fragment system with simple functions that return strings.

```typescript
// src/prompts/buildSystemPrompt.ts

export function buildSystemPrompt(
  agent: AgentInstance,
  phase: Phase,
  project: NDKProject,
  conversation?: Conversation
): string {
  const parts: string[] = [];
  
  // Agent identity
  if (!agent.isOrchestrator) {
    parts.push(`You are ${agent.name}. ${agent.role}`);
    parts.push(agent.instructions);
  }
  
  // Phase definitions (everyone gets this)
  parts.push(PHASE_DEFINITIONS);
  
  // Orchestrator routing
  if (agent.isOrchestrator) {
    parts.push(getOrchestratorRoutingInstructions());
  } else {
    // Specialist boundaries
    parts.push(getSpecialistBoundaries(agent));
  }
  
  // Tools
  parts.push(formatAgentTools(agent));
  if (!agent.isOrchestrator) {
    parts.push(formatMCPTools());
  }
  
  // Project context
  if (agent.slug === 'project-manager') {
    const projectMd = readProjectMd();
    if (projectMd) parts.push(projectMd);
  }
  
  return parts.filter(Boolean).join('\n\n');
}

// Conversation context handled separately
export function buildConversationContext(
  conversation: Conversation,
  agent: AgentInstance,
  triggeringEvent: NDKEvent
): Message[] {
  const messages: Message[] = [];
  
  // Just show the history - no complex "while you were away" blocks
  for (const event of conversation.history) {
    const role = getMessageRole(event, agent);
    messages.push(new Message(role, event.content));
  }
  
  // Add phase instruction if needed
  if (conversation.phase !== agent.lastSeenPhase) {
    messages.push(new Message('system', getPhaseInstructions(conversation.phase)));
  }
  
  // Add triggering event
  messages.push(new Message('user', triggeringEvent.content));
  
  return messages;
}
```

**Benefits**:
- Dead simple to understand
- Easy to debug (just console.log the parts)
- No magic, no registries, no builders
- 80% less code

**Drawbacks**:
- Less flexible for extensions
- Some duplication might occur

## Proposal 2: Single Template File Per Agent Type

**Core Idea**: Each agent type gets ONE template file. No fragments, no assembly.

```typescript
// src/prompts/templates/orchestrator.ts
export const ORCHESTRATOR_TEMPLATE = `
You are the Orchestrator agent responsible for routing conversations.

## Phase Definitions
{{{phaseDefinitions}}}

## Available Agents
{{{availableAgents}}}

## Routing Instructions
When you receive a request, analyze it and decide which agent(s) should handle it.
Output ONLY valid JSON in this format:
{
  "agents": ["agent-slug"],
  "phase": "PLAN",
  "reason": "Brief explanation"
}

No other output is allowed.
`;

// src/prompts/templates/specialist.ts  
export const SPECIALIST_TEMPLATE = `
You are {{{agentName}}}. {{{agentRole}}}

{{{agentInstructions}}}

## Current Phase: {{{phase}}}
{{{phaseInstructions}}}

## Available Tools
{{{tools}}}

## Guidelines
- Stay within your area of expertise
- Use tools when appropriate
- Call complete() when done
`;

// Usage
import Handlebars from 'handlebars';

export function buildPromptFromTemplate(
  agent: AgentInstance,
  context: PromptContext
): string {
  const template = agent.isOrchestrator ? 
    ORCHESTRATOR_TEMPLATE : 
    SPECIALIST_TEMPLATE;
    
  const compiled = Handlebars.compile(template);
  return compiled({
    agentName: agent.name,
    agentRole: agent.role,
    agentInstructions: agent.instructions,
    phase: context.phase,
    phaseInstructions: getPhaseInstructions(context.phase),
    tools: formatTools(agent.tools),
    // ... other variables
  });
}
```

**Benefits**:
- See the ENTIRE prompt in one place
- Easy to modify prompts without touching code
- Could even load templates from files
- Familiar template syntax

**Drawbacks**:
- Templates can get large
- Need template engine dependency

## Proposal 3: Direct String Building (No Abstractions)

**Core Idea**: Just build the string directly where it's needed. No separate prompt module at all.

```typescript
// src/agents/execution/AgentExecutor.ts
private buildMessages(context: ExecutionContext): Message[] {
  const messages: Message[] = [];
  
  // Build system prompt RIGHT HERE
  let systemPrompt = '';
  
  if (context.agent.isOrchestrator) {
    systemPrompt = `
You are the Orchestrator agent responsible for routing.

Available agents:
${context.availableAgents.map(a => `- ${a.slug}: ${a.role}`).join('\n')}

Analyze the request and output JSON:
{"agents": ["slug"], "phase": "PHASE", "reason": "why"}
`;
  } else {
    systemPrompt = `
You are ${context.agent.name}. ${context.agent.role}

${context.agent.instructions}

Current phase: ${context.phase}

Available tools:
${context.agent.tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

${context.agent.slug === 'project-manager' ? readProjectMd() : ''}
`;
  }
  
  messages.push(new Message('system', systemPrompt));
  
  // Add conversation history
  for (const msg of context.conversation.history) {
    messages.push(new Message(
      msg.isFromUser ? 'user' : 'assistant',
      msg.content
    ));
  }
  
  // Add current message
  messages.push(new Message('user', context.triggeringEvent.content));
  
  return messages;
}
```

**Benefits**:
- Zero abstraction overhead
- Everything in one place
- No need to trace through multiple files
- Immediate understanding

**Drawbacks**:
- Prompts mixed with execution logic
- Harder to test prompts in isolation
- Duplication if multiple executors

## Proposal 4: Config-Driven Prompts

**Core Idea**: Define prompts in configuration, not code.

```yaml
# prompts/orchestrator.yaml
identity: "You are the Orchestrator agent responsible for routing."
sections:
  - phase_definitions: true
  - available_agents: true
  - content: |
      Output only JSON:
      {"agents": ["slug"], "phase": "PHASE", "reason": "why"}

# prompts/specialist.yaml  
identity: "You are {agent.name}. {agent.role}"
sections:
  - content: "{agent.instructions}"
  - phase_instructions: true
  - tools: true
  - when: agent.slug == 'project-manager'
    content: "{project_md}"
```

```typescript
// Simple loader
export function loadPrompt(agentType: string, context: any): string {
  const config = yaml.load(`prompts/${agentType}.yaml`);
  return renderPrompt(config, context);
}
```

**Benefits**:
- Non-developers can modify prompts
- Clean separation of prompts from code
- Easy to version and diff prompts
- Could A/B test different prompts

**Drawbacks**:
- Another file format to manage
- Need interpolation logic

## Proposal 5: Class-Based (But Simple)

**Core Idea**: Each agent type is a class that knows how to build its own prompt.

```typescript
abstract class AgentPrompt {
  constructor(protected agent: AgentInstance, protected context: PromptContext) {}
  
  abstract build(): string;
  
  protected getTools(): string {
    return this.agent.tools
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');
  }
}

class OrchestratorPrompt extends AgentPrompt {
  build(): string {
    return `
You are the Orchestrator.

${PHASE_DEFINITIONS}

Available agents:
${this.context.availableAgents.map(a => `- ${a.slug}`).join('\n')}

Output JSON only.
`;
  }
}

class SpecialistPrompt extends AgentPrompt {
  build(): string {
    const parts = [
      `You are ${this.agent.name}. ${this.agent.role}`,
      this.agent.instructions,
      `Phase: ${this.context.phase}`,
      `Tools:\n${this.getTools()}`
    ];
    
    if (this.agent.slug === 'project-manager') {
      parts.push(readProjectMd());
    }
    
    return parts.filter(Boolean).join('\n\n');
  }
}

// Factory
export function createPrompt(agent: AgentInstance, context: PromptContext): string {
  const PromptClass = agent.isOrchestrator ? OrchestratorPrompt : SpecialistPrompt;
  return new PromptClass(agent, context).build();
}
```

**Benefits**:
- Encapsulation without complexity
- Easy to understand inheritance
- Can share common methods
- Type-safe

**Drawbacks**:
- Still some abstraction
- Need to create new classes for new agent types

## My Recommendation: Proposal 1 (Just Functions)

Go with the simplest thing that could possibly work. The current system is trying to solve problems you don't have:

1. **You don't need fragments** - You have 2 agent types (orchestrator and specialist)
2. **You don't need a registry** - You know all your prompts at compile time  
3. **You don't need priorities** - The order is deterministic
4. **You don't need a builder pattern** - You're just concatenating strings

Start with Proposal 1. If you find yourself repeating code, extract a function. If you need more structure later, you can always add it. But don't add complexity preemptively.

## Migration Path for Proposal 1

1. **Week 1**: 
   - Create new `src/prompts/simple.ts` with the basic functions
   - Keep old system running

2. **Week 2**:
   - Update `AgentExecutor` to use new simple functions
   - Remove `buildSystemPromptMessages` calls
   - Test with one agent type

3. **Week 3**:
   - Migrate all agents
   - Delete old prompt system entirely
   - Celebrate removing ~2000 lines of code

## What You'd Delete

- `src/prompts/core/` - entire directory
- `src/prompts/fragments/` - entire directory  
- `src/prompts/utils/systemPromptBuilder.ts`
- `src/prompts/utils/phaseInstructionsBuilder.ts`
- All the fragment imports
- All the registry code
- All the builder pattern code

## Final Thoughts

The best code is no code. The second best code is simple code. Your prompt system should be boring, obvious, and easy to modify. Save the complexity for where it actually adds value.