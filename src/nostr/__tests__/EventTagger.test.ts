import { describe, it, expect, beforeEach } from "bun:test";
import { EventTagger } from "../EventTagger";
import { NDKEvent, NDKProject } from "@nostr-dev-kit/ndk";
import type { AgentInstance } from "@/agents/types";
import type { Conversation } from "@/conversations/types";
import { PHASES } from "@/conversations/phases";
import type { LLMMetadata } from "@/nostr/types";
import { EXECUTION_TAGS, LLM_TAGS } from "@/nostr/tags";

describe("EventTagger", () => {
    let eventTagger: EventTagger;
    let mockProject: NDKProject;
    let mockAgent: AgentInstance;
    let mockConversation: Conversation;
    let mockEvent: NDKEvent;
    let mockTriggeringEvent: NDKEvent;

    beforeEach(() => {
        // Create mock project
        mockProject = {
            tagReference: () => ["a", "30311:mockpubkey:mockproject"]
        } as NDKProject;

        // Create EventTagger instance
        eventTagger = new EventTagger(mockProject);

        // Create mock agent
        mockAgent = {
            pubkey: "agent-pubkey-123",
            name: "TestAgent",
            slug: "test-agent"
        } as AgentInstance;

        // Create mock conversation
        mockConversation = {
            id: "conversation-id-456",
            phase: PHASES.EXECUTE,
            startTime: Date.now() - 5000,
            phaseHistory: [],
            executionTime: {
                isActive: false,
                totalSeconds: 5,
                currentSessionStart: undefined,
                lastUpdated: Date.now()
            }
        } as Conversation;

        // Create mock event
        mockEvent = new NDKEvent();
        mockEvent.id = "event-id-789";
        mockEvent.tags = [];

        // Create mock triggering event
        mockTriggeringEvent = new NDKEvent();
        mockTriggeringEvent.id = "triggering-event-abc";
        mockTriggeringEvent.pubkey = "triggering-pubkey-def";
        mockTriggeringEvent.content = "This is a test triggering event with some content";
        mockTriggeringEvent.tags = [];
    });

    describe("tagForDelegation", () => {
        it("should add assignee p-tags for single assignee", () => {
            eventTagger.tagForDelegation(mockEvent, {
                assignedTo: "assignee-pubkey-111",
                conversationId: mockConversation.id
            });

            const pTags = mockEvent.tags.filter(tag => tag[0] === "p");
            expect(pTags).toHaveLength(1);
            expect(pTags[0]).toEqual(["p", "assignee-pubkey-111"]);
        });

        it("should add assignee p-tags for multiple assignees", () => {
            eventTagger.tagForDelegation(mockEvent, {
                assignedTo: ["assignee-1", "assignee-2", "assignee-3"],
                conversationId: mockConversation.id
            });

            const pTags = mockEvent.tags.filter(tag => tag[0] === "p");
            expect(pTags).toHaveLength(3);
            expect(pTags).toContainEqual(["p", "assignee-1"]);
            expect(pTags).toContainEqual(["p", "assignee-2"]);
            expect(pTags).toContainEqual(["p", "assignee-3"]);
        });

        it("should reference conversation root", () => {
            eventTagger.tagForDelegation(mockEvent, {
                assignedTo: "assignee-pubkey",
                conversationId: mockConversation.id
            });

            const eTag = mockEvent.tags.find(tag => 
                tag[0] === "e" && tag[3] === "root"
            );
            expect(eTag).toEqual(["e", mockConversation.id, "", "root"]);
        });

        it("should not include unnecessary metadata", () => {
            eventTagger.tagForDelegation(mockEvent, {
                assignedTo: "assignee",
                conversationId: mockConversation.id
            });

            // Should NOT have title, phase, project reference, execution time, etc.
            const titleTag = mockEvent.tags.find(tag => tag[0] === "title");
            const phaseTag = mockEvent.tags.find(tag => tag[0] === "phase");
            const projectTag = mockEvent.tags.find(tag => tag[0] === "a");
            const netTimeTag = mockEvent.tags.find(tag => tag[0] === EXECUTION_TAGS.NET_TIME);
            
            expect(titleTag).toBeUndefined();
            expect(phaseTag).toBeUndefined();
            expect(projectTag).toBeUndefined();
            expect(netTimeTag).toBeUndefined();
        });
    });

    describe("tagForCompletion", () => {
        let mockOriginalTask: NDKEvent;

        beforeEach(() => {
            mockOriginalTask = new NDKEvent();
            mockOriginalTask.id = "original-task-id";
            mockOriginalTask.pubkey = "delegator-pubkey-xyz"; // The delegator is the author
            mockOriginalTask.tags = [];
        });

        it("should reference original task", () => {
            eventTagger.tagForCompletion(mockEvent, {
                originalTaskId: mockOriginalTask.id,
                originalTaskPubkey: mockOriginalTask.pubkey,
                status: "completed"
            });

            const eTag = mockEvent.tags.find(tag => 
                tag[0] === "e" && tag[1] === mockOriginalTask.id && tag[3] === "reply"
            );
            expect(eTag).toEqual(["e", mockOriginalTask.id, "", "reply"]);
        });

        it("should include completion status", () => {
            eventTagger.tagForCompletion(mockEvent, {
                originalTaskId: mockOriginalTask.id,
                originalTaskPubkey: mockOriginalTask.pubkey,
                status: "completed"
            });

            expect(mockEvent.tags).toContainEqual(["status", "completed"]);
        });

        it("should route back to delegator", () => {
            eventTagger.tagForCompletion(mockEvent, {
                originalTaskId: mockOriginalTask.id,
                originalTaskPubkey: mockOriginalTask.pubkey,
                status: "completed"
            });

            expect(mockEvent.tags).toContainEqual(["p", "delegator-pubkey-xyz"]);
        });

        it("should handle failed status", () => {
            eventTagger.tagForCompletion(mockEvent, {
                originalTaskId: mockOriginalTask.id,
                originalTaskPubkey: mockOriginalTask.pubkey,
                status: "failed"
            });

            expect(mockEvent.tags).toContainEqual(["status", "failed"]);
        });

        it("should not include unnecessary metadata", () => {
            eventTagger.tagForCompletion(mockEvent, {
                originalTaskId: mockOriginalTask.id,
                originalTaskPubkey: mockOriginalTask.pubkey,
                status: "completed"
            });

            // Should NOT have completed-by, phase, project reference, execution time, etc.
            const completedByTag = mockEvent.tags.find(tag => tag[0] === "completed-by");
            const phaseTag = mockEvent.tags.find(tag => tag[0] === "phase");
            const projectTag = mockEvent.tags.find(tag => tag[0] === "a");
            const netTimeTag = mockEvent.tags.find(tag => tag[0] === EXECUTION_TAGS.NET_TIME);
            const conversationRootTag = mockEvent.tags.find(tag => 
                tag[0] === "e" && tag[3] === "root"
            );
            
            expect(completedByTag).toBeUndefined();
            expect(phaseTag).toBeUndefined();
            expect(projectTag).toBeUndefined();
            expect(netTimeTag).toBeUndefined();
            expect(conversationRootTag).toBeUndefined();
        });
    });

    describe("tagForConversationResponse", () => {
        it("should maintain thread continuity", () => {
            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            const eTag = mockEvent.tags.find(tag => 
                tag[0] === "e" && tag[1] === mockConversation.id
            );
            expect(eTag).toBeDefined();
        });

        it("should handle E-tag replacement", () => {
            // Add an E-tag to the triggering event
            mockTriggeringEvent.tags = [["E", "replacement-event-id"]];
            mockTriggeringEvent.tagValue = (key: string) => 
                key === "E" ? "replacement-event-id" : undefined;

            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            // Should have replaced e-tag with E-tag value
            const eTags = mockEvent.tags.filter(tag => tag[0] === "e");
            expect(eTags).toHaveLength(1);
            expect(eTags[0]).toEqual(["e", "replacement-event-id"]);
        });

        it("should add triggering event context", () => {
            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            expect(mockEvent.tags).toContainEqual(["triggering-event-id", mockTriggeringEvent.id]);
            expect(mockEvent.tags).toContainEqual([
                "triggering-event-content",
                mockTriggeringEvent.content.substring(0, 50)
            ]);
        });

        it("should propagate voice mode", () => {
            // Add voice mode to triggering event
            mockTriggeringEvent.tags = [["mode", "voice"]];
            mockTriggeringEvent.tagValue = (key: string) => 
                key === "mode" ? "voice" : undefined;

            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            expect(mockEvent.tags).toContainEqual(["mode", "voice"]);
        });

        it("should not propagate voice mode when not present", () => {
            mockTriggeringEvent.tagValue = () => undefined;

            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            const modeTag = mockEvent.tags.find(tag => tag[0] === "mode");
            expect(modeTag).toBeUndefined();
        });

        it("should route to specified recipients", () => {
            const recipients = ["recipient-1", "recipient-2"];

            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent,
                destinationPubkeys: recipients
            });

            const pTags = mockEvent.tags.filter(tag => tag[0] === "p");
            expect(pTags).toHaveLength(2);
            expect(pTags).toContainEqual(["p", "recipient-1"]);
            expect(pTags).toContainEqual(["p", "recipient-2"]);
        });

        it("should default to triggering event author when no recipients specified", () => {
            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            expect(mockEvent.tags).toContainEqual(["p", mockTriggeringEvent.pubkey]);
        });

        it("should include phase tracking", () => {
            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            expect(mockEvent.tags).toContainEqual(["phase", mockConversation.phase]);
        });

        it("should track responding agent", () => {
            eventTagger.tagForConversationResponse(mockEvent, {
                conversation: mockConversation,
                respondingAgent: mockAgent,
                triggeringEvent: mockTriggeringEvent
            });

            expect(mockEvent.tags).toContainEqual(["responding-agent", mockAgent.pubkey]);
        });
    });

    describe("addProjectReference", () => {
        it("should add project reference tag", () => {
            eventTagger.addProjectReference(mockEvent);
            expect(mockEvent.tags).toContainEqual(["a", "30311:mockpubkey:mockproject"]);
        });
    });

    describe("addLLMMetadata", () => {
        it("should add all required LLM metadata", () => {
            const metadata: LLMMetadata = {
                model: "gpt-4",
                cost: 0.00125,
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150
            };

            eventTagger.addLLMMetadata(mockEvent, metadata);

            expect(mockEvent.tags).toContainEqual([LLM_TAGS.MODEL, "gpt-4"]);
            expect(mockEvent.tags).toContainEqual([LLM_TAGS.COST_USD, "0.00125000"]);
            expect(mockEvent.tags).toContainEqual([LLM_TAGS.PROMPT_TOKENS, "100"]);
            expect(mockEvent.tags).toContainEqual([LLM_TAGS.COMPLETION_TOKENS, "50"]);
            expect(mockEvent.tags).toContainEqual([LLM_TAGS.TOTAL_TOKENS, "150"]);
        });

        it("should add optional LLM metadata when present", () => {
            const metadata: LLMMetadata = {
                model: "gpt-4",
                cost: 0.001,
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
                contextWindow: 8192,
                maxCompletionTokens: 4096
            };

            eventTagger.addLLMMetadata(mockEvent, metadata);

            expect(mockEvent.tags).toContainEqual([LLM_TAGS.CONTEXT_WINDOW, "8192"]);
            expect(mockEvent.tags).toContainEqual([LLM_TAGS.MAX_COMPLETION_TOKENS, "4096"]);
        });

        it("should handle undefined metadata gracefully", () => {
            eventTagger.addLLMMetadata(mockEvent, undefined);
            
            const llmTags = mockEvent.tags.filter(tag => 
                tag[0].startsWith("llm-")
            );
            expect(llmTags).toHaveLength(0);
        });
    });
});