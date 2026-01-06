# TENEX Trace Viewer

A terminal-based UI (TUI) for debugging TENEX conversation traces from Jaeger. Built with Ink (React for CLIs).

## Prerequisites

- Jaeger running locally (default: http://localhost:16686)
- TENEX daemon running with OpenTelemetry configured

## Quick Start

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Build
bun run build

# Run built version
bun run start

# Run with custom Jaeger URL
bun run dev -- --jaeger=http://custom-host:16686

# Show help
bun run dev -- --help
```

## Usage

The trace viewer connects to Jaeger and immediately displays the most recent trace's hierarchical span structure, similar to Jaeger's trace detail view. You can navigate between traces using keyboard shortcuts.

### Command-Line Options

```
--jaeger=<url>      Jaeger URL (default: http://localhost:16686)
--service=<name>    Service name to filter traces (default: tenex-daemon)
-h, --help          Show help message
```

### Keyboard Controls

**Trace Navigation:**
- `n` - Next trace (newer → older)
- `p` - Previous trace (older → newer)
- `r` - Refresh traces from Jaeger

**Span Navigation:**
- `↑` / `↓` - Navigate up/down through spans
- `→` / `Space` - Expand selected span to show children
- `←` - Collapse selected span
- `e` - Expand all spans
- `c` - Collapse all spans

**Detail View:**
- `Enter` - Show detailed view of selected span (attributes, events)
- `q` / `ESC` - Go back from detail view

**Global:**
- `q` - Quit application

### What You'll See

The viewer shows:
- **Agent Executions**: Which agent executed (e.g., "ProjectManager executes [chat]")
- **LLM Calls**: Model used (e.g., "LLM: anthropic/claude-3.5-sonnet")
- **Tool Calls**: Tool name and arguments (e.g., "Tool: delegate(recipient=..., prompt=...)")
- **Event Processing**: Event content preview
- **Message Building**: Strategy used for building LLM messages
- **Durations**: Time each operation took in milliseconds
- **Events**: Count of span events (shown as badge)

### Detail View

Press `Enter` on any span to see:
- Full attributes (agent names, model IDs, tool arguments, etc.)
- Span events (routing decisions, delegations, supervisor validations)
- Child span count
- Precise duration

Press `q` or `ESC` to return to tree view.

## How It Works

The viewer connects to Jaeger's HTTP API and:
1. Fetches up to 50 recent traces for the `tenex-daemon` service on startup
2. **Immediately displays the most recent trace's full span hierarchy** (like Jaeger does)
3. Parses OTLP span data and converts operation names to semantic labels (agent names, tool calls, etc.)
4. Allows you to navigate between traces with `n`/`p` keys
5. Shows the hierarchical parent-child relationships with indentation and expand/collapse

**Key Difference from Jaeger Web UI**: Instead of clicking through a list, you immediately see the trace structure and can quickly jump between traces with keyboard shortcuts.

## Architecture

```
tools/trace-viewer/
├── src/
│   ├── cli.tsx                      # Entry point with CLI arg parsing
│   ├── types.ts                     # TypeScript type definitions
│   ├── mockData.ts                  # Mock data (for testing)
│   ├── services/
│   │   └── JaegerClient.ts          # Jaeger API client
│   └── components/
│       ├── App.tsx                  # Main app (loads traces, handles n/p navigation)
│       └── TraceTree.tsx            # Hierarchical trace view with span navigation
├── dist/                            # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

### Components

- **JaegerClient**: Fetches traces from Jaeger's HTTP API and converts OTLP format to our internal structure
- **App**: Loads traces on startup, manages current trace state, handles trace navigation (n/p/r keys)
- **TraceTree**: Hierarchical tree view of a single trace with semantic labels, span navigation, and expand/collapse
