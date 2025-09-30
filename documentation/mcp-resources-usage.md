# MCP Resources Usage Guide

This guide explains how to use MCP resources in TENEX for both RAG (Retrieval-Augmented Generation) and agentic patterns.

## Overview

MCP servers can expose two types of resources:
1. **Direct Resources** - Static resources with fixed URIs (e.g., `file:///config.json`)
2. **Resource Templates** - Dynamic resources with parameterized URIs (e.g., `nostr://feed/{pubkey}/{kinds}`)

## Two Ways to Use Resources

### 1. Resources as Context (RAG Pattern - Recommended)

Fetch resources and include them as context in your AI prompts. This is deterministic and cost-effective.

```typescript
import { mcpManager } from '@/services/mcp/MCPManager';

async function queryWithResources(userQuestion: string) {
  // List available resources from a server
  const resources = await mcpManager.listResources('nostr-explore');

  // Read specific resources
  const context = await mcpManager.getResourceContext('nostr-explore', [
    'nostr://feed/82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2/1'
  ]);

  // Use in your AI prompt
  const result = await streamText({
    model: openai('gpt-4'),
    prompt: `
      Context:
      ${context}

      Question: ${userQuestion}
    `,
  });

  return result;
}
```

### 2. Resources as Tools (Agentic Pattern)

Let the AI decide when to fetch resources by exposing them as callable tools.

```typescript
import { mcpManager } from '@/services/mcp/MCPManager';

async function setupAgenticMode() {
  // Enable resources as tools
  mcpManager.setIncludeResourcesInTools(true);

  // Refresh the tool cache
  await mcpManager.refreshTools();

  // Now get tools - resources are included
  const tools = mcpManager.getCachedTools();

  // Use with AI
  const result = await streamText({
    model: openai('gpt-4'),
    tools,
    maxSteps: 5,
    prompt: 'Fetch recent posts from jack on Nostr and summarize them',
  });

  return result;
}
```

## API Reference

### MCPManager Methods

#### `listResources(serverName: string): Promise<Resource[]>`
List all resources from a specific MCP server.

```typescript
const resources = await mcpManager.listResources('nostr-explore');
for (const resource of resources) {
  console.log(`${resource.name}: ${resource.uri}`);
}
```

#### `listAllResources(): Promise<Map<string, Resource[]>>`
List resources from all connected MCP servers.

```typescript
const allResources = await mcpManager.listAllResources();
for (const [serverName, resources] of allResources) {
  console.log(`Server: ${serverName}, Resources: ${resources.length}`);
}
```

#### `listResourceTemplates(serverName: string): Promise<ResourceTemplate[]>`
List resource templates from a specific MCP server.

```typescript
const templates = await mcpManager.listResourceTemplates('nostr-explore');
for (const template of templates) {
  console.log(`${template.name}: ${template.uriTemplate}`);
}
```

#### `listAllResourceTemplates(): Promise<Map<string, ResourceTemplate[]>>`
List resource templates from all connected MCP servers.

```typescript
const allTemplates = await mcpManager.listAllResourceTemplates();
```

#### `readResource(serverName: string, uri: string): Promise<ReadResourceResult>`
Read content from a specific resource.

```typescript
const result = await mcpManager.readResource(
  'nostr-explore',
  'nostr://feed/82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2/1'
);

for (const content of result.contents) {
  if ('text' in content) {
    console.log(content.text);
  }
}
```

#### `getResourceContext(serverName: string, resourceUris: string[]): Promise<string>`
Fetch multiple resources and format them as a single context string (for RAG).

```typescript
const context = await mcpManager.getResourceContext('nostr-explore', [
  'nostr://feed/user1/1',
  'nostr://feed/user2/1',
]);

// Use context in your prompt
const result = await generateText({
  model: openai('gpt-4'),
  prompt: `Context:\n${context}\n\nQuestion: ...`,
});
```

#### `setIncludeResourcesInTools(include: boolean): void`
Enable or disable including resources as tools.

```typescript
// Enable resources as tools
mcpManager.setIncludeResourcesInTools(true);
await mcpManager.refreshTools();

// Disable resources as tools
mcpManager.setIncludeResourcesInTools(false);
await mcpManager.refreshTools();
```

#### `refreshTools(): Promise<void>`
Refresh the tool cache with current settings.

```typescript
// After changing includeResourcesInTools
await mcpManager.refreshTools();
```

## Tool Naming Convention

When resources are included as tools, they follow this naming pattern:

### Direct Resources
```
mcp__${serverName}__resource_${resourceName}
```

Example:
```
mcp__nostr-explore__resource_config
```

### Resource Templates
```
mcp__${serverName}__resource_template_${templateName}
```

Example:
```
mcp__nostr-explore__resource_template_nostr-feed
```

The AI can call these tools with parameters extracted from the URI template.

## Best Practices

### When to Use RAG (Resources as Context)

✅ **Use RAG when:**
- You know which resources are needed upfront
- Resources should always be included (like system configuration)
- Cost/latency is critical
- You want predictable behavior
- Building traditional chatbots

### When to Use Tools (Agentic)

✅ **Use Tools when:**
- You have many resources and the AI should decide which to fetch
- Resources are expensive to fetch (only fetch what's needed)
- You want exploratory behavior
- Resources have dynamic parameters via templates
- Building autonomous agents

### Hybrid Approach

You can combine both patterns:

```typescript
// Pre-fetch critical context (RAG)
const criticalContext = await mcpManager.getResourceContext('server', ['uri1', 'uri2']);

// Enable resources as tools for exploration
mcpManager.setIncludeResourcesInTools(true);
await mcpManager.refreshTools();
const tools = mcpManager.getCachedTools();

// Use both
const result = await streamText({
  model: openai('gpt-4'),
  tools,
  maxSteps: 5,
  prompt: `
    Critical Context:
    ${criticalContext}

    Answer the question, using additional resources if needed.
  `,
});
```

## Example: Nostr Feed Analysis

```typescript
async function analyzeNostrFeed(pubkey: string) {
  // Get resource templates
  const templates = await mcpManager.listResourceTemplates('nostr-explore');
  const feedTemplate = templates.find(t => t.name === 'nostr-feed');

  if (!feedTemplate) {
    throw new Error('Nostr feed template not found');
  }

  // Construct URI from template
  const uri = feedTemplate.uriTemplate
    .replace('{pubkey}', pubkey)
    .replace('{kinds}', '1'); // Just notes

  // Read the resource
  const result = await mcpManager.readResource('nostr-explore', uri);

  // Parse NDJSON content
  const events = result.contents
    .filter(c => 'text' in c)
    .flatMap(c => c.text.split('\n'))
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(e => e !== null);

  console.log(`Fetched ${events.length} events`);

  // Use with AI
  const analysis = await generateText({
    model: openai('gpt-4'),
    prompt: `
      Here are recent Nostr posts from user ${pubkey}:
      ${JSON.stringify(events, null, 2)}

      Summarize what this user is posting about.
    `,
  });

  return analysis.text;
}
```

## Configuration

Resources support is automatically available when MCP servers are configured. To enable resources as tools globally, add to your agent configuration:

```json
{
  "mcpResourcesAsTools": true
}
```

Or control it programmatically:

```typescript
if (agentConfig.mcpResourcesAsTools) {
  mcpManager.setIncludeResourcesInTools(true);
  await mcpManager.refreshTools();
}
```
