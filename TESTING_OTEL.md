# Testing OpenTelemetry Integration

## Quick Test (5 minutes)

### Step 1: Start Jaeger

```bash
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

**Verify it's running:**
```bash
curl http://localhost:16686
# Should return HTML

curl http://localhost:4318
# Should return "404 page not found" (means OTLP endpoint is listening)
```

**Or use the browser:**
```bash
open http://localhost:16686
```

You should see the Jaeger UI.

---

### Step 2: Start TENEX Daemon

```bash
# In a new terminal
bun run src/tenex.ts daemon
```

**Look for this in the output:**
```
[Telemetry] OpenTelemetry enabled - capturing ALL traces
[Telemetry] Exporting to http://localhost:4318/v1/traces
```

✅ If you see this, telemetry is working!

---

### Step 3: Trigger an Event

You have several options to trigger traces:

#### Option A: Use an existing TENEX project

If you have a project set up:

```bash
# Send a test message via Nostr (use your preferred Nostr client)
# Or if you have a test script:
bun run scripts/send-test-event.js
```

#### Option B: Check daemon initialization traces

Even without sending events, the daemon startup creates spans:

1. Configuration loading
2. NDK initialization
3. Project discovery

These should already be visible in Jaeger.

---

### Step 4: View Traces in Jaeger

1. **Open Jaeger UI**: http://localhost:16686

2. **Select Service**:
   - In the dropdown, select `tenex-daemon`

3. **Find Operations**:
   - Click "Find Traces"
   - You should see operations like:
     - `tenex.event.process` (if you sent an event)
     - `ai.streamText` (if an LLM call was made)
     - `ai.generateText` (if an LLM call was made)

4. **Click on a trace** to see details:
   - Timeline view of all spans
   - Span attributes (click on any span)
   - Full event data, prompts, responses

---

## What to Look For

### ✅ Success Indicators

**In TENEX logs:**
```
[Telemetry] OpenTelemetry enabled - capturing ALL traces
```

**In Jaeger UI:**
- Service `tenex-daemon` appears in the dropdown
- Traces show up after actions (events, LLM calls)
- Clicking a trace shows a waterfall timeline
- Span attributes contain full data

### Example Trace View

```
tenex.event.process                                    [2.5s]
├─ event.id: "abc123..."
├─ event.content: "Help me with this code"
├─ event.tags: [["p","..."], ["e","..."]]
├─ routing_decision: "route_to_project"
└─ project.id: "31933:xyz:project1"
```

If you click the span, you'll see all attributes.

---

## Detailed Testing Scenarios

### Test 1: LLM Call Tracing

**Trigger an LLM call** (any action that uses an agent):

1. Send a message to a project
2. Wait for agent response
3. Check Jaeger for `ai.streamText` or `ai.generateText` span

**What you should see:**
```
ai.streamText                                          [2.2s]
├─ ai.prompt.messages: [
│    {"role": "system", "content": "You are..."},
│    {"role": "user", "content": "Help me..."}
│  ]
├─ ai.response.text: "I can help you with..."
├─ ai.usage.promptTokens: 1250
├─ ai.usage.completionTokens: 450
├─ ai.usage.totalTokens: 1700
└─ llm.provider: "openai"
```

**Expand the span** and look at "Tags" - you'll see FULL prompts and responses!

---

### Test 2: Event Routing

**Send any Nostr event to the daemon**

**What you should see in Jaeger:**
```
tenex.event.process
├─ Events tab:
│  └─ routing_decision:
│     - decision: "route_to_project"
│     - reason: "found_by_p_tag"
├─ Attributes:
│  ├─ event.id: "..."
│  ├─ event.content: "..." (FULL content)
│  ├─ event.tags: "[...]" (ALL tags as JSON)
│  ├─ routing.method: "p_tag"
│  └─ project.id: "31933:..."
```

---

### Test 3: Error Tracing

**Trigger an error** (e.g., send an event with invalid data):

**What you should see:**
```
tenex.event.process                                    [ERROR]
├─ Status: ERROR
├─ Exception:
│  ├─ message: "Project not found"
│  ├─ stack: "Error: Project not found\n  at ..."
└─ Events:
   └─ error:
      └─ error: "unknown_project"
