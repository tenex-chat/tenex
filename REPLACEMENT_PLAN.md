# Complete Replacement Plan: multi-llm-ts → AI SDK + OpenRouter

## Core Philosophy
- **NO migration path** - Complete replacement
- **NO backwards compatibility** - Clean slate
- **NO unnecessary abstractions** - Use AI SDK directly
- **ONE provider** - OpenRouter handles 300+ models

## Phase 1: Delete Everything multi-llm-ts Related

### Files to DELETE entirely:
```
src/llm/router.ts                    # Complex routing logic - not needed
src/llm/ToolPlugin.ts                 # Plugin adapter - AI SDK has native tools
src/llm/ToolResult.ts                # Custom serialization - not needed
src/llm/providers/MockProvider.ts    # Over-engineered mocking
src/llm/providers/SimpleMockProvider.ts # Keep simple version only
patches/multi-llm-ts+4.3.6.patch     # No more patches needed
```

### Dependencies to REMOVE:
```json
"multi-llm-ts": "^4.0.3"
"patch-package": "^8.0.0"  // Unless needed for other patches
```

## Phase 2: New Minimal Architecture

### New File Structure:
```
src/llm/
  ├── service.ts       # Simple LLM service (50 lines max)
  ├── tools.ts         # Tool converter (30 lines max)
  └── types.ts         # Re-export AI SDK types ONLY
```

### 1. `src/llm/types.ts` - Just re-exports
```typescript
// No custom types - just re-export what we need
export type { 
  CoreMessage as Message,
  CoreTool as Tool,
  ToolCall,
  ToolResult 
} from 'ai';

// Event kinds stay (not LLM related)
export const EVENT_KINDS = {
  PROJECT_STATUS: 24010,
  AGENT_REQUEST: 4133,
  // ... etc
} as const;
```

### 2. `src/llm/service.ts` - Dead simple service
```typescript
import { generateText, streamText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { CoreMessage, CoreTool } from 'ai';

export class LLMService {
  private provider;
  
  constructor(apiKey: string) {
    this.provider = createOpenRouter({ 
      apiKey,
      headers: { 'X-Title': 'TENEX' }
    });
  }
  
  async complete(model: string, messages: CoreMessage[], tools?: CoreTool[]) {
    return generateText({
      model: this.provider(model),
      messages,
      tools,
      maxToolRoundtrips: 0  // Manual control for RAL
    });
  }
  
  async stream(model: string, messages: CoreMessage[], tools?: CoreTool[]) {
    return streamText({
      model: this.provider(model),
      messages,
      tools,
      maxSteps: 1  // Manual control for RAL
    });
  }
}
```

### 3. `src/llm/tools.ts` - Simple converter
```typescript
import { tool } from 'ai';
import { z } from 'zod';
import type { Tool as TenexTool } from '@/tools/types';

export function convertTool(tenexTool: TenexTool) {
  return tool({
    description: tenexTool.description,
    parameters: tenexTool.parameters, // Already Zod schema
    execute: async (params) => {
      const result = await tenexTool.execute(params);
      return result.output;
    }
  });
}
```

## Phase 3: Update ReasonActLoop

### Changes to `src/agents/execution/ReasonActLoop.ts`:
```typescript
class ReasonActLoop {
  constructor(private llm: LLMService) {}
  
  async executeIteration(messages: CoreMessage[], tools: CoreTool[]) {
    // Direct use - no abstractions
    const result = await this.llm.complete(
      this.model,
      messages,
      tools
    );
    
    // Messages are in result.messages - use directly
    if (result.messages) {
      for (const msg of result.messages) {
        messages.push(msg);
      }
    }
    
    // Tool calls are explicit
    if (result.toolCalls?.length) {
      // We already have tool results in messages
      // Just check for control flow
      return { shouldContinue: true };
    }
    
    return { shouldContinue: false };
  }
}
```

## Phase 4: Configuration Simplification

### OLD config structure (DELETE):
```json
{
  "configurations": {
    "config1": { "provider": "openai", "model": "gpt-4" },
    "config2": { "provider": "anthropic", "model": "claude-3" }
  },
  "credentials": {
    "openai": { "apiKey": "..." },
    "anthropic": { "apiKey": "..." }
  },
  "defaults": { "agents": "config1" }
}
```

### NEW config structure:
```json
{
  "openrouter": {
    "apiKey": "sk-or-..."
  },
  "models": {
    "agents": "openai/gpt-4",
    "analyze": "anthropic/claude-3-sonnet",
    "orchestrator": "google/gemini-2.0-flash"
  }
}
```

## Phase 5: Update All Imports

### Find all files importing from multi-llm-ts:
```bash
grep -r "from 'multi-llm-ts'" --include="*.ts"
grep -r 'from "multi-llm-ts"' --include="*.ts"
```

### Replace imports:
```typescript
// OLD
import { Message, LlmResponse } from 'multi-llm-ts';

// NEW
import type { CoreMessage as Message } from 'ai';
```

## Phase 6: Testing Strategy

### Keep ONLY simple tests:
1. Basic completion works
2. Tool calling works
3. Streaming works (if needed)
4. Messages preserve context

### Delete complex test infrastructure:
- Mock scenarios
- Provider-specific tests
- Plugin tests

## Implementation Order

### Day 1: Rip out old code
1. Create new minimal files (service.ts, tools.ts, types.ts)
2. Update package.json - remove multi-llm-ts, add AI SDK
3. Delete all old LLM files

### Day 2: Wire up new code
1. Update ReasonActLoop to use new service
2. Update config loading to use simple structure
3. Fix all import errors

### Day 3: Test and fix
1. Test basic completion
2. Test tool calling
3. Test RAL iterations
4. Fix any issues

## Key Insights from Testing

1. **Message format is critical**: Use messages from response directly, don't reconstruct
2. **Manual tool control**: Always use maxToolRoundtrips: 0 or maxSteps: 1
3. **OpenRouter handles everything**: No need for provider-specific code
4. **Streaming quirks**: Text might be in finish-step chunks, not text-delta
5. **Tool results**: Automatically added to message history by AI SDK

## What We're NOT Doing

- ❌ NO LLMRouter - just call the model directly
- ❌ NO ToolPlugin - use native AI SDK tools
- ❌ NO provider abstraction - OpenRouter IS the provider
- ❌ NO model discovery - just use model strings
- ❌ NO complex configuration - just API key + model names
- ❌ NO patches - use libraries as designed
- ❌ NO custom message types - use AI SDK types
- ❌ NO result serialization - use what AI SDK returns

## Success Metrics

- **Lines of code**: Should be 70% less
- **Dependencies**: 2 packages instead of multiple
- **Complexity**: No abstraction layers
- **Maintainability**: Direct AI SDK usage = easy updates
- **Performance**: Less overhead = faster

## Final Architecture

```
Agent → ReasonActLoop → LLMService → AI SDK → OpenRouter → Any Model
                           ↓
                        convertTool() for TENEX tools
```

That's it. No routers, no plugins, no adapters, no mappings. Just direct, simple usage of a well-designed SDK.