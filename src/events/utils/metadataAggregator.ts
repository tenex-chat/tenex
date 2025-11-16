import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@/nostr/kinds";

export interface AggregatedMetadata {
  conversationId: string;
  title?: string;
  summary?: string;
  generatedAt?: number;
  model?: string;
}

/**
 * Aggregates multiple kind 513 metadata events for conversations.
 * Uses "most recent wins per tag" strategy with fallback to older values.
 */
export function aggregateConversationMetadata(events: NDKEvent[]): Map<string, AggregatedMetadata> {
  const metadataByConversation = new Map<string, AggregatedMetadata>();

  // Group events by conversation ID
  const eventsByConversation = new Map<string, NDKEvent[]>();
  for (const event of events) {
    if (event.kind !== NDKKind.EventMetadata) continue;

    // Get conversation ID from "e" tag
    const conversationId = event.tagValue("e");
    if (!conversationId) continue;

    if (!eventsByConversation.has(conversationId)) {
      eventsByConversation.set(conversationId, []);
    }
    eventsByConversation.get(conversationId)?.push(event);
  }

  // Aggregate metadata for each conversation
  for (const [conversationId, convEvents] of eventsByConversation) {
    // Sort events by created_at timestamp (newest first)
    const sortedEvents = convEvents.sort((a, b) => {
      const timeA = a.created_at || 0;
      const timeB = b.created_at || 0;
      return timeB - timeA;
    });

    // Start with empty metadata
    const aggregated: AggregatedMetadata = {
      conversationId
    };

    // Iterate through events from newest to oldest
    // Take the first non-empty value found for each field
    for (const event of sortedEvents) {
      // Title tag
      if (!aggregated.title) {
        const title = event.tagValue("title");
        if (title) {
          aggregated.title = title;
        }
      }

      // Summary tag
      if (!aggregated.summary) {
        const summary = event.tagValue("summary");
        if (summary) {
          aggregated.summary = summary;
        }
      }

      // Generated-at tag (use most recent)
      if (!aggregated.generatedAt) {
        const generatedAt = event.tagValue("generated-at");
        if (generatedAt) {
          aggregated.generatedAt = parseInt(generatedAt);
        }
      }

      // Model tag (use most recent)
      if (!aggregated.model) {
        const model = event.tagValue("model");
        if (model) {
          aggregated.model = model;
        }
      }

      // If we have all fields, we can stop
      if (aggregated.title && aggregated.summary && aggregated.generatedAt && aggregated.model) {
        break;
      }
    }

    metadataByConversation.set(conversationId, aggregated);
  }

  return metadataByConversation;
}

/**
 * Get the most recent metadata for a single conversation
 */
export function getLatestMetadata(events: NDKEvent[], conversationId: string): AggregatedMetadata | undefined {
  const conversationEvents = events.filter(e =>
    e.kind === NDKKind.EventMetadata && e.tagValue("e") === conversationId
  );

  if (conversationEvents.length === 0) {
    return undefined;
  }

  const aggregated = aggregateConversationMetadata(conversationEvents);
  return aggregated.get(conversationId);
}