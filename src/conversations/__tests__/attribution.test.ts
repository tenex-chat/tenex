/**
 * Unit tests for computeAttributionPrefix and multi-agent attribution in MessageBuilder.
 *
 * Tests the 5 priority rules for message attribution:
 * 1. Self message → no prefix
 * 2. Non-text entry → no prefix
 * 3. Has targetedPubkeys NOT including viewing agent → routing prefix
 * 4. Sender is agent → attribution prefix
 * 5. Otherwise (user message to me or no targeting) → no prefix
 */

import { describe, test, expect } from "bun:test";
import { computeAttributionPrefix, buildMessagesFromEntries, type MessageBuilderContext } from "../MessageBuilder";
import type { ConversationEntry } from "../types";

describe("computeAttributionPrefix", () => {
    // Test pubkeys
    const viewingAgentPubkey = "agent2-pubkey-abcdef1234567890";
    const agent1Pubkey = "agent1-pubkey-1234567890abcdef";
    const agent3Pubkey = "agent3-pubkey-fedcba0987654321";
    const userPubkey = "user-pubkey-pablopablopablo12";
    const unknownPubkey = "ab12cd34ef567890abcdef1234567890";

    // Known agent pubkeys (viewing agent is also an agent)
    const agentPubkeys = new Set([viewingAgentPubkey, agent1Pubkey, agent3Pubkey]);

    // Deterministic name resolver for tests
    const resolveDisplayName = (pubkey: string): string => {
        const names: Record<string, string> = {
            [viewingAgentPubkey]: "agent2",
            [agent1Pubkey]: "agent1",
            [agent3Pubkey]: "agent3",
            [userPubkey]: "Pablo",
        };
        return names[pubkey] ?? pubkey.substring(0, 8);
    };

    // Test 1: Self-message → no prefix
    test("self-message returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: viewingAgentPubkey,
            content: "I am responding",
            messageType: "text",
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    // Test 2: Tool-call entry → no prefix
    test("tool-call entry returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "",
            messageType: "tool-call",
            toolData: [{
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "fs_read",
                args: { path: "/file.txt" },
            }],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    // Test 3: Tool-result entry → no prefix
    test("tool-result entry returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "",
            messageType: "tool-result",
            toolData: [{
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "fs_read",
                result: { content: "file contents" },
            }],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    // Test 4: Agent message targeted elsewhere → routing prefix
    test("agent message targeted elsewhere returns routing prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "Emerald green! 🌿",
            messageType: "text",
            targetedPubkeys: [agent3Pubkey],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@agent1 -> @agent3] ");
    });

    // Test 5: User message targeted elsewhere → routing prefix
    test("user message targeted elsewhere returns routing prefix", () => {
        const entry: ConversationEntry = {
            pubkey: userPubkey,
            content: "say a random color",
            messageType: "text",
            targetedPubkeys: [agent1Pubkey],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@Pablo -> @agent1] ");
    });

    // Test 6: Agent message targeted to me → attribution prefix (just sender)
    test("agent message targeted to me returns attribution prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "Here is your result",
            messageType: "text",
            targetedPubkeys: [viewingAgentPubkey],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@agent1] ");
    });

    // Test 7: Agent message with no targeting → attribution prefix
    test("agent message with no targeting returns attribution prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "Broadcasting to everyone",
            messageType: "text",
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@agent1] ");
    });

    // Test 8: User message targeted to me → no prefix
    test("user message targeted to me returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: userPubkey,
            content: "tell me who said what",
            messageType: "text",
            targetedPubkeys: [viewingAgentPubkey],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    // Test 9: User message with no targeting → no prefix
    test("user message with no targeting returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: userPubkey,
            content: "Hello everyone",
            messageType: "text",
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    // Test 10: Multi-recipient message → uses first recipient
    test("multi-recipient message uses first recipient in routing prefix", () => {
        const entry: ConversationEntry = {
            pubkey: userPubkey,
            content: "message to two agents",
            messageType: "text",
            targetedPubkeys: [agent1Pubkey, agent3Pubkey],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@Pablo -> @agent1] ");
    });

    // Test 11: Unknown pubkey → hex fallback
    test("unknown pubkey falls back to hex prefix", () => {
        const entry: ConversationEntry = {
            pubkey: unknownPubkey,
            content: "message from unknown",
            messageType: "text",
            targetedPubkeys: [agent1Pubkey],
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        // unknownPubkey is not in agentPubkeys, not self → Rule 3 applies (targeted elsewhere)
        expect(prefix).toBe(`[@${unknownPubkey.substring(0, 8)} -> @agent1] `);
    });

    // Test 12: Injected message with senderPubkey → uses senderPubkey for attribution
    test("injected message with senderPubkey uses senderPubkey for attribution", () => {
        const entry: ConversationEntry = {
            pubkey: viewingAgentPubkey, // The injection target
            senderPubkey: agent1Pubkey, // The actual sender
            content: "injected message from agent1",
            messageType: "text",
            targetedPubkeys: [viewingAgentPubkey],
        };

        // senderPubkey (agent1) !== viewingAgentPubkey → not self
        // targetedPubkeys includes viewingAgent → skip Rule 3
        // senderPubkey (agent1) is in agentPubkeys → Rule 4 applies
        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@agent1] ");
    });

    // Test 13: Message with empty targetedPubkeys array → treated as no targeting
    test("message with empty targetedPubkeys array is treated as no targeting", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "message with empty targeting",
            messageType: "text",
            targetedPubkeys: [],
        };

        // Empty array → hasTargeting is false → skip Rule 3
        // agent1 is in agentPubkeys → Rule 4 applies
        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("[@agent1] ");
    });

    // Additional edge cases

    test("entry with explicit role override returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "compressed summary",
            messageType: "text",
            role: "system",
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    test("delegation-marker entry returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            content: "",
            messageType: "delegation-marker",
            delegationMarker: {
                delegationConversationId: "conv-123",
                parentConversationId: "parent-456",
                recipientPubkey: agent3Pubkey,
                status: "completed",
            },
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });

    test("injected message where senderPubkey is self returns no prefix", () => {
        const entry: ConversationEntry = {
            pubkey: agent1Pubkey,
            senderPubkey: viewingAgentPubkey, // Self is the sender
            content: "self-injected message",
            messageType: "text",
        };

        const prefix = computeAttributionPrefix(entry, viewingAgentPubkey, agentPubkeys, resolveDisplayName);
        expect(prefix).toBe("");
    });
});

