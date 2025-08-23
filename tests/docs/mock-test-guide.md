# iOS Testing with Mock LLM Backend

## How It Works

The mock LLM provider replaces ONLY the LLM API calls while preserving ALL backend business logic:

```
iOS App → Backend (Real) → Mock LLM Provider
                ↓
         All business logic runs:
         - Agent routing
         - Tool execution  
         - Event publishing
         - Conversation phases
```

## Two Mock Modes

### 1. Simple Mock (Recommended)
```bash
# Start backend with simple mock
LLM_PROVIDER=mocked bun run daemon --projectPath /tmp/test

# Or use the script
./scripts/start-with-mock-llm.sh simple
```

**Features:**
- Pattern-based responses
- Minimal configuration
- Fast and predictable
- Perfect for UI testing

**Responses:**
- "hello" → Greeting response
- "create file" → File creation response  
- "list files" → Directory listing
- "simulate error" → Error for testing
- "analyze code" → Code review response

### 2. Scenario Mock (Advanced)
```bash
# Start with complex scenarios
LLM_PROVIDER=mock MOCK_SCENARIOS=ios-all bun run daemon

# Or use the script  
./scripts/start-with-mock-llm.sh scenarios
```

**Features:**
- Complex event sequences
- Publishes mock Nostr events
- Multi-agent simulation
- Phase transitions

## What Gets Tested

✅ **Backend Business Logic:**
- Agent selection and routing
- Tool validation and execution
- Conversation state management
- Event publishing to Nostr
- Error handling and recovery
- Project status updates

✅ **iOS App Integration:**
- Message sending/receiving
- Event parsing (kinds 24010, 24111, 1934, etc.)
- Agent status display
- Tool execution results
- Error presentation
- Typing indicators

❌ **What's Mocked:**
- Only the LLM API calls (OpenAI, Anthropic, etc.)
- Responses are predetermined, not generated

## Testing Workflow

1. **Start Mock Backend:**
```bash
cd /Users/pablofernandez/projects/TENEX-ff3ssq
./scripts/start-with-mock-llm.sh simple
```

2. **Configure iOS App:**
```swift
// Point to mock backend
let backendURL = "http://localhost:3000"
```

3. **Run Manual Tests:**
- Send "hello" → Should get greeting
- Send "create a file" → Should trigger file creation
- Send "simulate error" → Should show error handling

4. **Run Maestro Tests:**
```bash
cd /Users/pablofernandez/projects/tenex-ios-ablupo
maestro test maestro/test_suite.yaml
```

## Example Test Cases

### Test 1: Basic Conversation
```
User: "hello"
Mock: "Hello! I'm running in test mode..."
Backend: Publishes typing events, manages conversation
iOS: Shows typing indicator, displays response
```

### Test 2: Tool Execution
```
User: "create a file called test.md"  
Mock: Returns tool call for writeContextFile
Backend: Executes tool, publishes results
iOS: Shows file creation confirmation
```

### Test 3: Error Handling
```
User: "simulate error"
Mock: Returns error response
Backend: Handles error, publishes error event
iOS: Shows error message, recovers gracefully
```

## Benefits

1. **Real Backend Logic:** All business logic runs normally
2. **Deterministic:** Same input → same output
3. **Fast:** No network delays to LLM APIs
4. **Free:** No API costs during testing
5. **Debuggable:** Can trace exact flow

## Debugging

Enable debug logs to see the flow:
```bash
DEBUG=true LLM_PROVIDER=mocked bun run daemon
```

Watch the logs for:
- `[MockLLM]` - Mock provider responses
- `[Agent]` - Agent routing decisions
- `[Tool]` - Tool execution
- `[Event]` - Nostr event publishing

## Extending the Mock

To add new test responses, edit `SimpleMockProvider.ts`:

```typescript
this.responses = new Map([
  // Add your pattern and response
  [/your pattern/i, "Your mock response"],
]);
```

The mock provider is intentionally simple to ensure backend logic is properly tested.