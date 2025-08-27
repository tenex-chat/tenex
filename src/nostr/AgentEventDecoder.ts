import type { AgentInstance } from "@/agents/types";
import { EVENT_KINDS } from "@/llm/types";
import { getProjectContext } from "@/services";
import { type NDKEvent, NDKTask } from "@nostr-dev-kit/ndk";

/**
 * AgentEventDecoder - Utilities for decoding and analyzing Nostr events
 *
 * This class provides static methods for extracting information from Nostr events
 * and determining their types, targets, and relationships.
 */

// biome-ignore lint/complexity/noStaticOnlyClass: Static utility class for decoding event semantics
export class AgentEventDecoder {
  /**
   * Check if an event is directed to the system (project or agents)
   */
  static isDirectedToSystem(event: NDKEvent, systemAgents: Map<string, AgentInstance>): boolean {
    const pTags = event.tags.filter((tag) => tag[0] === "p");
    if (pTags.length === 0) return false;

    const mentionedPubkeys = pTags
      .map((tag) => tag[1])
      .filter((pubkey): pubkey is string => !!pubkey);

    const systemPubkeys = new Set([...Array.from(systemAgents.values()).map((a) => a.pubkey)]);

    // Add project pubkey if available
    const projectCtx = getProjectContext();
    if (projectCtx.pubkey) {
      systemPubkeys.add(projectCtx.pubkey);
    }

    return mentionedPubkeys.some((pubkey) => systemPubkeys.has(pubkey));
  }

  /**
   * Check if event is from an agent in the system
   */
  static isEventFromAgent(event: NDKEvent, systemAgents: Map<string, AgentInstance>): boolean {
    const agentPubkeys = new Set(Array.from(systemAgents.values()).map((a) => a.pubkey));
    return agentPubkeys.has(event.pubkey);
  }

  /**
   * Check if this is a task completion event (for NDKTask kind:1934)
   * Note: This is different from delegation completions (kind:1111)
   */
  static isTaskCompletionEvent(event: NDKEvent): boolean {
    // Only for actual NDKTask completions, not delegations
    if (
      event.tagValue("K") === NDKTask.kind.toString() &&
      event.tagValue("P") === event.tagValue("p")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Extract task ID from an event
   */
  static getTaskId(event: NDKEvent): string | undefined {
    // For task completions, the task ID is in the E tag
    if (AgentEventDecoder.isTaskCompletionEvent(event)) {
      return event.tagValue("E");
    }

    // For task events themselves
    if (event.kind === NDKTask.kind) {
      return event.id;
    }

    return undefined;
  }

  /**
   * Get conversation root from event
   */
  static getConversationRoot(event: NDKEvent): string | undefined {
    return event.tagValue("E") || event.tagValue("A");
  }

  /**
   * Get Claude session ID from event
   */
  static getClaudeSessionId(event: NDKEvent): string | undefined {
    return event.tagValue("claude-session");
  }

  /**
   * Check if event is an orphaned reply (reply without findable root)
   */
  static isOrphanedReply(event: NDKEvent): boolean {
    // Must be a kind 11 (text note reply)
    if (event.tagValue("K") !== "11") {
      return false;
    }

    // Must have a conversation root reference
    const hasRoot = !!(event.tagValue("E") || event.tagValue("A"));

    // Must have p-tags (directed to someone)
    const hasPTags = event.tags.some((tag) => tag[0] === "p");

    return hasRoot && hasPTags;
  }

  /**
   * Get mentioned pubkeys from event
   */
  static getMentionedPubkeys(event: NDKEvent): string[] {
    return event.tags
      .filter((tag) => tag[0] === "p")
      .map((tag) => tag[1])
      .filter((pubkey): pubkey is string => !!pubkey);
  }

  /**
   * Check if this is an agent's internal message (completion, delegation, etc)
   */
  static isAgentInternalMessage(event: NDKEvent): boolean {
    // Events with tool tags are internal agent operations
    if (event.tagValue("tool")) {
      return true;
    }

    // Status events are internal
    if (event.tagValue("status")) {
      return true;
    }

    return false;
  }

  /**
   * Extract phase from event if present
   */
  static getPhase(event: NDKEvent): string | undefined {
    return event.tagValue("phase");
  }

  /**
   * Check if event is a delegation request (kind:1111 from agent to agent)
   */
  static isDelegationRequest(event: NDKEvent, systemAgents?: Map<string, AgentInstance>): boolean {
    // Must be kind:1111
    if (event.kind !== 1111) return false;
    
    // If we have system agents, verify it's from an agent
    if (systemAgents) {
      const isFromAgent = this.isEventFromAgent(event, systemAgents);
      if (!isFromAgent) return false;
      
      // Check if p-tag points to another agent
      const pTag = event.tagValue("p");
      if (pTag && Array.from(systemAgents.values()).some(a => a.pubkey === pTag)) {
        return true;
      }
    } else {
      // Fallback: just check if it has a p-tag (less accurate)
      return !!event.tagValue("p");
    }
    
    return false;
  }
  
  /**
   * Check if event is a delegation completion (kind:1111 with tool:complete)
   */
  static isDelegationCompletion(event: NDKEvent): boolean {
    return event.kind === 1111 && 
           event.tagValue("status") === "completed";
  }
  
  /**
   * Get the delegation request ID from a completion event
   * Checks all e-tags to find the first valid delegation request ID
   */
  static getDelegationRequestId(event: NDKEvent): string | undefined {
    if (this.isDelegationCompletion(event)) {
      // Check all e-tags to find a delegation request ID
      // For explicit completions, we return the first e-tag as the most likely candidate
      // The DelegationCompletionHandler will validate if it's actually a tracked delegation
      const eTags = event.getMatchingTags("e");
      if (eTags.length > 0 && eTags[0][1]) {
        return eTags[0][1]; // Return the first e-tag value
      }
    }
    return undefined;
  }
  

  /**
   * Check if event is a status event
   */
  static isStatusEvent(event: NDKEvent): boolean {
    return event.kind === EVENT_KINDS.PROJECT_STATUS;
  }

  /**
   * Extract error type from error event
   */
  static getErrorType(event: NDKEvent): string | undefined {
    return event.tagValue("error");
  }

  /**
   * Get the K tag value (referenced event kind)
   */
  static getReferencedKind(event: NDKEvent): string | undefined {
    return event.tagValue("K");
  }

  /**
   * Check if event has a specific tool tag
   */
  static hasTool(event: NDKEvent, toolName: string): boolean {
    return event.tagValue("tool") === toolName;
  }

  /**
   * Get all tool tags from event
   */
  static getToolTags(event: NDKEvent): Array<{ name: string; args?: unknown }> {
    return event.tags
      .filter((tag) => tag[0] === "tool")
      .map((tag) => ({
        name: tag[1],
        args: tag[2] ? JSON.parse(tag[2]) : undefined,
      }));
  }

  /**
   * Check if this is a streaming event
   */
  static isStreamingEvent(event: NDKEvent): boolean {
    return event.kind === EVENT_KINDS.STREAMING_RESPONSE;
  }

  /**
   * Check if this is a typing indicator event
   */
  static isTypingEvent(event: NDKEvent): boolean {
    return event.kind === EVENT_KINDS.TYPING_INDICATOR;
  }
}
