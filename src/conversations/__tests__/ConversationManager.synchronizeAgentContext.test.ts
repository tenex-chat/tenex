import { describe, it, expect, beforeEach, mock } from "bun:test";
import { ConversationManager } from "../ConversationManager";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { Message } from "multi-llm-ts";
import type { AgentContext } from "../types";
import * as nostrUtils from "@/nostr/utils";
import * as services from "@/services";

// Mock the fs module
mock.module("@/lib/fs", () => ({
    ensureDirectory: mock(),
    fileExists: mock(),
    readFile: mock(),
    writeJsonFile: mock(),
}));

// Mock the persistence module
mock.module("../persistence", () => ({
    FileSystemAdapter: mock(() => ({
        initialize: mock().mockResolvedValue(undefined),
        save: mock().mockResolvedValue(undefined),
        list: mock().mockResolvedValue([]),
        load: mock().mockResolvedValue(null),
    })),
}));

// Mock nostr utils
mock.module("@/nostr/utils", () => ({
    getAgentSlugFromEvent: mock(),
    isEventFromUser: mock(),
}));

// Mock services
mock.module("@/services", () => ({
    getProjectContext: mock(() => ({
        agents: new Map([
            ["agent-1", { name: "Agent One", slug: "agent-1", pubkey: "pubkey-1" }],
            ["agent-2", { name: "Agent Two", slug: "agent-2", pubkey: "pubkey-2" }],
            ["pm-agent", { name: "PM Agent", slug: "pm-agent", pubkey: "pubkey-pm" }],
        ]),
    })),
}));

