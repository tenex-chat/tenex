# Conversation ID Architecture

## Overview

Conversation IDs exist in two forms:
1. **Canonical IDs** (64-char hex) - used internally for lookups, matching, storage
2. **Display IDs** (10-char shortened) - used in tool output, logs, UI

## Architecture Layers

### Data Layer: `ConversationCatalogService`

**Returns:** Full canonical IDs (64-char hex)

**Used by:**
- Internal systems (migrations, reminders, indexing)
- Code that needs to match/lookup conversations
- Systems that aggregate across conversations

**Why full IDs:** The catalog is a shared programmatic read model used for internal logic that requires exact ID matching. Returning shortened IDs breaks migrations, deduplication, and cross-reference logic.

```typescript
const catalog = ConversationCatalogService.getInstance(projectId);
const conversations = catalog.listConversations({ limit: 50 });
// conversations[0].id === "abc123...xyz" (64 chars)
```

### Presentation Layer: `ConversationPresenter`

**Returns:** Shortened display IDs + full IDs for lookups

**Used by:**
- Tools that display data to users
- Code that uses the catalog and needs formatted output

```typescript
import { ConversationPresenter } from "@/conversations/presenters/ConversationPresenter";

const catalog = ConversationCatalogService.getInstance(projectId);
const entries = catalog.listConversations({ limit: 50 });
const formatted = ConversationPresenter.formatListEntries(entries);
// formatted[0].id === "abc123..." (10 chars, shortened)
// formatted[0].fullId === "abc123...xyz" (64 chars, for lookups)
```

### Tool Layer

**Option A: Simple tools using catalog**
- Use `ConversationCatalogService` + `ConversationPresenter`
- Get automatic ID formatting
- No manual shortening needed

**Option B: Complex tools with special needs**
- May load directly from `ConversationStore` (e.g., for delegation chain metadata)
- Use centralized `shortenConversationId()` helper for formatting
- Example: `conversation_list` (builds tree structures from delegation chains)

```typescript
import { shortenConversationId } from "@/utils/conversation-id";

// For custom tree structures or special metadata
const store = ConversationStore.getOrLoad(fullId);
const displayId = shortenConversationId(store.id);
```

## When to Use Which

| Use Case | Data Source | ID Formatting |
|----------|------------|---------------|
| Internal matching/lookups | `ConversationCatalogService` | Use full IDs as-is |
| Tool displaying lists | `ConversationCatalogService` + `ConversationPresenter` | Automatic shortened IDs |
| Custom tree structures | `ConversationStore` directly | Manual with `shortenConversationId()` |
| Migrations/indexing | `ConversationCatalogService` | Full IDs (no formatting) |
| Logging/traces | Any source | `shortenConversationId()` helper |

## Critical Rules

1. **Never shorten IDs at the data layer** - The catalog must return full canonical IDs for internal system integrity

2. **Use the centralized helper** - Always use `shortenConversationId()` from `@/utils/conversation-id`, never substring or duplicate logic

3. **Keep full IDs available** - The presenter includes both shortened (`id`) and full (`fullId`) for lookups

4. **Document special cases** - Tools with custom needs (like tree structures) should document why they bypass the presenter

## Examples

### ✅ Correct: Simple tool with catalog

```typescript
const catalog = ConversationCatalogService.getInstance(projectId);
const entries = catalog.listConversations({ limit: 50 });
const formatted = ConversationPresenter.formatListEntries(entries);
return { conversations: formatted }; // Shortened IDs automatically
```

### ✅ Correct: Complex tool with special needs

```typescript
// conversation_list tool - needs delegation chain tree structure
const conversations = loadConversationsFromStore();
return conversations.map(conv => ({
    id: shortenConversationId(conv.id), // Use centralized helper
    children: buildTreeStructure(conv), // Custom logic
}));
```

### ❌ Wrong: Shortening at data layer

```typescript
// DON'T DO THIS in ConversationCatalogService
private toPreview(row: ConversationRow): ConversationCatalogPreview {
    return {
        id: shortenConversationId(row.conversation_id), // ❌ Breaks migrations!
        // ...
    };
}
```

### ❌ Wrong: Manual shortening without helper

```typescript
// DON'T DO THIS
const displayId = fullId.substring(0, 10); // ❌ Duplicates logic, breaks special IDs
```

## Testing

When testing catalog-dependent code:
- Verify full 64-char IDs are returned from catalog methods
- Test that migrations/reminders work with full IDs
- Test that presenter correctly shortens IDs while preserving fullId
- Test that tools using the helper get consistent formatting
