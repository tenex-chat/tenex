import { getNDK } from "@/nostr";
import { NDKKind } from "@/nostr/kinds";
import { aggregateConversationMetadata, type AggregatedMetadata } from "@/events/utils/metadataAggregator";
import { CONVERSATION_UI } from "../constants";

export interface ConversationData {
  id: string;
  title: string;
  summary?: string;
  lastActivity: number;
  projectId?: string;
}

/**
 * Service for fetching conversation data from Nostr.
 * Separates data fetching logic from UI components.
 */
export class ConversationFetcher {
  /**
   * Fetch recent conversations with their metadata
   */
  static async fetchRecentConversations(): Promise<ConversationData[]> {
    const ndk = getNDK();

    // Calculate timestamp for history window
    const daysAgo = Math.floor(Date.now() / 1000) - (CONVERSATION_UI.DAYS_OF_HISTORY * 24 * 60 * 60);

    // Fetch conversation roots
    const conversationFilter = {
      kinds: [NDKKind.ConversationRoot],
      since: daysAgo,
      limit: CONVERSATION_UI.MAX_CONVERSATIONS
    };
    const conversationEvents = await ndk.fetchEvents(conversationFilter);

    // Fetch metadata events
    const conversationIds = Array.from(conversationEvents).map(e => e.id);
    let metadataMap = new Map<string, AggregatedMetadata>();

    if (conversationIds.length > 0) {
      const metadataFilter = {
        kinds: [NDKKind.EventMetadata],
        "#e": conversationIds
      };
      const metadataEvents = await ndk.fetchEvents(metadataFilter);
      metadataMap = aggregateConversationMetadata(Array.from(metadataEvents));
    }

    // Build conversation list
    const conversations: ConversationData[] = Array.from(conversationEvents)
      .map(event => {
        const metadata = metadataMap.get(event.id);
        return {
          id: event.id,
          title: metadata?.title || event.content?.substring(0, 50) || "Untitled",
          summary: metadata?.summary,
          lastActivity: (event.created_at || 0) * 1000,
          projectId: event.tagValue("a") // Get project reference if any
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity); // Sort by most recent

    return conversations;
  }
}