describe("Multi-agent attribution integration", () => {
    // Simulate the scenario from the bug report: agent2 viewing a shared conversation
    const viewingAgentPubkey = "agent2-pubkey-abcdef1234567890";
    const transparentPubkey = "transparent-pubkey-12345678";
    const agent1Pubkey = "agent1-pubkey-1234567890abcdef";
    const pabloPubkey = "user-pubkey-pablopablopablo12";

    const agentPubkeys = new Set([viewingAgentPubkey, transparentPubkey, agent1Pubkey]);

    function createContext(overrides: Partial<MessageBuilderContext> = {}): MessageBuilderContext {
        return {
            viewingAgentPubkey,
            ralNumber: 1,
            activeRals: new Set([1]),
            totalMessages: 10,
            indexOffset: 0,
            agentPubkeys,
            ...overrides,
        };
    }

    test("full multi-agent conversation shows correct attribution for agent2 view", async () => {
        const entries: ConversationEntry[] = [
            // Pablo → transparent: "say a random color"
            {
                pubkey: pabloPubkey,
                content: "say a random color",
                messageType: "text",
                targetedPubkeys: [transparentPubkey],
            },
            // transparent → Pablo: "Cyan! 💎"
            {
                pubkey: transparentPubkey,
                content: "Cyan! 💎",
                messageType: "text",
                targetedPubkeys: [pabloPubkey],
            },
            // Pablo → agent1: "say a different random color"
            {
                pubkey: pabloPubkey,
                content: "say a different random color",
                messageType: "text",
                targetedPubkeys: [agent1Pubkey],
            },
            // agent1 → Pablo: "Emerald green! 🌿"
            {
                pubkey: agent1Pubkey,
                content: "Emerald green! 🌿",
                messageType: "text",
                targetedPubkeys: [pabloPubkey],
            },
            // Pablo → agent2 (viewing): "tell me who said what"
            {
                pubkey: pabloPubkey,
                content: "tell me who said what in the current conversation",
                messageType: "text",
                targetedPubkeys: [viewingAgentPubkey],
            },
        ];

        const ctx = createContext({ totalMessages: entries.length });
        const messages = await buildMessagesFromEntries(entries, ctx);

        expect(messages).toHaveLength(5);

        // All should be "user" role (none are from agent2)
        for (const msg of messages) {
            expect(msg.role).toBe("user");
        }

        // Message 1: Pablo → transparent (not for agent2 → routing prefix)
        const content1 = messages[0].content as string;
        expect(content1).toContain("say a random color");
        expect(content1).toMatch(/^\[/); // Has prefix

        // Message 2: transparent → Pablo (not for agent2 → routing prefix)
        const content2 = messages[1].content as string;
        expect(content2).toContain("Cyan!");
        expect(content2).toMatch(/^\[/);

        // Message 3: Pablo → agent1 (not for agent2 → routing prefix)
        const content3 = messages[2].content as string;
        expect(content3).toContain("say a different random color");
        expect(content3).toMatch(/^\[/);

        // Message 4: agent1 → Pablo (not for agent2 → routing prefix)
        const content4 = messages[3].content as string;
        expect(content4).toContain("Emerald green!");
        expect(content4).toMatch(/^\[/);

        // Message 5: Pablo → agent2 (targeted to me, user → no prefix)
        const content5 = messages[4].content as string;
        expect(content5).toBe("tell me who said what in the current conversation");
    });

    test("agent messages with no targeting get attribution but user messages do not", async () => {
        const entries: ConversationEntry[] = [
            {
                pubkey: pabloPubkey,
                content: "Hello",
                messageType: "text",
            },
            {
                pubkey: agent1Pubkey,
                content: "Hi from agent1",
                messageType: "text",
            },
            {
                pubkey: transparentPubkey,
                content: "Hi from transparent",
                messageType: "text",
            },
        ];

        const ctx = createContext({ totalMessages: entries.length });
        const messages = await buildMessagesFromEntries(entries, ctx);

        // User message: no prefix
        expect((messages[0].content as string)).toBe("Hello");

        // Agent messages: attribution prefix (no targeting → Rule 4)
        expect((messages[1].content as string)).toMatch(/^\[@/);
        expect((messages[1].content as string)).toContain("Hi from agent1");

        expect((messages[2].content as string)).toMatch(/^\[@/);
        expect((messages[2].content as string)).toContain("Hi from transparent");
    });

    test("self messages never get attribution prefix", async () => {
        const entries: ConversationEntry[] = [
            {
                pubkey: pabloPubkey,
                content: "Do something",
                messageType: "text",
                targetedPubkeys: [viewingAgentPubkey],
            },
            {
                pubkey: viewingAgentPubkey,
                ral: 1,
                content: "I will do it",
                messageType: "text",
            },
        ];

        const ctx = createContext({ totalMessages: entries.length });
        const messages = await buildMessagesFromEntries(entries, ctx);

        expect(messages[0].role).toBe("user");
        expect(messages[0].content).toBe("Do something");

        expect(messages[1].role).toBe("assistant");
        expect(messages[1].content).toBe("I will do it");
    });

    test("empty agentPubkeys set treats all non-self as users (no attribution)", async () => {
        const entries: ConversationEntry[] = [
            {
                pubkey: agent1Pubkey,
                content: "message from another",
                messageType: "text",
            },
        ];

        const ctx = createContext({
            totalMessages: entries.length,
            agentPubkeys: new Set<string>(), // No known agents
        });
        const messages = await buildMessagesFromEntries(entries, ctx);

        // Without agentPubkeys info, Rule 4 doesn't match → Rule 5 → no prefix
        expect(messages[0].content).toBe("message from another");
    });
});
