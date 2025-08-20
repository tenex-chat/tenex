import { beforeEach, describe, expect, it } from "bun:test";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import { AgentConversationContext } from "../AgentConversationContext";
import { MessageBuilder } from "../MessageBuilder";

describe("AgentConversationContext", () => {
  let context: AgentConversationContext;
  let messageBuilder: MessageBuilder;

  beforeEach(() => {
    messageBuilder = new MessageBuilder();
    context = new AgentConversationContext("test-conversation", "test-agent", messageBuilder);
  });

  describe("duplicate event handling", () => {
    it("should not add duplicate events with the same ID", async () => {
      const event = new NDKEvent();
      event.id = "event-123";
      event.content = "Test message";
      event.pubkey = "test-pubkey";
      event.created_at = Date.now() / 1000;

      // Add the event once
      await context.addEvent(event);
      const messagesAfterFirst = context.getMessages();
      expect(messagesAfterFirst.length).toBe(1);

      // Try to add the same event again
      await context.addEvent(event);
      const messagesAfterSecond = context.getMessages();
      expect(messagesAfterSecond.length).toBe(1); // Should still be 1, not 2
    });

    it("should not add duplicate triggering events with the same ID", async () => {
      const event = new NDKEvent();
      event.id = "triggering-event-456";
      event.content = "User request";
      event.pubkey = "user-pubkey";
      event.created_at = Date.now() / 1000;

      // Add the triggering event once
      await context.addTriggeringEvent(event);
      const messagesAfterFirst = context.getMessages();
      expect(messagesAfterFirst.length).toBe(1);

      // Try to add the same triggering event again
      await context.addTriggeringEvent(event);
      const messagesAfterSecond = context.getMessages();
      expect(messagesAfterSecond.length).toBe(1); // Should still be 1, not 2
    });

    it("should add different events with different IDs", async () => {
      const event1 = new NDKEvent();
      event1.id = "event-1";
      event1.content = "First message";
      event1.pubkey = "test-pubkey";
      event1.created_at = Date.now() / 1000;

      const event2 = new NDKEvent();
      event2.id = "event-2";
      event2.content = "Second message";
      event2.pubkey = "test-pubkey";
      event2.created_at = Date.now() / 1000;

      await context.addEvent(event1);
      await context.addEvent(event2);

      const messages = context.getMessages();
      expect(messages.length).toBe(2);
    });

    it("should handle mixed duplicate and unique events correctly", async () => {
      const event1 = new NDKEvent();
      event1.id = "event-1";
      event1.content = "First message";
      event1.pubkey = "test-pubkey";
      event1.created_at = Date.now() / 1000;

      const event2 = new NDKEvent();
      event2.id = "event-2";
      event2.content = "Second message";
      event2.pubkey = "test-pubkey";
      event2.created_at = Date.now() / 1000;

      // Add event1
      await context.addEvent(event1);
      expect(context.getMessages().length).toBe(1);

      // Try to add event1 again (duplicate)
      await context.addEvent(event1);
      expect(context.getMessages().length).toBe(1); // Should still be 1

      // Add event2 (unique)
      await context.addEvent(event2);
      expect(context.getMessages().length).toBe(2); // Now should be 2

      // Try to add event2 again (duplicate)
      await context.addEvent(event2);
      expect(context.getMessages().length).toBe(2); // Should still be 2

      // Try to add event1 again (duplicate)
      await context.addEvent(event1);
      expect(context.getMessages().length).toBe(2); // Should still be 2
    });

    it("should persist and restore processed event IDs", () => {
      // Create a context and add some events
      const event1 = new NDKEvent();
      event1.id = "event-1";
      event1.content = "First message";

      // Simulate adding events by directly manipulating the processed IDs
      // (since we'd need async for the actual addEvent method)
      context.processedEventIds.add("event-1");
      context.processedEventIds.add("event-2");
      context.processedEventIds.add("event-3");

      // Serialize the context
      const json = context.toJSON();

      // Restore from JSON
      const restoredContext = AgentConversationContext.fromJSON(json, messageBuilder);

      // Check that processed event IDs were restored
      expect(restoredContext.processedEventIds.has("event-1")).toBe(true);
      expect(restoredContext.processedEventIds.has("event-2")).toBe(true);
      expect(restoredContext.processedEventIds.has("event-3")).toBe(true);
      expect(restoredContext.processedEventIds.size).toBe(3);
    });
  });
});
