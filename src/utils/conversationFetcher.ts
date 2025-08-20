import type NDK from "@nostr-dev-kit/ndk";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import chalk from "chalk";
import { getAgentSlugFromEvent } from "@/nostr/utils";
import { getProjectContext, type ProjectContext } from "@/services";

interface ConversationEvent {
  event: NDKEvent;
  author: string;
  isHuman: boolean;
  timestamp: Date;
  content: string;
  depth: number;
}

interface ConversationTree {
  root: ConversationEvent;
  replies: Map<string, ConversationEvent[]>;
}

export async function fetchConversation(
  bech32Event: string,
  ndk: NDK,
  _projectPath: string
): Promise<string> {
  // Fetch the event directly using the nevent string
  const inputEvent = await ndk.fetchEvent(bech32Event);
  if (!inputEvent) {
    throw new Error(`Event ${bech32Event} not found`);
  }

  // Get project context to identify human user
  const projectCtx = getProjectContext();
  const humanPubkey = projectCtx.project.pubkey;

  // Get the root event Id (it's either E-tagged or then we already have it).
  const rootEventId = inputEvent.tagValue("E") ?? inputEvent.id;

  const events = await fetchAllEventsInConversation(ndk, rootEventId);

  // Fetch profiles for all participants
  const participants = await fetchParticipantProfiles(events, ndk, projectCtx);

  // Build conversation tree
  const tree = buildConversationTree(events, participants, humanPubkey);

  // Format as markdown
  return formatConversationMarkdown(tree, humanPubkey);
}

async function fetchAllEventsInConversation(ndk: NDK, rootEventId: string): Promise<NDKEvent[]> {
  const events = await ndk.fetchEvents([{ ids: [rootEventId] }, { "#E": [rootEventId] }]);

  // Sort by created_at
  return Array.from(events).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

async function fetchParticipantProfiles(
  events: NDKEvent[],
  ndk: NDK,
  projectCtx: ProjectContext
): Promise<Map<string, string>> {
  const participants = new Map<string, string>();
  const pubkeys = new Set<string>();

  // Collect unique pubkeys
  for (const event of events) {
    if (event.pubkey) {
      pubkeys.add(event.pubkey);
    }
  }

  // Fetch profiles
  for (const pubkey of pubkeys) {
    // Check if it's an agent first
    const agentSlug = getAgentSlugFromEvent({ pubkey } as NDKEvent);
    if (agentSlug) {
      const agent = projectCtx.agents.get(agentSlug);
      if (agent) {
        participants.set(pubkey, `@${agent.name}`);
        continue;
      }
    }

    // Fetch from nostr
    try {
      const user = ndk.getUser({ pubkey });
      await user.fetchProfile();
      const profile = user.profile;
      const name = profile?.displayName || profile?.name || pubkey;
      participants.set(pubkey, `@${name}`);
    } catch {
      participants.set(pubkey, `@${pubkey.slice(0, 8)}...`);
    }
  }

  return participants;
}

function buildConversationTree(
  events: NDKEvent[],
  participants: Map<string, string>,
  humanPubkey: string
): ConversationTree {
  const eventMap = new Map<string, ConversationEvent>();
  const replies = new Map<string, ConversationEvent[]>();
  let rootEvent: ConversationEvent | null = null;

  // First pass: create ConversationEvent objects
  for (const event of events) {
    const conversationEvent: ConversationEvent = {
      event,
      author: participants.get(event.pubkey) || `@${event.pubkey.slice(0, 8)}...`,
      isHuman: event.pubkey === humanPubkey,
      timestamp: new Date((event.created_at || 0) * 1000),
      content: event.content,
      depth: 0,
    };

    if (event.id) {
      eventMap.set(event.id, conversationEvent);
    }

    // Find parent
    const parentTag = event.tags.find((tag: string[]) => tag[0] === "e");
    const rootTag = event.tags.find((tag: string[]) => tag[0] === "E");

    if (!parentTag && !rootTag) {
      // This is the root
      rootEvent = conversationEvent;
    }
  }

  // Second pass: build reply structure
  for (const event of events) {
    if (!event.id) continue;
    const conversationEvent = eventMap.get(event.id);
    if (!conversationEvent) continue;
    const parentTag = event.tags.find((tag: string[]) => tag[0] === "e");

    if (parentTag) {
      const parentId = parentTag[1];
      if (parentId && !replies.has(parentId)) {
        replies.set(parentId, []);
      }
      if (parentId) {
        replies.get(parentId)?.push(conversationEvent);
      }
    } else if (rootEvent && event.id !== rootEvent.event.id) {
      // Direct reply to root
      const rootId = rootEvent.event.id;
      if (rootId && !replies.has(rootId)) {
        replies.set(rootId, []);
      }
      if (rootId) {
        replies.get(rootId)?.push(conversationEvent);
      }
    }
  }

  // Calculate depths
  function setDepth(event: ConversationEvent, depth: number): void {
    event.depth = depth;
    const eventReplies = event.event.id ? replies.get(event.event.id) || [] : [];
    for (const reply of eventReplies) {
      setDepth(reply, depth + 1);
    }
  }

  if (rootEvent) {
    setDepth(rootEvent, 0);
  }

  // Get the first event from the map if no root event found
  const firstEvent = rootEvent || eventMap.values().next().value;

  if (!firstEvent) {
    throw new Error("No events found in conversation tree");
  }

  return {
    root: firstEvent,
    replies,
  };
}

function formatConversationMarkdown(tree: ConversationTree, _humanPubkey: string): string {
  const lines: string[] = [];

  lines.push("# Conversation Thread\n");

  function formatEvent(event: ConversationEvent, indent = ""): void {
    const authorColor = event.isHuman ? chalk.green : chalk.cyan;
    const timestamp = event.timestamp.toLocaleString();

    lines.push(`${indent}${authorColor(event.author)} ${chalk.gray(`[${timestamp}]`)}`);

    // Format content with proper indentation
    const contentLines = event.content.split("\n");
    for (const line of contentLines) {
      lines.push(`${indent}${line}`);
    }

    lines.push(""); // Empty line between messages

    // Format replies
    const eventReplies = event.event.id ? tree.replies.get(event.event.id) || [] : [];
    for (const reply of eventReplies) {
      formatEvent(reply, `${indent}  `);
    }
  }

  formatEvent(tree.root);

  return lines.join("\n");
}
