import { NDKEvent } from "@nostr-dev-kit/ndk";

export const createConversationEvent = (id: string, content = "", title = ""): NDKEvent => {
  const event = new NDKEvent();
  event.id = id;
  event.content = content;
  event.tags = [["d", id]];
  if (title) {
    event.tags.push(["title", title]);
  }
  return event;
};

export const createReplyEvent = (id: string, content: string): NDKEvent => {
  const event = new NDKEvent();
  event.id = `${id}-reply`;
  event.content = content;
  event.tags = [["e", id]];
  return event;
};

export const createAgentMessageEvent = (
  id: string,
  agentPubkey: string,
  content: string
): NDKEvent => {
  const event = new NDKEvent();
  event.id = `${id}-agent-message`;
  event.pubkey = agentPubkey;
  event.content = content;
  event.tags = [["e", id]];
  return event;
};