```

The span will be colored RED in Jaeger UI.

---

## Common Issues & Fixes

### Issue: "Service not found in Jaeger"

**Cause:** Daemon hasn't sent any spans yet

**Fix:**
1. Check TENEX logs for `[Telemetry] OpenTelemetry enabled`
2. Wait 5 seconds (spans are batched)
3. Trigger an action (send an event)
4. Refresh Jaeger UI

---

### Issue: "Spans visible but no attributes"

**Cause:** Jaeger UI collapsed attributes by default

**Fix:**
1. Click on a span in the trace
2. Look for "Tags" section
3. Click to expand
4. Scroll through attributes

---

### Issue: "Can't connect to Jaeger"

**Check Jaeger is running:**
```bash
docker ps | grep jaeger
```

**Restart if needed:**
```bash
docker stop jaeger
docker rm jaeger

docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest
```

---

### Issue: "No LLM traces visible"

**Causes:**
1. No LLM call was made yet
2. Spans are batched (wait 5 seconds)
3. AI SDK telemetry not enabled

**Verify AI SDK telemetry:**
```bash
# Check src/llm/service.ts has:
experimental_telemetry: this.getFullTelemetryConfig()
```

---

## Advanced Testing

### Search by Event ID

In Jaeger UI:
1. Click "Tags" filter
2. Add: `event.id=<your-event-id>`
3. Click "Find Traces"

### Search by Agent

1. Click "Tags" filter
2. Add: `agent.slug=<agent-name>`
3. Click "Find Traces"

### Search by Conversation

1. Click "Tags" filter
2. Add: `conversation.id=<conversation-id>`
3. Click "Find Traces"

---

## Viewing Full Prompts & Responses

**To see the FULL LLM prompt:**

1. Find an `ai.streamText` span
2. Click on it
3. Go to "Tags" section
4. Look for `ai.prompt.messages`
5. Click to expand - you'll see the FULL JSON array of messages

**To see the FULL LLM response:**

1. Same span
2. Look for `ai.response.text`
3. Click to expand - you'll see the COMPLETE response

---

## Performance Check

With 100% sampling and full data capture:

**Expected overhead:**
- CPU: ~4-5% increase
- Memory: ~50MB increase
- Network: ~1-2 Mbps to Jaeger

**Monitor with:**
```bash
# CPU/Memory
htop

# Network (if Jaeger is local)
# Should be minimal since localhost
```

---

## Stopping Everything

```bash
# Stop TENEX daemon
Ctrl+C

# Stop Jaeger
docker stop jaeger

# Remove Jaeger (if you want to start fresh)
docker rm jaeger
```

---

## Next: What to Test

Once basic tracing works, test these scenarios:

### Scenario 1: Multi-step Agent Flow
1. Send a complex request requiring multiple tools
2. Watch the trace show all tool calls
3. See timing for each operation

### Scenario 2: Error Recovery
1. Trigger an error (bad event format)
2. See the error captured with full context
3. Debug from the trace instead of logs

### Scenario 3: Long Conversation
1. Have a multi-turn conversation
2. Search for `conversation.id` in Jaeger
3. See all events in that conversation linked

---

## Success Checklist

- [ ] Jaeger UI loads at http://localhost:16686
- [ ] `tenex-daemon` appears in service dropdown
- [ ] At least one trace visible
- [ ] Clicking a trace shows span timeline
- [ ] Span attributes contain full data (event.content, etc.)
- [ ] LLM calls show `ai.streamText` or `ai.generateText` spans
- [ ] Full prompts visible in `ai.prompt.messages`
- [ ] Full responses visible in `ai.response.text`

If all checked ✅ - **OpenTelemetry is working perfectly!**

---

## Screenshots Guide

### What You'll See

**1. Jaeger Search Page**
- Service dropdown: `tenex-daemon`
- Operation dropdown: Various operations
- "Find Traces" button

**2. Trace List**
- Rows of traces with timestamps
- Duration on the right
- Click any row to open details

**3. Trace Detail View**
- Waterfall timeline at top
- Each span is a horizontal bar
- Longer bars = slower operations
- RED bars = errors

**4. Span Detail**
- Click any span in waterfall
- Right panel opens
- Tabs: Logs, Tags, Process
- **Tags** has all the data!

---

## Pro Tips

### Tip 1: Use Time Range
- Default is last hour
- For testing, use "Last 15 minutes"
- Update frequently to see new traces

### Tip 2: Filter Noise
- Use "Min Duration" to find slow operations
- Use "Max Duration" to find quick operations
- Use "Limit Results" if too many traces

### Tip 3: Compare Traces
- Open two traces in separate tabs
- Compare timings
- Find regressions

### Tip 4: Export Traces
- Click "JSON" button on trace detail
- Save for later analysis
- Share with team for debugging

---

**Ready to see your first trace? Run the test script!**

```bash
./test-otel.sh
```

Then open http://localhost:16686 and explore! 🎉
