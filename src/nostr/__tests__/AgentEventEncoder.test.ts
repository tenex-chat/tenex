import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentInstance } from "@/agents/types";
import { NDKKind } from "@/nostr/kinds";
import { createMockNDKEvent } from "@/test-utils/bun-mocks"; // Keep for AgentEventDecoder tests
import {
    TENEXTestFixture,
    type TestUserName,
    createMockAgentConfig,
    getTestUserWithSigner,
} from "@/test-utils/ndk-test-helpers";
import { NDKEvent, type NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { AgentEventDecoder } from "../AgentEventDecoder";
import {
    AgentEventEncoder,
    type AskIntent,
    type CompletionIntent,
    type ConversationIntent,
    type DelegationIntent,
    type EventContext,
} from "../AgentEventEncoder";

// Mock the modules
mock.module("@/nostr/ndkClient", () => ({
    getNDK: mock(() => ({
        // Mock NDK instance
    })),
}));

mock.module("@/services", () => ({
    getProjectContext: mock(),
}));

mock.module("nostr-tools", () => ({
    nip19: {
        npubEncode: mock((pubkey: string) => `npub_${pubkey.substring(0, 8)}`),
    },
}));

import { getNDK } from "@/nostr/ndkClient";
import { getProjectContext } from "@/services";

describe("AgentEventEncoder", () => {
    let encoder: AgentEventEncoder;
    let mockConversationCoordinator: any;

    beforeEach(() => {
        // Setup default mock for getProjectContext
        const defaultProjectContext = {
            project: {
                pubkey: "defaultOwner",
                tagReference: () => ["a", "31933:defaultOwner:default-project"],
            },
        };
        (getProjectContext as ReturnType<typeof mock>).mockReturnValue(defaultProjectContext);

        // Create mock ConversationCoordinator
        mockConversationCoordinator = {
            getConversation: mock(() => ({
                history: [mockConversationEvent, mockTriggeringEvent],
            })),
        };

        // Create AgentEventEncoder instance
        encoder = new AgentEventEncoder(mockConversationCoordinator);
    });

    const mockAgent: AgentInstance = {
        name: "TestAgent",
        pubkey: "agent123",
        slug: "test-agent",
        signer: {} as NDKPrivateKeySigner,
        llmConfig: "test-config",
        tools: [],
        role: "test",
        createMetadataStore: mock(() => ({})),
    };

    const mockTriggeringEvent = createMockNDKEvent();
    mockTriggeringEvent.id = "trigger123";
    mockTriggeringEvent.tags = [
        ["e", "root123", "", "root"],
        ["e", "reply123", "", "reply"],
    ];

    const mockConversationEvent = createMockNDKEvent();
    mockConversationEvent.id = "conv123";
    mockConversationEvent.content = "Initial conversation";
    mockConversationEvent.kind = NDKKind.Text;
    mockConversationEvent.pubkey = "user123";

    const baseContext: EventContext = {
        triggeringEvent: mockTriggeringEvent,
        rootEvent: mockConversationEvent,
        conversationId: "conv123",
    };

    describe("encodeCompletion", () => {
        it("should encode a basic completion intent", () => {
            const intent: CompletionIntent = {
                content: "Task completed successfully",
            };

            const event = encoder.encodeCompletion(intent, baseContext);

            expect(event.kind).toBe(NDKKind.GenericReply);
            expect(event.content).toBe("Task completed successfully");

            // Check conversation tags are added
            const eTags = event.getMatchingTags("e");
            expect(eTags).toHaveLength(1);
            expect(eTags[0]).toEqual(["e", "trigger123", "", "reply"]); // References the triggering event
        });

        it("should include optional completion metadata", () => {
            const intent: CompletionIntent = {
                content: "Analysis complete",
                summary: "Found 3 issues",
            };

            const event = encoder.encodeCompletion(intent, baseContext);

            expect(event.tagValue("summary")).toBe("Found 3 issues");
        });

        it("should include execution metadata when provided", () => {
            const contextWithMetadata: EventContext = {
                ...baseContext,
                model: "gpt-4",
                executionTime: 1500,
            };

            const intent: CompletionIntent = {
                content: "Done",
                usage: {
                    inputTokens: 100,
                    outputTokens: 50,
                    totalTokens: 150,
                },
            };

            const event = encoder.encodeCompletion(intent, contextWithMetadata);

            expect(event.tagValue("llm-model")).toBe("gpt-4");
            expect(event.tagValue("execution-time")).toBe("1500");
            expect(event.tagValue("llm-prompt-tokens")).toBe("100");
            expect(event.tagValue("llm-completion-tokens")).toBe("50");
            expect(event.tagValue("llm-total-tokens")).toBe("150");
        });

        it("should include phase information when provided", () => {
            const contextWithPhase: EventContext = {
                ...baseContext,
                phase: "implementation",
            };

            const intent: CompletionIntent = {
                content: "Implementation completed",
            };

            const event = encoder.encodeCompletion(intent, contextWithPhase);

            expect(event.tagValue("phase")).toBe("implementation");
        });
    });

    describe("encodeDelegation", () => {
        beforeEach(() => {
            // Setup mock agent registry for delegation tests
            const mockArchitect: Partial<AgentInstance> = {
                slug: "architect",
                name: "Architect",
                pubkey: "architect123",
            };

            const mockDeveloper: Partial<AgentInstance> = {
                slug: "developer",
                name: "Developer",
                pubkey: "developer456",
            };

            const mockAgentRegistry = {
                getAgentByPubkey: mock((pubkey: string) => {
                    if (pubkey === "architect123") return mockArchitect;
                    if (pubkey === "developer456") return mockDeveloper;
                    return undefined;
                }),
            };

            const projectContext = {
                project: {
                    pubkey: "defaultOwner",
                    tagReference: () => ["a", "31933:defaultOwner:default-project"],
                },
                agentRegistry: mockAgentRegistry,
            };

            (getProjectContext as ReturnType<typeof mock>).mockReturnValue(projectContext);
        });

        it("should prepend agent slugs for known agents", () => {
            const intent: DelegationIntent = {
                recipients: ["architect123", "developer456"],
                request: "Please review the authentication module",
            };

            const tasks = encoder.encodeDelegation(intent, baseContext);

            expect(tasks).toHaveLength(1);
            expect(tasks[0].kind).toBe(1111);
            expect(tasks[0].content).toBe(
                "@architect, @developer: Please review the authentication module"
            );

            // Check both recipients are tagged
            const pTags = tasks[0].getMatchingTags("p");
            expect(pTags).toHaveLength(2);
            expect(pTags[0][1]).toBe("architect123");
            expect(pTags[1][1]).toBe("developer456");
        });

        it("should prepend npub for unknown agents", () => {
            const intent: DelegationIntent = {
                recipients: ["unknownpubkey789"],
                request: "Please review this code",
            };

            const tasks = encoder.encodeDelegation(intent, baseContext);

            expect(tasks).toHaveLength(1);
            expect(tasks[0].content).toBe("nostr:npub_unknownp: Please review this code");
        });

        it("should handle mixed known and unknown agents", () => {
            const intent: DelegationIntent = {
                recipients: ["architect123", "unknownpubkey789"],
                request: "Collaborate on this task",
            };

            const tasks = encoder.encodeDelegation(intent, baseContext);

            expect(tasks).toHaveLength(1);
            expect(tasks[0].content).toBe(
                "@architect, nostr:npub_unknownp: Collaborate on this task"
            );
        });

        it("should not prepend if content already starts with nostr:", () => {
            const intent: DelegationIntent = {
                recipients: ["architect123"],
                request: "nostr:npub123: Already formatted message",
            };

            const tasks = encoder.encodeDelegation(intent, baseContext);

            expect(tasks).toHaveLength(1);
            expect(tasks[0].content).toBe("nostr:npub123: Already formatted message");
        });

        it("should not prepend if content already starts with @slug:", () => {
            const intent: DelegationIntent = {
                recipients: ["architect123"],
                request: "@architect: Already formatted message",
            };

            const tasks = encoder.encodeDelegation(intent, baseContext);

            expect(tasks).toHaveLength(1);
            expect(tasks[0].content).toBe("@architect: Already formatted message");
        });

        it("should include phase information when provided", () => {
            const contextWithPhase: EventContext = {
                ...baseContext,
                phase: "implementation",
            };

            const intent: DelegationIntent = {
                recipients: ["reviewer"],
                title: "Phase 2 Review",
                request: "Review implementation",
            };

            const tasks = encoder.encodeDelegation(intent, contextWithPhase);

            expect(tasks[0].tagValue("phase")).toBe("implementation");
        });

        it("should link to triggering event", () => {
            const intent: DelegationIntent = {
                recipients: ["agent456"],
                title: "Task",
                request: "Do something",
            };

            const tasks = encoder.encodeDelegation(intent, baseContext);

            const eTags = tasks[0].getMatchingTags("e");
            expect(eTags).toHaveLength(1);
            expect(eTags[0]).toEqual(["e", "trigger123"]); // References triggering event
        });
    });

    describe("encodeConversation", () => {
        it("should create a simple response without completion semantics", () => {
            const intent: ConversationIntent = {
                content: "I'm still working on this...",
            };

            const event = encoder.encodeConversation(intent, baseContext);

            expect(event.kind).toBe(NDKKind.GenericReply);
            expect(event.content).toBe("I'm still working on this...");

            // Check conversation tags
            const eTags = event.getMatchingTags("e");
            expect(eTags).toHaveLength(1); // Only triggering event tag
            expect(eTags[0]).toEqual(["e", "trigger123"]); // References triggering event
        });
    });

    describe("encodeAsk", () => {
        it("should encode an ask intent with open-ended question", () => {
            const intent: AskIntent = {
                content: "What approach should I take for implementing this feature?",
            };

            const event = encoder.encodeAsk(intent, baseContext);

            expect(event.kind).toBe(1111);
            expect(event.content).toBe(
                "What approach should I take for implementing this feature?"
            );

            // Check for project owner p-tag
            const pTags = event.getMatchingTags("p");
            expect(pTags).toHaveLength(1);
            expect(pTags[0]).toEqual(["p", "defaultOwner"]);

            // Check for intent tag
            const intentTags = event.getMatchingTags("intent");
            expect(intentTags).toHaveLength(1);
            expect(intentTags[0]).toEqual(["intent", "ask"]);

            // Should not have suggestion tags for open-ended
            const suggestionTags = event.getMatchingTags("suggestion");
            expect(suggestionTags).toHaveLength(0);
        });

        it("should encode an ask intent with yes/no question", () => {
            const intent: AskIntent = {
                content: "Should I proceed with this implementation?",
                suggestions: ["Yes", "No"],
            };

            const event = encoder.encodeAsk(intent, baseContext);

            expect(event.kind).toBe(1111);
            expect(event.content).toBe("Should I proceed with this implementation?");

            // Check for suggestion tags
            const suggestionTags = event.getMatchingTags("suggestion");
            expect(suggestionTags).toHaveLength(2);
            expect(suggestionTags).toContainEqual(["suggestion", "Yes"]);
            expect(suggestionTags).toContainEqual(["suggestion", "No"]);
        });

        it("should encode an ask intent with multiple choice", () => {
            const intent: AskIntent = {
                content: "Which database should we use?",
                suggestions: ["PostgreSQL", "MongoDB", "Redis", "SQLite"],
            };

            const event = encoder.encodeAsk(intent, baseContext);

            expect(event.kind).toBe(1111);
            expect(event.content).toBe("Which database should we use?");

            // Check for all suggestion tags
            const suggestionTags = event.getMatchingTags("suggestion");
            expect(suggestionTags).toHaveLength(4);
            expect(suggestionTags).toContainEqual(["suggestion", "PostgreSQL"]);
            expect(suggestionTags).toContainEqual(["suggestion", "MongoDB"]);
            expect(suggestionTags).toContainEqual(["suggestion", "Redis"]);
            expect(suggestionTags).toContainEqual(["suggestion", "SQLite"]);
        });

        it("should include conversation threading tags", () => {
            const intent: AskIntent = {
                content: "Test question",
            };

            const event = encoder.encodeAsk(intent, baseContext);

            // Check conversation tags (E, K, P for root)
            const ETags = event.getMatchingTags("E");
            expect(ETags).toHaveLength(1);
            expect(ETags[0]).toEqual(["E", "conv123"]);

            const KTags = event.getMatchingTags("K");
            expect(KTags).toHaveLength(1);
            expect(KTags[0]).toEqual(["K", NDKKind.Text.toString()]);

            const PTags = event.getMatchingTags("P");
            expect(PTags).toHaveLength(1);
            expect(PTags[0]).toEqual(["P", "user123"]);

            // Check e-tag for triggering event
            const eTags = event.getMatchingTags("e");
            expect(eTags).toHaveLength(1);
            expect(eTags[0]).toEqual(["e", "trigger123"]);
        });
    });
});

describe("AgentEventDecoder", () => {
    // These tests use simple mocks since they only test static utility functions
    describe("isTaskCompletionEvent", () => {
        it("should not identify events with only status tag as task completions", () => {
            const event = createMockNDKEvent();
            event.tags = [["status", "complete"]];

            expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(false);
        });

        it("should identify task completion by K and P tags matching", () => {
            const event = createMockNDKEvent();
            event.tags = [
                ["K", "1934"],
                ["P", "agent123"],
                ["p", "agent123"],
            ];

            expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(true);
        });

        it("should not identify regular events as task completions", () => {
            const event = createMockNDKEvent();
            event.tags = [["e", "event123", "", "reply"]];

            expect(AgentEventDecoder.isTaskCompletionEvent(event)).toBe(false);
        });
    });

    describe("getConversationRoot", () => {
        it("should extract conversation root from E tag", () => {
            const event = createMockNDKEvent();
            event.tags = [["E", "root123"]];

            expect(AgentEventDecoder.getConversationRoot(event)).toBe("root123");
        });

        it("should extract conversation root from A tag if no E tag", () => {
            const event = createMockNDKEvent();
            event.tags = [["A", "31933:pubkey:project"]];

            expect(AgentEventDecoder.getConversationRoot(event)).toBe("31933:pubkey:project");
        });
    });

    describe("isDirectedToSystem", () => {
        it("should identify events directed to system agents", () => {
            const systemAgents = new Map([
                ["agent1", { pubkey: "agent123" } as any],
                ["agent2", { pubkey: "agent456" } as any],
            ]);

            const event = createMockNDKEvent();
            event.tags = [["p", "agent123"]];

            expect(AgentEventDecoder.isDirectedToSystem(event, systemAgents)).toBe(true);
        });

        it("should not identify events without system agent mentions", () => {
            const systemAgents = new Map([["agent1", { pubkey: "agent123" } as any]]);

            const event = createMockNDKEvent();
            event.tags = [["p", "user789"]];

            expect(AgentEventDecoder.isDirectedToSystem(event, systemAgents)).toBe(false);
        });
    });
});
