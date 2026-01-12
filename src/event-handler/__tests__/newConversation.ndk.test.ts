/**
 * Integration tests for handleNewConversation using NDK test utilities
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    TENEXTestFixture,
    type TestUserName,
    getTestUserWithSigner,
    withTestEnvironment,
} from "@/test-utils/ndk-test-helpers";
import type { NDKEvent } from "@nostr-dev-kit/ndk";
import { NDKKind } from "@nostr-dev-kit/ndk";
import { handleNewConversation } from "../newConversation";

describe("handleNewConversation with NDK utilities", () => {
    let mockAgentRegistry: any;
    let mockConversationCoordinator: any;
    let mockAgentExecutor: any;

    beforeEach(() => {
        // Create mock agent registry
        mockAgentRegistry = {
            getAgentBySlug: mock((slug: string) => ({
                id: `agent-${slug}`,
                name: slug,
                slug,
                systemPrompt: `You are the ${slug} agent`,
                tools: ["analyze"],
            })),
            getDefaultAgent: mock(() => ({
                id: "agent-coordinator",
                name: "coordinator",
                slug: "coordinator",
                systemPrompt: "You are the coordinator agent",
                tools: [],
            })),
        };

        // Create mock conversation manager
        mockConversationCoordinator = {
            createConversation: mock(async (event: NDKEvent) => ({
                id: event.tags.find((tag) => tag[0] === "d")?.[1] || "conversation-123",
                title: "Test Conversation",
                phase: "CHAT",
                history: [event],
                agentStates: new Map(),
                agentTodos: new Map(),
                phaseStartedAt: Date.now(),
                metadata: {},
                executionTime: {
                    totalSeconds: 0,
                    isActive: false,
                    lastUpdated: Date.now(),
                },
            })),
            addMessage: mock(async () => {}),
            updatePhase: mock(async () => {}),
            startCoordinatorTurn: mock(async () => "turn-123"),
            addCompletionToTurn: mock(async () => {}),
        };

        // Create mock agent executor
        mockAgentExecutor = {
            execute: mock(async () => {}),
        };

        // Mock modules
        mock.module("@/services", () => ({
            getProjectContext: () => ({
                agentRegistry: mockAgentRegistry,
                conversationCoordinator: mockConversationCoordinator,
                agents: new Map([
                    [
                        "coordinator",
                        {
                            id: "agent-coordinator",
                            name: "coordinator",
                            slug: "coordinator",
                            pubkey: "coordinator-pubkey",
                            systemPrompt: "You are the coordinator agent",
                            tools: [],
                        },
                    ],
                    [
                        "planner",
                        {
                            id: "agent-planner",
                            name: "planner",
                            slug: "planner",
                            pubkey: "planner-pubkey",
                            systemPrompt: "You are the planner agent",
                            tools: ["analyze"],
                        },
                    ],
                ]),
            }),
        }));

        mock.module("@/agents", () => ({
            AgentExecutor: class {
                constructor() {
                    return mockAgentExecutor;
                }
            },
        }));
    });

    describe("with properly signed events", () => {
        it("should handle new conversation from user", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create properly signed event from user
                const event = await fixture.eventFactory.createSignedTextNote(
                    "Hello, I need help with a task",
                    "alice"
                );
                event.tags.push(["d", "conversation-123"], ["agent", "planner"]);

                await handleNewConversation(event);

                // Verify conversation was created with proper event
                expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(
                    expect.objectContaining({
                        content: "Hello, I need help with a task",
                        pubkey: await fixture.getUser("alice").then((u) => u.pubkey),
                        sig: expect.any(String),
                    })
                );

                // Verify agent executor was called
                expect(mockAgentExecutor.execute).toHaveBeenCalled();
            });
        });

        it("should handle multi-user conversation initiation", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create conversation with multiple participants
                const events = await fixture.createConversationThread(
                    { author: "alice", content: "Let's work on this together" },
                    [
                        { author: "bob", content: "I can help with analysis" },
                        { author: "carol", content: "I'll handle the documentation" },
                    ]
                );

                // Add conversation tags to first event
                events[0].tags.push(["d", "multi-user-conv"], ["agent", "orchestrator"]);

                await handleNewConversation(events[0]);

                // Verify orchestrator was selected for multi-participant conversation
                expect(mockAgentRegistry.getDefaultAgent).toHaveBeenCalled();
                expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(
                    expect.objectContaining({
                        tags: expect.arrayContaining([
                            ["d", "multi-user-conv"],
                            ["agent", "orchestrator"],
                        ]),
                    })
                );
            });
        });

        it("should handle conversation with relay simulation", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create mock relay
                const relay = fixture.createMockRelay("wss://conversation.relay");
                await relay.connect();

                // Create event
                const event = await fixture.eventFactory.createSignedTextNote(
                    "Start a new project",
                    "dave"
                );
                event.tags.push(["d", "project-conv"], ["agent", "planner"], ["relay", relay.url]);

                // Simulate publishing to relay
                await relay.publish(event);

                // Handle the conversation
                await handleNewConversation(event);

                // Verify relay received the event
                expect(relay.messageLog).toContainEqual(
                    expect.objectContaining({
                        direction: "out",
                        message: expect.stringContaining("EVENT"),
                    })
                );

                // Simulate relay broadcasting the event
                await relay.simulateEvent(event);

                // Verify conversation was created
                expect(mockConversationCoordinator.createConversation).toHaveBeenCalled();
            });
        });

        it("should handle delegation to specific agent", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create agent-to-agent delegation
                const delegationEvent = await fixture.createAgentEvent(
                    "alice", // Alice is acting as an agent
                    "Please analyze this data set",
                    NDKKind.Text,
                    [
                        ["d", "analysis-task"],
                        ["agent", "planner"],
                        ["delegation", "true"],
                    ]
                );

                await handleNewConversation(delegationEvent);

                // Verify planner agent was selected
                expect(mockAgentRegistry.getAgentBySlug).toHaveBeenCalledWith("planner");

                // Verify conversation includes delegation metadata
                expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(
                    expect.objectContaining({
                        tags: expect.arrayContaining([["delegation", "true"]]),
                    })
                );
            });
        });

        it("should handle time-sensitive conversations", async () => {
            await withTestEnvironment(async (fixture, timeControl) => {
                const startTime = Date.now();

                // Create urgent request
                const urgentEvent = await fixture.eventFactory.createSignedTextNote(
                    "URGENT: Need this analyzed within 5 minutes",
                    "eve"
                );
                urgentEvent.tags.push(
                    ["d", "urgent-conv"],
                    ["deadline", String(startTime + 300000)], // 5 minutes
                    ["priority", "high"],
                    ["agent", "planner"]
                );

                await handleNewConversation(urgentEvent);

                // Advance time by 2 minutes
                timeControl.advance(120000);

                // Verify conversation was created with deadline
                expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(
                    expect.objectContaining({
                        tags: expect.arrayContaining([["deadline", String(startTime + 300000)]]),
                    })
                );

                // Verify high priority handling
                expect(mockAgentExecutor.execute).toHaveBeenCalled();
            });
        });

        it("should validate event signatures", async () => {
            await withTestEnvironment(async (fixture) => {
                const { user, signer } = await getTestUserWithSigner("bob", fixture.ndk);

                // Create event with proper signature
                fixture.ndk.signer = signer;
                const signedEvent = await fixture.eventFactory.createSignedTextNote(
                    "Validate my signature",
                    "bob"
                );
                signedEvent.tags.push(["d", "signed-conv"]);

                // Event should have valid signature
                expect(signedEvent.sig).toBeDefined();
                expect(signedEvent.pubkey).toBe(user.pubkey);

                await handleNewConversation(signedEvent);

                // Verify signed event was accepted
                expect(mockConversationCoordinator.createConversation).toHaveBeenCalledWith(
                    expect.objectContaining({
                        sig: signedEvent.sig,
                        pubkey: user.pubkey,
                    })
                );
            });
        });
    });

    describe("error handling", () => {
        it("should handle relay disconnection during conversation creation", async () => {
            await withTestEnvironment(async (fixture) => {
                // Create unstable relay
                const relay = fixture.createMockRelay("wss://unstable.relay", {
                    simulateDisconnect: true,
                    disconnectAfter: 100,
                });

                const event = await fixture.eventFactory.createSignedTextNote(
                    "Start conversation on unstable relay",
                    "alice"
                );
                event.tags.push(["d", "unstable-conv"]);

                // Publish before disconnection
                await relay.publish(event);

                // Wait for disconnect
                await new Promise((resolve) => setTimeout(resolve, 150));

                // Should still handle the conversation even after relay disconnect
                await handleNewConversation(event);

                expect(mockConversationCoordinator.createConversation).toHaveBeenCalled();
                expect(relay.status).toBe(1); // Disconnected
            });
        });
    });
});
