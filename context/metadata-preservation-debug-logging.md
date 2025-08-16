# LLM Metadata Preservation Debug Logging

## Overview
Comprehensive debug logging has been added throughout the metadata preservation flow to track how LLM metadata is handled when tools (especially `complete()`) are used.

## Debug Log Points

### 1. **handleAgentCompletion** (`completionHandler.ts`)
- **Location**: When creating unpublished event
- **Logs**: 
  - `[handleAgentCompletion] Created unpublished event`
  - Shows: agent name, response length, event ID, tags

### 2. **complete() tool** (`complete.ts`)
- **Location**: When serializing event for deferred publishing
- **Logs**:
  - `[complete() tool] Serializing event for deferred publishing`
  - Shows: agent name, event ID, serialized event keys, content length, tag count

### 3. **ToolStreamHandler** (`ToolStreamHandler.ts`)
- **Location**: When storing serialized event
- **Logs**:
  - `[ToolStreamHandler] Stored serialized event for deferred publishing`
  - `[ToolStreamHandler] Complete tool has no serialized event` (if missing)
  - Shows: presence of serialized event, event keys, content length

### 4. **StreamStateManager** (`StreamStateManager.ts`)
- **Location**: When storing/retrieving deferred events
- **Logs**:
  - `[StreamStateManager] Stored deferred event`
  - `[StreamStateManager] Retrieved deferred event`
  - Shows: event presence, content length, tag count, event keys

### 5. **ReasonActLoop** (`ReasonActLoop.ts`)
- **Location**: Multiple points in the flow
- **Logs**:
  - `[ReasonActLoop] Terminal tool detected, continuing to wait for metadata`
    - Shows when not returning early on terminal tools
  - `[ReasonActLoop] Received 'done' event`
    - Shows: model, usage data, tokens, cost
  - `[ReasonActLoop] Processing deferred event`
    - Shows: serialized event keys, content length
  - `[ReasonActLoop] Adding metadata to deferred event`
    - Shows: model, cost, tokens, prompts presence
  - `[ReasonActLoop] ✅ Published deferred complete() event with metadata`
    - Shows: successful publication with all metadata
  - `[ReasonActLoop] Have deferred event but no publisher` (warning)
  - `[ReasonActLoop] No deferred event to publish` (debug)

### 6. **NostrPublisher** (`NostrPublisher.ts`)
- **Location**: When adding LLM metadata to events
- **Logs**:
  - `[NostrPublisher] Adding LLM metadata to event`
    - Shows: all metadata fields being added
  - `[NostrPublisher] ✅ Metadata tags added`
    - Shows: total tags, metadata tag count
  - `[NostrPublisher] No metadata to add` (if none)

### 7. **ClaudeBackend** (`ClaudeBackend.ts`)
- **Location**: Throughout the Claude execution flow
- **Logs**:
  - `[ClaudeBackend] Getting unpublished event from handleAgentCompletion`
  - `[ClaudeBackend] Adding Claude metadata to event`
    - Shows: model, cost, prompt lengths
  - `[ClaudeBackend] ✅ Published completion with metadata`
    - Shows: event ID, cost, message count, duration, session ID

## Log Flow Example

When a complete() tool is used, you'll see this sequence in the logs:

1. `[handleAgentCompletion] Created unpublished event`
2. `[complete() tool] Serializing event for deferred publishing`
3. `[ToolStreamHandler] Stored serialized event for deferred publishing`
4. `[StreamStateManager] Stored deferred event`
5. `[ReasonActLoop] Terminal tool detected, continuing to wait for metadata`
6. `[ReasonActLoop] Received 'done' event` (with usage data)
7. `[StreamStateManager] Retrieved deferred event`
8. `[ReasonActLoop] Processing deferred event`
9. `[ReasonActLoop] Adding metadata to deferred event`
10. `[NostrPublisher] Adding LLM metadata to event`
11. `[NostrPublisher] ✅ Metadata tags added`
12. `[ReasonActLoop] ✅ Published deferred complete() event with metadata`

## Key Indicators

### Success Indicators
- ✅ emoji in logs indicates successful operations
- Presence of cost, tokens, and model information in final publication

### Warning Signs
- `Have deferred event but no publisher` - indicates a configuration issue
- `Complete tool has no serialized event` - indicates the tool didn't serialize properly

### Debug Information
- All logs include relevant context like agent names, event IDs, and data sizes
- Token counts and costs are logged when available
- System/user prompts presence is indicated without logging full content (for privacy)

## Usage

To see these logs in action:
1. Run TENEX with debug logging enabled
2. Watch for `[component]` prefixed messages
3. Follow the flow from event creation to publication
4. Check for ✅ markers indicating successful metadata preservation

## Troubleshooting

If metadata is missing:
1. Check for `[ReasonActLoop] Terminal tool detected` - confirms detection
2. Look for `[ReasonActLoop] Received 'done' event` - confirms metadata arrived
3. Verify `[NostrPublisher] Adding LLM metadata` - confirms metadata was added
4. Confirm `✅ Published deferred complete() event` - confirms successful publication