describe("ConversationManager.synchronizeAgentContext", () => {
    let manager: ConversationManager;
    const projectPath = "/test/project";
    
    // Helper to create mock events
    const createMockEvent = (id: string, content: string, created_at: number): NDKEvent => ({
        id,
        content,
        created_at,
        tags: [],
    } as NDKEvent);

    beforeEach(async () => {
        manager = new ConversationManager(projectPath);
        await manager.initialize();
    });

    describe("when agent has no missed events", () => {
        it("should not add any historical context messages", async () => {
            // Create conversation
            const event = createMockEvent("event-1", "Initial message", Date.now() / 1000);
            (nostrUtils.isEventFromUser as any).mockReturnValue(true);
            
            const conversation = await manager.createConversation(event);
            
            // Create agent context
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            
            // Update last update time to be after all events
            agentContext.lastUpdate = new Date(Date.now() + 1000);
            
            // Synchronize context
            await manager.synchronizeAgentContext(conversation.id, "agent-1");
            
            // Should not have added any new messages
            expect(agentContext.messages).toHaveLength(0);
        });
    });

    describe("when agent has missed events", () => {
        it("should add historical context for missed messages", async () => {
            // Create conversation
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime);
            (nostrUtils.isEventFromUser as any).mockReturnValue(true);
            
            const conversation = await manager.createConversation(event);
            
            // Create agent context with old lastUpdate
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            agentContext.lastUpdate = new Date((initialTime - 3600) * 1000); // 1 hour ago
            
            // Add some events that happened after agent's last update
            const missedEvent1 = createMockEvent("event-2", "Missed message 1", initialTime - 1800);
            const missedEvent2 = createMockEvent("event-3", "Missed message 2", initialTime - 900);
            
            await manager.addEvent(conversation.id, missedEvent1);
            await manager.addEvent(conversation.id, missedEvent2);
            
            // Mock agent detection
            (nostrUtils.isEventFromUser as any).mockImplementation((event: NDKEvent) => {
                return event.id === "event-1" || event.id === "event-2";
            });
            (nostrUtils.getAgentSlugFromEvent as any).mockImplementation((event: NDKEvent) => {
                if (event.id === "event-3") return "agent-2";
                return null;
            });
            
            // Synchronize context
            await manager.synchronizeAgentContext(conversation.id, "agent-1");
            
            // Should have added one system message with historical context
            expect(agentContext.messages).toHaveLength(1);
            const historicalMsg = agentContext.messages[0];
            expect(historicalMsg.role).toBe("system");
            expect(historicalMsg.content).toContain("<conversation-history>");
            expect(historicalMsg.content).toContain("[User]: Missed message 1");
            expect(historicalMsg.content).toContain("[Agent Two]: Missed message 2");
            expect(historicalMsg.content).toContain("</conversation-history>");
        });

        it("should skip agent's own messages from historical context", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            agentContext.lastUpdate = new Date((initialTime - 3600) * 1000);
            
            // Add events including one from the agent itself
            const missedEvent1 = createMockEvent("event-2", "Message from agent-1", initialTime - 1800);
            const missedEvent2 = createMockEvent("event-3", "Message from agent-2", initialTime - 900);
            
            await manager.addEvent(conversation.id, missedEvent1);
            await manager.addEvent(conversation.id, missedEvent2);
            
            // Mock agent detection
            (nostrUtils.getAgentSlugFromEvent as any).mockImplementation((event: NDKEvent) => {
                if (event.id === "event-2") return "agent-1"; // Agent's own message
                if (event.id === "event-3") return "agent-2";
                return null;
            });
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1");
            
            // Should only include agent-2's message, not agent-1's own message
            const historicalMsg = agentContext.messages[0];
            expect(historicalMsg.content).toContain("[Agent Two]: Message from agent-2");
            expect(historicalMsg.content).not.toContain("Message from agent-1");
        });
    });

    describe("when there's a triggering event", () => {
        it("should add user triggering event as a user message", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            
            // Create a new triggering event from user
            const triggeringEvent = createMockEvent("event-2", "New user request", initialTime + 100);
            (nostrUtils.isEventFromUser as any).mockImplementation((event: NDKEvent) => {
                return event.id === "event-2";
            });
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1", triggeringEvent);
            
            // Should have added the user message
            expect(agentContext.messages).toHaveLength(1);
            expect(agentContext.messages[0].role).toBe("user");
            expect(agentContext.messages[0].content).toBe("New user request");
        });

        it("should add agent triggering event with proper attribution", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            
            // Create a triggering event from another agent
            const triggeringEvent = createMockEvent("event-2", "Message from agent-2", initialTime + 100);
            (nostrUtils.isEventFromUser as any).mockReturnValue(false);
            (nostrUtils.getAgentSlugFromEvent as any).mockImplementation((event: NDKEvent) => {
                if (event.id === "event-2") return "agent-2";
                return null;
            });
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1", triggeringEvent);
            
            // Should have added one system message with proper attribution
            expect(agentContext.messages).toHaveLength(1);
            expect(agentContext.messages[0].role).toBe("system");
            expect(agentContext.messages[0].content).toBe("[Agent Two]: Message from agent-2");
        });

        it("should add separator between historical and new messages", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime - 7200);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            agentContext.lastUpdate = new Date((initialTime - 3600) * 1000);
            
            // Add a missed event
            const missedEvent = createMockEvent("event-2", "Missed message", initialTime - 1800);
            await manager.addEvent(conversation.id, missedEvent);
            
            // Create a new triggering event
            const triggeringEvent = createMockEvent("event-3", "New request", initialTime + 100);
            
            (nostrUtils.isEventFromUser as any).mockImplementation((event: NDKEvent) => {
                return event.id !== "event-2"; // event-2 is from an agent
            });
            (nostrUtils.getAgentSlugFromEvent as any).mockImplementation((event: NDKEvent) => {
                if (event.id === "event-2") return "agent-2";
                return null;
            });
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1", triggeringEvent);
            
            // Should have: historical context, separator, new message
            expect(agentContext.messages).toHaveLength(3);
            expect(agentContext.messages[0].content).toContain("<conversation-history>");
            expect(agentContext.messages[1].role).toBe("system");
            expect(agentContext.messages[1].content).toBe("=== NEW INTERACTION ===");
            expect(agentContext.messages[2].role).toBe("user");
            expect(agentContext.messages[2].content).toBe("New request");
        });

        it("should not add triggering event as action if it's old and already processed", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime - 3600);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            
            // Add triggering event to history first
            const triggeringEvent = createMockEvent("event-2", "Already processed", initialTime - 1800);
            await manager.addEvent(conversation.id, triggeringEvent);
            
            // Add a newer event after the triggering event
            const newerEvent = createMockEvent("event-3", "Newer message", initialTime - 900);
            await manager.addEvent(conversation.id, newerEvent);
            
            // Set lastUpdate between triggering event and newer event
            agentContext.lastUpdate = new Date((initialTime - 1200) * 1000); // After triggering event but before newer event
            
            (nostrUtils.isEventFromUser as any).mockReturnValue(true);
            
            // Synchronize with the old event as triggering
            await manager.synchronizeAgentContext(conversation.id, "agent-1", triggeringEvent);
            
            // Should only add the newer event to historical context, not the triggering event as action
            expect(agentContext.messages).toHaveLength(1);
            expect(agentContext.messages[0].content).toContain("<conversation-history>");
            expect(agentContext.messages[0].content).toContain("Newer message");
            expect(agentContext.messages[0].content).not.toContain("Already processed");
        });
    });

    describe("edge cases", () => {
        it("should handle events without content", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            agentContext.lastUpdate = new Date((initialTime - 3600) * 1000);
            
            // Add event with content and event without content
            const validEvent = createMockEvent("event-2", "Valid content", initialTime - 1800);
            const emptyEvent = createMockEvent("event-3", "", initialTime - 900);
            const nullEvent = { ...createMockEvent("event-4", "has content", initialTime - 600), content: null };
            
            await manager.addEvent(conversation.id, validEvent);
            await manager.addEvent(conversation.id, emptyEvent);
            await manager.addEvent(conversation.id, nullEvent as NDKEvent);
            
            (nostrUtils.isEventFromUser as any).mockReturnValue(true);
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1");
            
            // Should only include the valid event in historical context
            expect(agentContext.messages).toHaveLength(1);
            expect(agentContext.messages[0].content).toContain("Valid content");
            expect(agentContext.messages[0].content).not.toContain("has content"); // null content excluded
        });

        it("should handle unknown agent attribution", async () => {
            const initialTime = Date.now() / 1000;
            const event = createMockEvent("event-1", "Initial message", initialTime);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            agentContext.lastUpdate = new Date((initialTime - 3600) * 1000);
            
            // Add event from unknown agent
            const unknownEvent = createMockEvent("event-2", "From unknown", initialTime - 900);
            await manager.addEvent(conversation.id, unknownEvent);
            
            (nostrUtils.isEventFromUser as any).mockReturnValue(false);
            (nostrUtils.getAgentSlugFromEvent as any).mockReturnValue("unknown-agent");
            
            // Mock getProjectContext to not have this agent
            (services.getProjectContext as any).mockReturnValue({
                agents: new Map(), // Empty agents map
            });
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1");
            
            // Should attribute to "Another agent"
            expect(agentContext.messages[0].content).toContain("[Another agent]: From unknown");
        });
    });

    describe("lastUpdate tracking", () => {
        it("should update lastUpdate after synchronization", async () => {
            const initialTime = Date.now();
            const event = createMockEvent("event-1", "Initial message", initialTime / 1000);
            
            const conversation = await manager.createConversation(event);
            const agentContext = manager.createAgentContext(conversation.id, "agent-1");
            
            const oldUpdate = agentContext.lastUpdate;
            
            // Wait a bit to ensure time difference
            await new Promise(resolve => setTimeout(resolve, 10));
            
            await manager.synchronizeAgentContext(conversation.id, "agent-1");
            
            expect(agentContext.lastUpdate.getTime()).toBeGreaterThan(oldUpdate.getTime());
        });
    });
});