import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";

/**
 * Test for condensed delegation XML format
 *
 * Expected behavior:
 * - Delegation should be condensed into single XML block
 * - XML should include phase attribute
 * - Phase transition message should NOT appear separately
 * - Delegation request event should NOT appear as separate assistant message
 */
describe("FlattenedChronologicalStrategy - Condensed Delegation XML", () => {
    const PM_PUBKEY = "pm-pubkey-test-123";
    const NOSTR_EXPERT_PUBKEY = "nostr-expert-pubkey-test-456";
    const USER_PUBKEY = "user-pubkey-test-789";
    const CONVERSATION_ID = "test-conversation-id-123";

    let events: NDKEvent[];
    let strategy: FlattenedChronologicalStrategy;
    let mockContext: ExecutionContext;
    let mockConversation: Conversation;

    beforeAll(async () => {
        // Initialize services
        await DelegationRegistry.initialize();

        // Create mock events representing a delegation flow
        events = [];

        // Event 1: User asks PM something
        const userEvent = new NDKEvent();
        userEvent.id = "user-event-123";
        userEvent.pubkey = USER_PUBKEY;
        userEvent.content = "Tell me a fact about Nostr";
        userEvent.kind = 1;
        userEvent.created_at = 1000;
        userEvent.tags = [["p", PM_PUBKEY]];
        userEvent.sig = "sig1";
        events.push(userEvent);

        // Event 2: PM's tool-call event (delegate_phase)
        const toolCallEvent = new NDKEvent();
        toolCallEvent.id = "tool-call-event-456";
        toolCallEvent.pubkey = PM_PUBKEY;
        toolCallEvent.content = "";
        toolCallEvent.kind = 1111;
        toolCallEvent.created_at = 1001;
        toolCallEvent.tags = [
            ["e", userEvent.id, "", "root"],
            ["p", USER_PUBKEY],
            ["tool", "delegate_phase"],
            [
                "tool-args",
                JSON.stringify({
                    recipients: ["nostr-expert"],
                    request: "Tell me one fact about Nostr, just 2 sentences max",
                }),
            ],
        ];
        toolCallEvent.sig = "sig2";
        events.push(toolCallEvent);

        // Event 3: The actual delegation event (created by DelegationService)
        const delegationEvent = new NDKEvent();
        delegationEvent.id = "delegation-event-789";
        delegationEvent.pubkey = PM_PUBKEY;
        delegationEvent.content =
            "@nostr-expert: Tell me one fact about Nostr, just 2 sentences max";
        delegationEvent.kind = 1111;
        delegationEvent.created_at = 1002;
        delegationEvent.tags = [
            ["e", userEvent.id, "", "root"],
            ["p", NOSTR_EXPERT_PUBKEY],
            ["p", USER_PUBKEY],
            ["phase", "chat"],
            ["phase-instructions", "Please provide a brief fact"],
        ];
        delegationEvent.sig = "sig3";
        events.push(delegationEvent);

        // Event 4: Nostr expert's response
        const responseEvent = new NDKEvent();
        responseEvent.id = "response-event-abc";
        responseEvent.pubkey = NOSTR_EXPERT_PUBKEY;
        responseEvent.content =
            "Nostr is a decentralized protocol where users are identified by cryptographic keys rather than usernames, and all events are cryptographically signed by the author. The protocol uses relays as simple message-passing servers that store and forward events without validating their content.";
        responseEvent.kind = 1111;
        responseEvent.created_at = 1003;
        responseEvent.tags = [
            ["e", delegationEvent.id, "", "reply"],
            ["e", userEvent.id, "", "root"],
            ["p", PM_PUBKEY], // This p-tags PM, making it a delegation response
            ["p", USER_PUBKEY],
        ];
        responseEvent.sig = "sig4";
        events.push(responseEvent);

        // Create mock conversation
        mockConversation = {
            id: CONVERSATION_ID,
            history: events,
            participants: new Set([USER_PUBKEY, PM_PUBKEY, NOSTR_EXPERT_PUBKEY]),
        } as Conversation;

        // Register the delegation
        const delegationRegistry = DelegationRegistry.getInstance();
        const pmAgent: AgentInstance = {
            name: "Project Manager",
            slug: "project-manager",
            pubkey: PM_PUBKEY,
            role: "PM",
            instructions: "Test PM",
            tools: [],
        };
        const nostrExpertAgent: AgentInstance = {
            name: "Nostr Expert",
            slug: "nostr-expert",
            pubkey: NOSTR_EXPERT_PUBKEY,
            role: "Expert",
            instructions: "Test Expert",
            tools: [],
        };

        await delegationRegistry.registerDelegation({
            delegationEventId: delegationEvent.id,
            recipients: [
                {
                    pubkey: NOSTR_EXPERT_PUBKEY,
                    request: "Tell me one fact about Nostr, just 2 sentences max",
                    phase: "chat",
                },
            ],
            delegatingAgent: pmAgent,
            rootConversationId: CONVERSATION_ID,
            originalRequest: "Tell me one fact about Nostr, just 2 sentences max",
        });

        // Update the delegation record to include the slug (normally done by DelegationService)
        const convKey = `${CONVERSATION_ID}:${PM_PUBKEY}:${NOSTR_EXPERT_PUBKEY}`;
        const record = delegationRegistry.getDelegationByConversationKey(
            CONVERSATION_ID,
            PM_PUBKEY,
            NOSTR_EXPERT_PUBKEY
        );
        if (record) {
            record.assignedTo.slug = "nostr-expert";
        }

        // Create strategy
        strategy = new FlattenedChronologicalStrategy();

        // Create ThreadService
        const { ThreadService } = await import("@/conversations/services/ThreadService");
        const threadService = new ThreadService();

        // Create mock execution context
        mockContext = {
            agent: pmAgent,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[events.length - 1], // Default to last event
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
            debug: true, // Enable debug mode to see event IDs
        } as ExecutionContext;
    });

    it("should condense delegation into single XML block with phase attribute", async () => {
        const triggeringEvent = events[events.length - 1];
        mockContext.triggeringEvent = triggeringEvent;
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== All Messages ===");
        messageContents.forEach((content, i) => {
            console.log(`\nMessage ${i + 1} (${messages[i].role}):`, content);
        });

        // Should have a single delegation XML block
        const delegationXmlMessages = messageContents.filter(
            (content) => content.includes("<delegation") && content.includes("</delegation>")
        );
        expect(delegationXmlMessages.length).toBe(1);

        const delegationXml = delegationXmlMessages[0];

        // Should include phase attribute
        expect(delegationXml).toContain('phase="chat"');

        // Should include delegation-request tag
        expect(delegationXml).toContain("<delegation-request>");
        expect(delegationXml).toContain("Tell me one fact about Nostr");

        // Should include response
        expect(delegationXml).toContain('<response from="nostr-expert"');
        expect(delegationXml).toContain("decentralized protocol");
    });

    it("should NOT include separate phase transition message", async () => {
        const triggeringEvent = events[events.length - 1];
        mockContext.triggeringEvent = triggeringEvent;
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        // Should NOT have a separate phase transition message
        const phaseTransitionMessages = messageContents.filter(
            (content) =>
                content.includes("=== PHASE TRANSITION:") && !content.includes("<delegation")
        );
        expect(phaseTransitionMessages.length).toBe(0);
    });

    it("should NOT include delegation request event as separate assistant message", async () => {
        const triggeringEvent = events[events.length - 1];
        mockContext.triggeringEvent = triggeringEvent;
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        // Should NOT have the delegation request as a separate assistant message
        // (outside the XML block)
        const standaloneRequestMessages = messageContents.filter(
            (content) =>
                content.includes("@nostr-expert: Tell me one fact") &&
                !content.includes("<delegation")
        );
        expect(standaloneRequestMessages.length).toBe(0);
    });

    it("should NOT include delegation response as separate message", async () => {
        const triggeringEvent = events[events.length - 1];
        mockContext.triggeringEvent = triggeringEvent;
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        // Should NOT have the response as a separate message outside the XML
        const standaloneResponseMessages = messageContents.filter(
            (content) =>
                content.includes("decentralized protocol") &&
                !content.includes("<delegation") &&
                !content.includes("[delegation result from")
        );
        expect(standaloneResponseMessages.length).toBe(0);
    });
});
