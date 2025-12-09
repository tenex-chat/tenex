# AI SDK Patch for Provider-Executed Tools

## What This Fixes

This patch fixes a bug in the AI SDK (v5.0.106) where `parseToolCall` incorrectly validates provider-executed tool calls, causing them to be marked as `invalid: true` even though they execute successfully. This was causing confusing behavior where Claude Code would apologize for tools it just successfully used.

## The Bug

The AI SDK's `parseToolCall` function validates ALL tool calls against the user's tools map, including tools with `providerExecuted: true`. For provider-executed tools (like Claude Code's built-in Bash tool), this validation fails because these tools aren't in the user's tools map - they're handled by the provider.

When validation fails, the SDK:
1. Marks the tool as `invalid: true`
2. Sends an error message back to the model: "Model tried to call unavailable tool 'Bash'"
3. Model gets confused and apologizes

## The Fix

The patch adds a check at the start of `parseToolCall` to skip validation for tools with `providerExecuted: true`:

```javascript
// Skip validation for provider-executed tools
if (toolCall.providerExecuted === true) {
  const parsedInput = await safeParseJSON({ text: toolCall.input });
  return {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: parsedInput.success ? parsedInput.value : toolCall.input,
    dynamic: toolCall.dynamic,
    providerExecuted: true,
    providerMetadata: toolCall.providerMetadata
  };
}
```

## How It Works

The patch is automatically applied after `bun install` via the `postinstall` script in package.json:

```json
{
  "scripts": {
    "postinstall": "[ -f patches/ai+5.0.106.patch ] && (cd node_modules/ai && patch -p1) < patches/ai+5.0.106.patch || true"
  }
}
```

## Affected Files

- `node_modules/ai/dist/index.js` (CommonJS build)
- `node_modules/ai/dist/index.mjs` (ESM build)

## Upstream Issue

This fix has been reported to the Vercel AI SDK team:
https://github.com/vercel/ai/issues/10888

Once the official fix is released, this patch can be removed.

## Verification

Before patch:
```json
{
  "type": "tool-call",
  "toolName": "Bash",
  "invalid": true,  // ← Problem
  "error": { "name": "AI_NoSuchToolError" }
}
```

After patch:
```json
{
  "type": "tool-call",
  "toolName": "Bash",
  "providerExecuted": true,  // ← Fixed
  "dynamic": true
}
```

## Compatibility

- **AI SDK Version:** 5.0.106
- **Provider:** ai-sdk-provider-claude-code v2.2.3
- **Runtime:** Bun (but patch works with Node.js/npm/yarn too)

## Manual Application

If you need to apply the patch manually:

```bash
cd node_modules/ai
patch -p1 < ../../patches/ai+5.0.106.patch
```
