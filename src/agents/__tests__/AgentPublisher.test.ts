import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { AgentPublisher } from "../AgentPublisher";
import type { AgentConfig } from "../types";
import { EVENT_KINDS } from "@/llm";
import type NDK from "@nostr-dev-kit/ndk";
import { type NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";

// Mock implementations
const mockNDKEvent = {
    sign: mock(() => Promise.resolve()),
    publish: mock(() => Promise.resolve()),
    tag: mock((event: any) => {}),
    kind: 0,
    pubkey: "",
    content: "",
    tags: [] as string[][],
    ndk: null as any,
};

// Mock the NDKEvent constructor
const mockNDKEventConstructor = mock((ndk: any, data: any) => {
    Object.assign(mockNDKEvent, data, { ndk });
    return mockNDKEvent;
});

// Module mock
mock.module("@nostr-dev-kit/ndk", () => ({
    NDKEvent: mockNDKEventConstructor,
    NDKPrivateKeySigner: class {},
}));

// Mock logger
mock.module("@/utils/logger", () => ({
    logger: {
        info: mock(() => {}),
        error: mock(() => {}),
    },
}));

// Import logger after mocking
import { logger } from "@/utils/logger";

describe("AgentPublisher", () => {
    let agentPublisher: AgentPublisher;
    let mockNDK: NDK;
    let mockSigner: NDKPrivateKeySigner;
    let mockProjectEvent: any;

    beforeEach(() => {
        // Clear all mocks
        mockNDKEventConstructor.mockClear();
        mockNDKEvent.sign.mockClear();
        mockNDKEvent.publish.mockClear();
        mockNDKEvent.tag.mockClear();
        (logger.info as any).mockClear();
        (logger.error as any).mockClear();

        // Reset mock event
        mockNDKEvent.sign.mockResolvedValue(undefined);
        mockNDKEvent.publish.mockResolvedValue(undefined);
        mockNDKEvent.tags = [];

        mockNDK = {} as NDK;
        mockSigner = {
            pubkey: "test-pubkey-123",
        } as NDKPrivateKeySigner;

        // Mock project event (kind:31933)
        mockProjectEvent = {
            kind: 31933,
            pubkey: "project-author-pubkey",
            tagValue: mock((tag: string) => {
                if (tag === "title") return "TestProject";
                if (tag === "d") return "test-project-d-tag";
                return null;
            }),
            id: "project-event-id-123",
            encode: mock(() => "31933:project-author-pubkey:test-project-d-tag"),
        };

        agentPublisher = new AgentPublisher(mockNDK);
    });

    describe("publishAgentProfile", () => {
        it("should publish agent profile with correct data", async () => {
            const agentName = "TestAgent";
            const agentRole = "Executor";
            const projectTitle = "TestProject";

            await agentPublisher.publishAgentProfile(
                mockSigner,
                agentName,
                agentRole,
                projectTitle,
                mockProjectEvent
            );

            // Verify NDKEvent was created with correct data
            expect(mockNDKEventConstructor).toHaveBeenCalledWith(mockNDK, {
                kind: 0,
                pubkey: mockSigner.pubkey,
                content: expect.stringContaining(agentName),
                tags: [],
            });

            // Verify project was tagged properly
            expect(mockNDKEvent.tag).toHaveBeenCalledWith(mockProjectEvent);

            // Verify profile content includes all required fields
            const callArgs = mockNDKEventConstructor.mock.calls[0];
            const profileContent = JSON.parse(callArgs[1].content);
            expect(profileContent).toMatchObject({
                name: agentName,
                role: agentRole,
                description: `${agentRole} agent for ${projectTitle}`,
                capabilities: [agentRole.toLowerCase()],
                picture: expect.stringContaining("dicebear.com"),
                project: projectTitle,
            });

            // Verify event was signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledWith(mockSigner);
            expect(mockNDKEvent.publish).toHaveBeenCalled();
        });

        it("should generate consistent avatar URL based on pubkey", async () => {
            await agentPublisher.publishAgentProfile(
                mockSigner,
                "TestAgent",
                "Executor",
                "TestProject",
                mockProjectEvent
            );

            const callArgs = mockNDKEventConstructor.mock.calls[0];
            const profileContent = JSON.parse(callArgs[1].content);
            expect(profileContent.picture).toBe(
                `https://api.dicebear.com/7.x/bottts/svg?seed=${mockSigner.pubkey}`
            );
        });

        it("should throw error when publishing fails", async () => {
            const publishError = new Error("Network error");
            mockNDKEvent.publish.mockRejectedValue(publishError);

            await expect(
                agentPublisher.publishAgentProfile(
                    mockSigner,
                    "TestAgent",
                    "Executor",
                    "TestProject",
                    mockProjectEvent
                )
            ).rejects.toThrow("Network error");

            expect(logger.error).toHaveBeenCalledWith(
                "Failed to publish agent profile",
                expect.objectContaining({
                    error: publishError,
                    agentName: "TestAgent",
                })
            );
        });

        it("should include e-tag for agent definition event when provided", async () => {
            const agentName = "TestAgent";
            const agentRole = "Executor";
            const projectTitle = "TestProject";
            const agentDefinitionEventId = "def-event-id-789";

            // Set up mock to track tags being added
            mockNDKEvent.tags = [];

            await agentPublisher.publishAgentProfile(
                mockSigner,
                agentName,
                agentRole,
                projectTitle,
                mockProjectEvent,
                agentDefinitionEventId
            );

            // Verify project was tagged
            expect(mockNDKEvent.tag).toHaveBeenCalledWith(mockProjectEvent);

            // Verify e-tag was added
            expect(mockNDKEvent.tags).toContainEqual(["e", agentDefinitionEventId, "", "agent-definition"]);

            // Verify event was signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledWith(mockSigner);
            expect(mockNDKEvent.publish).toHaveBeenCalled();
        });
    });

    describe("publishAgentRequest", () => {
        it("should publish agent request without NDKAgentDefinition event", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            const result = await agentPublisher.publishAgentRequest(
                mockSigner,
                agentConfig,
                mockProjectEvent
            );

            // Verify NDKEvent was created
            expect(mockNDKEventConstructor).toHaveBeenCalled();
            const callArgs = mockNDKEventConstructor.mock.calls[0];
            expect(callArgs[0]).toBe(mockNDK);
            expect(callArgs[1].kind).toBe(EVENT_KINDS.AGENT_REQUEST);
            expect(callArgs[1].content).toBe("");

            // Verify project was tagged
            expect(mockNDKEvent.tag).toHaveBeenCalledWith(mockProjectEvent);

            // Verify name tag was added
            expect(mockNDKEvent.tags).toContainEqual(["name", "TestAgent"]);

            // Verify event was signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledWith(mockSigner);
            expect(mockNDKEvent.publish).toHaveBeenCalled();

            // Verify returned event
            expect(result).toBe(mockNDKEvent);
        });

        it("should publish agent request with NDKAgentDefinition event reference", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const ndkAgentEventId = "ndk-agent-event-789";

            // Set up mock to track tags being added
            mockNDKEvent.tags = [["e", ndkAgentEventId, "", "agent-definition"], ["name", "TestAgent"]];

            await agentPublisher.publishAgentRequest(
                mockSigner,
                agentConfig,
                mockProjectEvent,
                ndkAgentEventId
            );

            // Verify project was tagged
            expect(mockNDKEvent.tag).toHaveBeenCalledWith(mockProjectEvent);

            // Verify e-tag was added for NDKAgentDefinition event
            expect(mockNDKEvent.tags).toContainEqual(["e", ndkAgentEventId, "", "agent-definition"]);
            expect(mockNDKEvent.tags).toContainEqual(["name", agentConfig.name]);
        });

        it("should throw error when publishing fails", async () => {
            const publishError = new Error("Publishing failed");
            mockNDKEvent.publish.mockRejectedValue(publishError);

            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            await expect(
                agentPublisher.publishAgentRequest(mockSigner, agentConfig, mockProjectEvent)
            ).rejects.toThrow("Publishing failed");

            expect(logger.error).toHaveBeenCalledWith(
                "Failed to publish agent request",
                expect.objectContaining({
                    error: publishError,
                    agentName: "TestAgent",
                })
            );
        });
    });

    describe("publishAgentCreation", () => {
        it("should publish both profile and request events", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const projectTitle = "TestProject";

            await agentPublisher.publishAgentCreation(
                mockSigner,
                agentConfig,
                projectTitle,
                mockProjectEvent
            );

            // Verify both events were created
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(2);

            // First call should be profile event (kind 0)
            expect(mockNDKEventConstructor.mock.calls[0][1].kind).toBe(0);

            // Second call should be request event
            expect(mockNDKEventConstructor.mock.calls[1][1].kind).toBe(
                EVENT_KINDS.AGENT_REQUEST
            );

            // Verify both were signed and published
            expect(mockNDKEvent.sign).toHaveBeenCalledTimes(2);
            expect(mockNDKEvent.publish).toHaveBeenCalledTimes(2);
        });

        it("should propagate NDKAgentDefinition event ID to request", async () => {
            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };
            const ndkAgentEventId = "ndk-agent-event-789";

            // Set up mock to track tags
            mockNDKEvent.tags = [];

            await agentPublisher.publishAgentCreation(
                mockSigner,
                agentConfig,
                "TestProject",
                mockProjectEvent,
                ndkAgentEventId
            );

            // Both events should have been created
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(2);

            // Both events should tag the project
            expect(mockNDKEvent.tag).toHaveBeenCalledWith(mockProjectEvent);
            expect(mockNDKEvent.tag).toHaveBeenCalledTimes(2);
        });

        it("should handle profile publishing failure", async () => {
            const profileError = new Error("Profile publishing failed");
            mockNDKEvent.publish.mockRejectedValueOnce(profileError);

            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            await expect(
                agentPublisher.publishAgentCreation(
                    mockSigner,
                    agentConfig,
                    "TestProject",
                    mockProjectEvent
                )
            ).rejects.toThrow("Profile publishing failed");

            // Verify request was not attempted after profile failure
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(1);
        });

        it("should handle request publishing failure", async () => {
            const requestError = new Error("Request publishing failed");
            // First publish succeeds, second fails
            mockNDKEvent.publish
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(requestError);

            const agentConfig: Omit<AgentConfig, "nsec"> = {
                name: "TestAgent",
                role: "Executor",
                systemPrompt: "Test prompt",
            };

            await expect(
                agentPublisher.publishAgentCreation(
                    mockSigner,
                    agentConfig,
                    "TestProject",
                    mockProjectEvent
                )
            ).rejects.toThrow("Request publishing failed");

            // Verify both events were attempted
            expect(mockNDKEventConstructor).toHaveBeenCalledTimes(2);
        });
    });
});