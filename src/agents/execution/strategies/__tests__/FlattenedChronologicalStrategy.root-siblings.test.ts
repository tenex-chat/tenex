import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations";
import { ThreadService } from "@/conversations/services/ThreadService";
import { DelegationRegistry } from "@/services/DelegationRegistry";
import { NDKEvent } from "@nostr-dev-kit/ndk";
import type { ExecutionContext } from "../../types";
import { FlattenedChronologicalStrategy } from "../FlattenedChronologicalStrategy";

/**
 * Test using exact events from production issue:
 * User asks clean-code-nazi to review, it responds with scathing review,
 * then user asks claude-code for thoughts. Claude-code should see the review!
 */
describe("FlattenedChronologicalStrategy - Root Level Siblings (Production Issue)", () => {
    const USER_PUBKEY = "09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7";
    const CLEAN_CODE_NAZI_PUBKEY =
        "02131e6e0af2b75bc86d83031ef5db01561aa9db45056877605d18b84d483747";
    const CLAUDE_CODE_PUBKEY = "ca884a539b003ed7e8bc30240b048ae0df734a766f58fd4a9a650c49699e18ba";
    const CONVERSATION_ID = "test-conversation-root-siblings";

    let events: NDKEvent[];
    let strategy: FlattenedChronologicalStrategy;
    let mockConversation: Conversation;

    beforeAll(async () => {
        await DelegationRegistry.initialize();

        events = [];

        // Event 1: User asks clean-code-nazi to review
        const event1 = new NDKEvent();
        event1.id = "1e19502b9d3febac577d3b7ce3bd5888c945b2261ff0480f45c870228bac4fde";
        event1.pubkey = USER_PUBKEY;
        event1.content = "@clean-code-nazi review the chat input components";
        event1.kind = 11;
        event1.created_at = 1760903559;
        event1.tags = [
            ["title", "@clean-code-nazi review the chat input components"],
            [
                "a",
                "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-Web-Svelte-ow3jsn",
                "",
                "",
            ],
            ["p", CLEAN_CODE_NAZI_PUBKEY],
            ["nudge", "768bbd45eba20aadd03dd974b65dd4cefb22319a0899cd966c85fc117c45e5f7"],
        ];
        event1.sig =
            "ea6af4a1f53ff3f110e23b1663c86bdd37fe47a645e33ea93cdb0f9cc3ac69ff89ac9cd75678b8cbf9590cbe79e89556cf9f1eafd1643771e01cce1a0dade251";
        events.push(event1);

        // Event 2: clean-code-nazi tool call
        const event2 = new NDKEvent();
        event2.id = "30f34472d7f2b77505f451c0ba3ab60b3a6b2605b30ad2f15defb6b87a8d4fdd";
        event2.pubkey = CLEAN_CODE_NAZI_PUBKEY;
        event2.content = 'Searching codebase for "chat input" (both)';
        event2.kind = 1111;
        event2.created_at = 1760903572;
        event2.tags = [
            ["E", event1.id],
            ["K", "11"],
            ["P", USER_PUBKEY],
            ["e", event1.id],
            ["tool", "codebase_search"],
            [
                "tool-args",
                '{"query":"chat input","searchType":"both","fileType":null,"maxResults":50,"includeSnippets":false}',
            ],
            [
                "a",
                "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-Web-Svelte-ow3jsn",
                "",
                "",
            ],
            ["llm-model", "x-ai/grok-4"],
        ];
        event2.sig =
            "5124f8ed790b202e3b60a76d70ecd98ab661fac458d18ecd5a1000a230b0b373d59c5bf6ecd854ee12932e12e3b1a0ed29740d64af00b16c4271beb748b6b0ef";
        events.push(event2);

        // Event 3: clean-code-nazi's scathing review
        const event3 = new NDKEvent();
        event3.id = "4950a3d9aceb2477dca16309a02bdf114eb84006f7b59bf44032c280e43a54c2";
        event3.pubkey = CLEAN_CODE_NAZI_PUBKEY;
        event3.content =
            "This is unacceptable! I've reviewed `src/lib/components/chat/ChatInput.svelte` and it's a disaster. It massively violates the Single Responsibility Principle and is cluttered with unused imports and poor practices.\n\n### Summary\n\nThe `ChatInput.svelte` component is a classic example of a \"God Component.\" It tries to do everything: fetch data, manage complex UI state like drag-and-drop, handle file uploads, and construct and publish Nostr events. This makes it fragile, difficult to understand, and a nightmare to maintain.";
        event3.kind = 1111;
        event3.created_at = 1760903712;
        event3.tags = [
            ["E", event1.id],
            ["K", "11"],
            ["P", USER_PUBKEY],
            ["e", event1.id],
            ["p", USER_PUBKEY],
            ["status", "completed"],
            [
                "a",
                "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-Web-Svelte-ow3jsn",
                "",
                "",
            ],
            ["llm-model", "gemini 2.5 pro"],
        ];
        event3.sig =
            "59edb268bde285ee9d29fe57cce31eecbf9c7b7dc0a7e313446adcb4fc6a7095d2415bd6439c79e4a992be7ba941ba489a0778c087305523471551f6e2385c5b";
        events.push(event3);

        // Event 4: User asks claude-code for thoughts
        const event4 = new NDKEvent();
        event4.id = "4e308a71b5188f480523309a1911c9665b80cf1847d89ccbf3d48efbf5180690";
        event4.pubkey = USER_PUBKEY;
        event4.content = "@claude-code thoughts?";
        event4.kind = 1111;
        event4.created_at = 1760903782;
        event4.tags = [
            ["e", event1.id, "", USER_PUBKEY],
            ["E", event1.id, "", USER_PUBKEY],
            ["K", "11"],
            ["P", USER_PUBKEY],
            ["k", "11"],
            [
                "a",
                "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-Web-Svelte-ow3jsn",
            ],
            ["p", CLAUDE_CODE_PUBKEY],
        ];
        event4.sig =
            "6b50ff3fc22524733407232eb8f3e0502c5827fc3eaf2a4ccc547341a2668bf70052606f95d38573f3f708f32fef09b97175513efb7903ad4c237df88aaae619";
        events.push(event4);

        // Event 5: claude-code's generic response (missing context!)
        const event5 = new NDKEvent();
        event5.id = "1f800d60c92e2ebb64ee849046a747a77c3e7c4e4e32096be06398fd67cb1f1b";
        event5.pubkey = CLAUDE_CODE_PUBKEY;
        event5.content =
            "👋 Hey @Pablo Testing Pubkey!\n\n🤔 I'm here and ready to help! I see we're working on the TENEX Web Svelte project - a Nostr + Svelte application.";
        event5.kind = 1111;
        event5.created_at = 1760903852;
        event5.tags = [
            ["E", event1.id],
            ["K", "11"],
            ["P", USER_PUBKEY],
            ["e", event1.id],
            ["p", USER_PUBKEY],
            ["status", "completed"],
            [
                "a",
                "31933:09d48a1a5dbe13404a729634f1d6ba722d40513468dd713c8ea38ca9b7b6f2c7:TENEX-Web-Svelte-ow3jsn",
                "",
                "",
            ],
            ["llm-model", "claude code sonnet"],
        ];
        event5.sig =
            "d47cc5642b4cbf323242708db617c771f524822794b3f0d37c80220dc0c6673fb9d7db70ebaeb7592d32900d9c22b49afcd0ca4ea702bb7d261dcf5acadf37ea";
        events.push(event5);

        // Create mock conversation
        mockConversation = {
            id: CONVERSATION_ID,
            history: events,
            participants: new Set([USER_PUBKEY, CLEAN_CODE_NAZI_PUBKEY, CLAUDE_CODE_PUBKEY]),
            agentStates: new Map(),
            metadata: {},
            executionTime: { totalSeconds: 0, isActive: false, lastUpdated: Date.now() },
        } as Conversation;

        strategy = new FlattenedChronologicalStrategy();
    });

    it("claude-code should see clean-code-nazi's review when asked for thoughts", async () => {
        const claudeCode: AgentInstance = {
            name: "Claude Code",
            slug: "claude-code",
            pubkey: CLAUDE_CODE_PUBKEY,
            role: "assistant",
            instructions: "Test Claude Code",
            tools: [],
        };

        const threadService = new ThreadService();

        const mockContext: ExecutionContext = {
            agent: claudeCode,
            conversationId: CONVERSATION_ID,
            projectPath: "/test/path",
            triggeringEvent: events[3], // event4 = User asking claude-code
            conversationCoordinator: {
                threadService,
            } as any,
            agentPublisher: {} as any,
            getConversation: () => mockConversation,
            isDelegationCompletion: false,
        } as ExecutionContext;

        const messages = await strategy.buildMessages(mockContext, events[3]);

        const messageContents = messages.map((m) =>
            typeof m.content === "string" ? m.content : JSON.stringify(m.content)
        );

        console.log("\n=== Messages claude-code receives ===");
        messageContents.forEach((content, i) => {
            console.log(`\nMessage ${i + 1} (${messages[i].role}):`);
            console.log(content.substring(0, 150));
        });

        // Claude-code SHOULD see the root
        const hasRoot = messageContents.some((c) =>
            c.includes("@clean-code-nazi review the chat input components")
        );
        expect(hasRoot).toBe(true);

        // Claude-code SHOULD see clean-code-nazi's review (CRITICAL - sibling to triggering event)
        // This is the key fix - root-level siblings should be visible
        const hasReview = messageContents.some(
            (c) =>
                c.includes("This is unacceptable") ||
                c.includes("God Component") ||
                c.includes("Single Responsibility Principle")
        );
        expect(hasReview).toBe(true);

        // Claude-code should see the message asking for its thoughts
        const hasTriggeringMessage = messageContents.some((c) =>
            c.includes("@claude-code thoughts")
        );
        expect(hasTriggeringMessage).toBe(true);

        // Verify the review appears BEFORE the question
        const reviewIndex = messageContents.findIndex(
            (c) => c.includes("This is unacceptable") || c.includes("God Component")
        );
        const questionIndex = messageContents.findIndex((c) => c.includes("@claude-code thoughts"));
        expect(reviewIndex).toBeGreaterThan(0);
        expect(reviewIndex).toBeLessThan(questionIndex);
    });

    it("should demonstrate the threading structure", () => {
        // All replies point to the same root
        expect(events[1].tagValue("e")).toBe(events[0].id); // clean-code-nazi tool call -> root
        expect(events[2].tagValue("e")).toBe(events[0].id); // clean-code-nazi review -> root
        expect(events[3].tagValue("e")).toBe(events[0].id); // user to claude-code -> root

        // They are all siblings (direct replies to root)
        console.log("\n=== Threading Structure ===");
        console.log(`Root: ${events[0].id.substring(0, 8)} - "${events[0].content}"`);
        console.log(
            `  ├─ ${events[1].id.substring(0, 8)} - "${events[1].content.substring(0, 50)}..."`
        );
        console.log(
            `  ├─ ${events[2].id.substring(0, 8)} - "${events[2].content.substring(0, 50)}..."`
        );
        console.log(`  └─ ${events[3].id.substring(0, 8)} - "${events[3].content}"`);
    });
});
