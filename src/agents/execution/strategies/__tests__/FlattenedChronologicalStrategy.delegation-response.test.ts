import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { DelegationRegistryService } from "@/services/delegation";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import "./test-mocks"; // Import shared mocks
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";
import "./test-mocks"; // Import shared mocks
import testData from "./delegation-response-test-data.json";

/**
 * Test for delegation response detection bug
 *
 * Issue: Events from delegated agent that don't p-tag the delegating agent
 * are being incorrectly included as "delegation results"
 *
 * Expected behavior:
 * - Events abf94738 and f871e4ea should NOT be shown to PM (they don't p-tag PM)
 * - Event 52c6c5df SHOULD be shown to PM (it p-tags PM and has status:completed)
 */
describe("FlattenedChronologicalStrategy - Delegation Response Detection", () => {
    const PM_PUBKEY = "b22bfe6faddb0f8aa4f24ea3827fd7610007f6d27cbc4c1fea1ff7404ee5a2e9";
    const CLAUDE_CODE_PUBKEY = "68e415c353760d3cbb9b3c3f52627e54307b87f8eefb6dc4f533b1a010442f43";
    const USER_PUBKEY = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";
    const CONVERSATION_ID = "516342a3e10658f39d34ec9d18fafe6a740aa04805d2069e2abacd45397a2fb5";

    let events: NDKEvent[];
    let strategy: FlattenedChronologicalStrategy;
    let mockContext: ExecutionContext;
    let mockConversation: Conversation;

    beforeAll(async () => {
        // Load test events
        events = testData.map((eventData) => {
            const event = new NDKEvent();
            event.id = eventData.id;
            event.pubkey = eventData.pubkey;
            event.content = eventData.content;
            event.kind = eventData.kind;
            event.created_at = eventData.created_at;
            event.tags = eventData.tags;
            event.sig = eventData.sig || "";
            return event;
        });

        // Initialize services
        await DelegationRegistryService.initialize();

        // Create mock conversation
        mockConversation = {
            id: CONVERSATION_ID,
            history: events,
            participants: new Set([USER_PUBKEY, PM_PUBKEY, CLAUDE_CODE_PUBKEY]),
        } as Conversation;

        // Register the delegation
        const delegationRegistry = DelegationRegistryService.getInstance();
        const pmAgent: AgentInstance = {
            name: "Project Manager",
            slug: "project-manager",
            pubkey: PM_PUBKEY,
            role: "PM",
            instructions: "Test PM",
            tools: [],
        };
        const claudeCodeAgent: AgentInstance = {
            name: "Claude Code",
            slug: "claude-code",
            pubkey: CLAUDE_CODE_PUBKEY,
            role: "Agent",
            instructions: "Test",
            tools: [],
        };
        await delegationRegistry.registerDelegation({
            delegationEventId: "1a4e52fb76791050425f81ec49db55b39093142fd8c1ab46c520bfe51d92373a",
            recipients: [
                {
                    pubkey: CLAUDE_CODE_PUBKEY,
                    request:
                        "Tell me how many uncommitted files we have and what their changes are.",
                    phase: "EXECUTE",
                },
            ],
            delegatingAgent: pmAgent,
            rootConversationId: CONVERSATION_ID,
            originalRequest:
                "Tell me how many uncommitted files we have and what their changes are.",
        });

        // Create strategy
        strategy = new FlattenedChronologicalStrategy();

        // Create mock agent
        const mockAgent: AgentInstance = {
            name: "Project Manager",
            slug: "project-manager",
            pubkey: PM_PUBKEY,
            role: "PM",
            instructions: "Test PM",
            tools: [],
        };

        // Create mock execution context (will be updated per test)
        mockContext = {
            agent: mockAgent,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[events.length - 1], // Default to last event
            conversationCoordinator: {
                threadService: new (
                    await import("@/conversations/services/ThreadService")
                ).ThreadService(),
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;
    });

    it("should NOT include intermediate claude-code messages that don't p-tag PM", async () => {
        const triggeringEvent = events[events.length - 1];
        mockContext.triggeringEvent = triggeringEvent;
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== All Messages ===");
        messageContents.forEach((content, i) => {
            console.log(`\nMessage ${i + 1}:`, content.substring(0, 200));
            if (content.includes("📊 Let me check")) {
                console.log("  → Contains '📊 Let me check'");
                console.log(
                    "  → Has delegation marker:",
                    content.includes("[delegation result from")
                );
            }
        });

        // Event abf94738: "📊 Let me check the uncommitted files..."
        // This event does NOT p-tag PM, so should NOT appear as a STANDALONE message from claude-code
        // (It's OK for it to appear inside a delegation XML block or tool result)
        const hasIntermediateMessage1AsStandalone = messageContents.some(
            (content) =>
                content.includes("📊 Let me check the uncommitted files") &&
                !content.includes("<delegation") &&
                !content.includes("[delegation result from") &&
                !content.includes("tool-result")
        );
        expect(hasIntermediateMessage1AsStandalone).toBe(false);

        // Event f871e4ea: "📈 Now let me get the detailed changes..."
        // This event does NOT p-tag PM, so should NOT appear as a STANDALONE message from claude-code
        const hasIntermediateMessage2AsStandalone = messageContents.some(
            (content) =>
                content.includes("📈 Now let me get the detailed changes") &&
                !content.includes("<delegation") &&
                !content.includes("[delegation result from") &&
                !content.includes("tool-result")
        );
        expect(hasIntermediateMessage2AsStandalone).toBe(false);
    });

    it("should include the completion message that p-tags PM and mark it as delegation result", async () => {
        const triggeringEvent = events[events.length - 1];
        mockContext.triggeringEvent = triggeringEvent;
        const messages = await strategy.buildMessages(mockContext, triggeringEvent);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        // Event 52c6c5df: The actual delegation completion
        // This event DOES p-tag PM and has status:completed, so SHOULD be in messages
        const hasCompletionMessage = messageContents.some(
            (content) =>
                content.includes("📋 **Summary: You have 13 uncommitted files**") ||
                content.includes("13 uncommitted files")
        );
        expect(hasCompletionMessage).toBe(true);

        // It should appear within delegation context (either XML block or result marker)
        // Note: Shows "from User" because PubkeyNameRepository fallback when project context not initialized
        const hasDelegationContextForCompletion = messageContents.some(
            (content) =>
                (content.includes("<delegation") || content.includes("[delegation result from")) &&
                (content.includes("📋 **Summary: You have 13 uncommitted files**") ||
                    content.includes("13 uncommitted files"))
        );
        expect(hasDelegationContextForCompletion).toBe(true);
    });
});
